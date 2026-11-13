import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { formatDate, formatTimeOfDay } from "@auctionit/lib/date";
import { db } from "../db/index.js";
import { auctionLotBidderMaps } from "../db/schema/auction-lot-bidder-maps.js";
import { auctionLots } from "../db/schema/auction-lots.js";
import { auctions } from "../db/schema/auctions.js";
import { bidders } from "../db/schema/bidders.js";
import { users } from "../db/schema/users.js";
import {
  EMAIL_SOURCE_TYPE_AUCTION,
  notificationEmailLogs,
} from "../db/schema/notification-email-logs.js";
import {
  NOTIFICATION_TYPE_AUCTION_ABOUT_TO_START,
  NOTIFICATION_TYPE_AUCTION_CONCLUDED,
} from "../db/schema/notification-types.js";
import { env } from "../env.js";
import {
  buildAuctionAboutToStartHtml,
  buildAuctionAboutToStartSubject,
} from "../lib/auctions/auction-about-to-start-email-template.js";
import {
  buildAuctionConcludedHtml,
  buildAuctionConcludedSubject,
} from "../lib/auctions/auction-concluded-email-template.js";
import {
  enqueueEmails,
  type EnqueueEmailInput,
} from "./email-dispatch.service.js";

/** Minutes before earliest lot start to enqueue NotificationId 3. */
export const AUCTION_ABOUT_TO_START_MINUTES = 60;

const DEDUPE_STATUSES = ["queued", "sending", "sent"] as const;

type AboutToStartCandidate = {
  auctionId: number;
  auctionNumber: string | null;
  auctionDate: string;
  earliestStartTime: string;
};

type AuctionRow = {
  auctionId: number;
  auctionNumber: string | null;
  auctionDate: string;
};

type MappedBidder = {
  auctionId: number;
  bidderId: number;
  companyName: string;
  contactEmail: string;
};

export function isWithinAboutToStartWindow(
  earliestStart: Date,
  now: Date,
  leadMinutes: number = AUCTION_ABOUT_TO_START_MINUTES,
): boolean {
  const startMs = earliestStart.getTime();
  const nowMs = now.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs)) return false;
  const leadMs = leadMinutes * 60 * 1000;
  return nowMs >= startMs - leadMs && nowMs < startMs;
}

export function auctionEmailDedupeKey(
  auctionId: number,
  emailTo: string,
): string {
  return `${auctionId}:${emailTo.trim().toLowerCase()}`;
}

export function bidderAppLoginUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function displayAuctionNumber(
  auctionNumber: string | null | undefined,
  auctionId: number,
): string {
  const trimmed = auctionNumber?.trim();
  return trimmed || String(auctionId);
}

async function loadAboutToStartCandidates(
  now: Date,
): Promise<AboutToStartCandidate[]> {
  const nowIso = now.toISOString();
  const earliestStartIst = sql`MIN((${auctions.auctionDate}::date + ${auctionLots.startTime}) AT TIME ZONE 'Asia/Kolkata')`;
  const res = await db.execute<{
    auction_id: number;
    auction_number: string | null;
    auction_date: string;
    earliest_start_time: string;
  }>(sql`
    SELECT
      ${auctions.id} AS auction_id,
      ${auctions.auctionNumber} AS auction_number,
      ${auctions.auctionDate} AS auction_date,
      MIN(${auctionLots.startTime})::text AS earliest_start_time
    FROM ${auctions}
    INNER JOIN ${auctionLots}
      ON ${auctionLots.auctionId} = ${auctions.id}
      AND ${auctionLots.isActive} = true
      AND ${auctionLots.startTime} IS NOT NULL
    WHERE ${auctions.status} = 'published'
      AND ${auctions.isActive} = true
    GROUP BY ${auctions.id}, ${auctions.auctionNumber}, ${auctions.auctionDate}
    HAVING ${earliestStartIst} > CAST(${nowIso} AS timestamptz)
       AND ${earliestStartIst} <= CAST(${nowIso} AS timestamptz)
         + (${AUCTION_ABOUT_TO_START_MINUTES}::int * interval '1 minute')
  `);
  return res.rows.map((row) => ({
    auctionId: Number(row.auction_id),
    auctionNumber: row.auction_number,
    auctionDate: row.auction_date,
    earliestStartTime: row.earliest_start_time,
  }));
}

async function loadAuctionsByIds(auctionIds: number[]): Promise<AuctionRow[]> {
  if (auctionIds.length === 0) return [];
  const rows = await db
    .select({
      auctionId: auctions.id,
      auctionNumber: auctions.auctionNumber,
      auctionDate: auctions.auctionDate,
    })
    .from(auctions)
    .where(inArray(auctions.id, auctionIds));
  return rows;
}

async function loadMappedBidders(
  auctionIds: number[],
): Promise<MappedBidder[]> {
  if (auctionIds.length === 0) return [];
  const rows = await db
    .select({
      auctionId: auctionLotBidderMaps.auctionId,
      bidderId: bidders.id,
      companyName: bidders.companyName,
      contactEmail: users.emailId,
    })
    .from(auctionLotBidderMaps)
    .innerJoin(bidders, eq(bidders.id, auctionLotBidderMaps.bidderId))
    .innerJoin(
      users,
      and(eq(users.bidderId, bidders.id), eq(users.isActive, true)),
    )
    .where(
      and(
        inArray(auctionLotBidderMaps.auctionId, auctionIds),
        eq(auctionLotBidderMaps.isActive, true),
        eq(bidders.isActive, true),
        isNotNull(users.emailId),
        sql`trim(${users.emailId}) <> ''`,
      ),
    );

  const seen = new Set<string>();
  const unique: MappedBidder[] = [];
  for (const row of rows) {
    const email = row.contactEmail?.trim() ?? "";
    if (!email) continue;
    const key = `${row.auctionId}:${row.bidderId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({
      auctionId: row.auctionId,
      bidderId: row.bidderId,
      companyName: row.companyName,
      contactEmail: email,
    });
  }
  return unique;
}

async function alreadySentKeys(
  notificationId: number,
  auctionIds: number[],
): Promise<Set<string>> {
  if (auctionIds.length === 0) return new Set();
  const rows = await db
    .select({
      auctionId: notificationEmailLogs.auctionId,
      emailTo: notificationEmailLogs.emailTo,
    })
    .from(notificationEmailLogs)
    .where(
      and(
        eq(notificationEmailLogs.notificationId, notificationId),
        inArray(notificationEmailLogs.auctionId, auctionIds),
        inArray(notificationEmailLogs.status, [...DEDUPE_STATUSES]),
      ),
    );
  return new Set(
    rows
      .filter(
        (r): r is { auctionId: number; emailTo: string } =>
          r.auctionId != null && Number.isInteger(r.auctionId),
      )
      .map((r) => auctionEmailDedupeKey(r.auctionId, r.emailTo)),
  );
}

function buildAboutToStartInput(
  auction: AboutToStartCandidate,
  bidder: MappedBidder,
  loginUrl: string,
): EnqueueEmailInput | null {
  const emailTo = bidder.contactEmail.trim();
  if (!emailTo) return null;
  const auctionNumber = displayAuctionNumber(
    auction.auctionNumber,
    auction.auctionId,
  );
  const auctionDate = formatDate(auction.auctionDate);
  const startTime = formatTimeOfDay(auction.earliestStartTime);
  const vars = {
    companyName: bidder.companyName,
    auctionNumber,
    startTime,
    auctionDate,
    loginUrl,
  };
  return {
    notificationId: NOTIFICATION_TYPE_AUCTION_ABOUT_TO_START,
    emailTo,
    emailBody: buildAuctionAboutToStartHtml(vars),
    subject: buildAuctionAboutToStartSubject(vars),
    auctionId: auction.auctionId,
    requiresAttachment: false,
    sourceType: EMAIL_SOURCE_TYPE_AUCTION,
    sourceId: auction.auctionId,
    enqueuedBy: null,
  };
}

function buildConcludedInput(
  auction: AuctionRow,
  bidder: MappedBidder,
): EnqueueEmailInput | null {
  const emailTo = bidder.contactEmail.trim();
  if (!emailTo) return null;
  const auctionNumber = displayAuctionNumber(
    auction.auctionNumber,
    auction.auctionId,
  );
  const auctionDate = formatDate(auction.auctionDate);
  const vars = {
    companyName: bidder.companyName,
    auctionNumber,
    auctionDate,
  };
  return {
    notificationId: NOTIFICATION_TYPE_AUCTION_CONCLUDED,
    emailTo,
    emailBody: buildAuctionConcludedHtml(vars),
    subject: buildAuctionConcludedSubject(vars),
    auctionId: auction.auctionId,
    requiresAttachment: false,
    sourceType: EMAIL_SOURCE_TYPE_AUCTION,
    sourceId: auction.auctionId,
    enqueuedBy: null,
  };
}

/**
 * Enqueue NotificationId 3 for published auctions whose earliest lot start
 * is within the next 60 minutes. Once per (auction, recipient) for life.
 */
export async function enqueueAboutToStartNotifications(
  now: Date = new Date(),
): Promise<number> {
  const candidates = await loadAboutToStartCandidates(now);
  if (candidates.length === 0) return 0;

  const auctionIds = candidates.map((c) => c.auctionId);
  const [recipients, sent] = await Promise.all([
    loadMappedBidders(auctionIds),
    alreadySentKeys(NOTIFICATION_TYPE_AUCTION_ABOUT_TO_START, auctionIds),
  ]);

  const byAuction = new Map<number, AboutToStartCandidate>();
  for (const c of candidates) byAuction.set(c.auctionId, c);

  const loginUrl = bidderAppLoginUrl(env.APP_BASE_URL);
  const inputs: EnqueueEmailInput[] = [];
  const queued = new Set<string>();

  for (const bidder of recipients) {
    const auction = byAuction.get(bidder.auctionId);
    if (!auction) continue;
    const input = buildAboutToStartInput(auction, bidder, loginUrl);
    if (!input) continue;
    const key = auctionEmailDedupeKey(auction.auctionId, input.emailTo);
    if (sent.has(key) || queued.has(key)) continue;
    queued.add(key);
    inputs.push(input);
  }

  if (inputs.length === 0) return 0;
  await enqueueEmails(inputs);
  return inputs.length;
}

/**
 * Enqueue NotificationId 5 for auctions just closed. Once per (auction,
 * recipient) for life — reopen / second close does not resend.
 */
export async function enqueueConcludedNotifications(
  auctionIds: number[],
): Promise<number> {
  const ids = [...new Set(auctionIds.filter((id) => Number.isInteger(id)))];
  if (ids.length === 0) return 0;

  const [auctionRows, recipients, sent] = await Promise.all([
    loadAuctionsByIds(ids),
    loadMappedBidders(ids),
    alreadySentKeys(NOTIFICATION_TYPE_AUCTION_CONCLUDED, ids),
  ]);

  const byAuction = new Map<number, AuctionRow>();
  for (const a of auctionRows) byAuction.set(a.auctionId, a);

  const inputs: EnqueueEmailInput[] = [];
  const queued = new Set<string>();

  for (const bidder of recipients) {
    const auction = byAuction.get(bidder.auctionId);
    if (!auction) continue;
    const input = buildConcludedInput(auction, bidder);
    if (!input) continue;
    const key = auctionEmailDedupeKey(auction.auctionId, input.emailTo);
    if (sent.has(key) || queued.has(key)) continue;
    queued.add(key);
    inputs.push(input);
  }

  if (inputs.length === 0) return 0;
  await enqueueEmails(inputs);
  return inputs.length;
}
