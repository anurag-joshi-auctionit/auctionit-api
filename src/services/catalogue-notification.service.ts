import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { formatDate } from "@auctionit/lib/date";
import { AuctionsValidationMessages } from "@auctionit/messages/auctions";
import { db } from "../db/index.js";
import {
  auctionCatalogueNotifications,
  type CatalogueNotificationType,
} from "../db/schema/auction-catalogue-notifications.js";
import {
  auctionLotItems,
  auctionLots,
} from "../db/schema/auction-lots.js";
import { auctions } from "../db/schema/auctions.js";
import {
  AUCTION_DOCUMENT_TYPE_CATALOGUE,
  auctionDocuments,
} from "../db/schema/auction-documents.js";
import { bidders } from "../db/schema/bidders.js";
import { clients } from "../db/schema/clients.js";
import { items } from "../db/schema/items.js";
import {
  EMAIL_SOURCE_TYPE_AUCTION_CATALOGUE_NOTIFICATION,
} from "../db/schema/notification-email-logs.js";
import { NOTIFICATION_TYPE_CATALOGUE_NOTIFICATION } from "../db/schema/notification-types.js";
import { plantLocations } from "../db/schema/plant-locations.js";
import { users } from "../db/schema/users.js";
import { blockedBidderIdsForClient } from "../lib/bidders/blocked-for-client.js";
import {
  buildCatalogueNotificationHtml,
  buildCatalogueNotificationSubject,
} from "../lib/auctions/catalogue-notification-email-template.js";
import type { SendCatalogueNotificationBody } from "../lib/auctions/schemas.js";
import {
  AuctionNotFoundError,
  AuctionValidationError,
} from "./auctions-errors.js";
import { pgActiveCatalogueDownloadUrl } from "./auctions-pg.service.js";
import {
  enqueueEmails,
  type EnqueueEmailInput,
} from "./email-dispatch.service.js";

export type CatalogueEligibleBidder = {
  bidderId: number;
  companyName: string;
  contactEmail: string;
};

export type CatalogueNotificationPreview = {
  clientName: string;
  auctionNumber: string;
  auctionDate: string;
  plantLocationsSummary: string;
  catalogueUploaded: boolean;
  catalogueUrl: string | null;
  lastTriggeredAt: string | null;
  eligibleBidders: CatalogueEligibleBidder[];
};

export type CatalogueNotificationHistoryRow = {
  id: number;
  triggeredAt: string;
  catalogueType: CatalogueNotificationType;
  materialsSummary: string;
  plantLocationsSummary: string;
  sentByName: string | null;
  recipientCount: number;
};

type AuctionContext = {
  auctionId: number;
  clientId: number;
  clientName: string;
  auctionNumber: string | null;
  auctionDate: string;
  status: string;
};

function displayAuctionNumber(
  auctionNumber: string | null | undefined,
  auctionId: number,
): string {
  const trimmed = auctionNumber?.trim();
  return trimmed || String(auctionId);
}

async function loadAuctionContext(auctionId: number): Promise<AuctionContext> {
  const [row] = await db
    .select({
      auctionId: auctions.id,
      clientId: auctions.clientId,
      clientName: clients.companyName,
      auctionNumber: auctions.auctionNumber,
      auctionDate: auctions.auctionDate,
      status: auctions.status,
    })
    .from(auctions)
    .innerJoin(clients, eq(clients.id, auctions.clientId))
    .where(eq(auctions.id, auctionId))
    .limit(1);
  if (!row) throw new AuctionNotFoundError();
  return row;
}

function assertPublished(ctx: AuctionContext): void {
  if (ctx.status !== "published") {
    throw new AuctionValidationError(
      AuctionsValidationMessages.CATALOGUE_NOTIFY_REQUIRES_PUBLISHED,
    );
  }
}

/** Preview is browseable for published and closed (execution read-only). */
function assertPublishedOrClosed(ctx: AuctionContext): void {
  if (ctx.status !== "published" && ctx.status !== "closed") {
    throw new AuctionValidationError(
      AuctionsValidationMessages.CATALOGUE_NOTIFY_REQUIRES_PUBLISHED,
    );
  }
}

async function hasActiveCatalogue(auctionId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: auctionDocuments.id })
    .from(auctionDocuments)
    .where(
      and(
        eq(auctionDocuments.auctionId, auctionId),
        eq(auctionDocuments.documentTypeId, AUCTION_DOCUMENT_TYPE_CATALOGUE),
        eq(auctionDocuments.isActive, true),
      ),
    )
    .limit(1);
  return row != null;
}

async function loadAuctionMaterialIds(auctionId: number): Promise<number[]> {
  const rows = await db
    .selectDistinct({ materialId: items.materialId })
    .from(auctionLotItems)
    .innerJoin(auctionLots, eq(auctionLots.id, auctionLotItems.lotId))
    .innerJoin(items, eq(items.id, auctionLotItems.itemId))
    .where(
      and(
        eq(auctionLots.auctionId, auctionId),
        eq(auctionLots.isActive, true),
        isNotNull(items.materialId),
      ),
    );
  return rows
    .map((r) => r.materialId)
    .filter((id): id is number => id != null && Number.isInteger(id));
}

async function loadPlantLocationsSummary(auctionId: number): Promise<string> {
  const rows = await db
    .selectDistinct({ name: plantLocations.name })
    .from(auctionLots)
    .innerJoin(
      plantLocations,
      eq(plantLocations.id, auctionLots.plantLocationId),
    )
    .where(
      and(
        eq(auctionLots.auctionId, auctionId),
        eq(auctionLots.isActive, true),
        isNotNull(plantLocations.name),
        sql`trim(${plantLocations.name}) <> ''`,
      ),
    )
    .orderBy(plantLocations.name);
  return rows
    .map((r) => r.name?.trim())
    .filter((n): n is string => Boolean(n))
    .join(", ");
}

/**
 * Eligible = verified + active + contactable + materials overlap + not blocked
 * for this client.
 */
export async function loadEligibleCatalogueBidders(
  auctionId: number,
  clientId: number,
): Promise<CatalogueEligibleBidder[]> {
  const materialIds = await loadAuctionMaterialIds(auctionId);
  if (materialIds.length === 0) return [];

  const materialArraySql = sql`ARRAY[${sql.join(
    materialIds.map((id) => sql`${id}`),
    sql`, `,
  )}]::int[]`;

  const candidates = await db
    .select({
      bidderId: bidders.id,
      companyName: bidders.companyName,
      contactEmail: users.emailId,
    })
    .from(bidders)
    .innerJoin(
      users,
      and(eq(users.bidderId, bidders.id), eq(users.isActive, true)),
    )
    .where(
      and(
        eq(bidders.isActive, true),
        eq(bidders.isVerified, true),
        isNotNull(users.emailId),
        sql`trim(${users.emailId}) <> ''`,
        sql`${bidders.materials} && ${materialArraySql}`,
      ),
    )
    .orderBy(bidders.companyName);

  if (candidates.length === 0) return [];

  const blocked = await blockedBidderIdsForClient(
    clientId,
    candidates.map((c) => c.bidderId),
  );

  return candidates
    .filter((c) => !blocked.has(c.bidderId))
    .map((c) => ({
      bidderId: c.bidderId,
      companyName: c.companyName,
      contactEmail: (c.contactEmail ?? "").trim(),
    }))
    .filter((c) => c.contactEmail.length > 0);
}

async function lastTriggeredAt(auctionId: number): Promise<string | null> {
  const [row] = await db
    .select({ triggeredAt: auctionCatalogueNotifications.triggeredAt })
    .from(auctionCatalogueNotifications)
    .where(eq(auctionCatalogueNotifications.auctionId, auctionId))
    .orderBy(desc(auctionCatalogueNotifications.triggeredAt))
    .limit(1);
  return row?.triggeredAt ?? null;
}

export async function previewCatalogueNotification(
  auctionId: number,
): Promise<CatalogueNotificationPreview> {
  const ctx = await loadAuctionContext(auctionId);
  assertPublishedOrClosed(ctx);

  const [
    plantLocationsSummary,
    eligibleBidders,
    catalogueUploaded,
    lastAt,
    catalogueUrl,
  ] = await Promise.all([
    loadPlantLocationsSummary(auctionId),
    loadEligibleCatalogueBidders(auctionId, ctx.clientId),
    hasActiveCatalogue(auctionId),
    lastTriggeredAt(auctionId),
    pgActiveCatalogueDownloadUrl(auctionId),
  ]);

  return {
    clientName: ctx.clientName,
    auctionNumber: displayAuctionNumber(ctx.auctionNumber, auctionId),
    auctionDate: formatDate(ctx.auctionDate),
    plantLocationsSummary,
    catalogueUploaded,
    catalogueUrl: catalogueUploaded ? catalogueUrl : null,
    lastTriggeredAt: lastAt,
    eligibleBidders,
  };
}

export async function listCatalogueNotificationHistory(
  auctionId: number,
): Promise<CatalogueNotificationHistoryRow[]> {
  await loadAuctionContext(auctionId);

  const rows = await db
    .select({
      id: auctionCatalogueNotifications.id,
      triggeredAt: auctionCatalogueNotifications.triggeredAt,
      catalogueType: auctionCatalogueNotifications.catalogueType,
      materialsSummary: auctionCatalogueNotifications.materialsSummary,
      plantLocationsSummary: auctionCatalogueNotifications.plantLocationsSummary,
      sentByName: users.name,
      recipientCount: auctionCatalogueNotifications.recipientCount,
    })
    .from(auctionCatalogueNotifications)
    .leftJoin(users, eq(users.id, auctionCatalogueNotifications.sentBy))
    .where(eq(auctionCatalogueNotifications.auctionId, auctionId))
    .orderBy(desc(auctionCatalogueNotifications.triggeredAt));

  return rows.map((r) => ({
    id: r.id,
    triggeredAt: r.triggeredAt,
    catalogueType: r.catalogueType,
    materialsSummary: r.materialsSummary,
    plantLocationsSummary: r.plantLocationsSummary,
    sentByName: r.sentByName ?? null,
    recipientCount: r.recipientCount,
  }));
}

export async function sendCatalogueNotification(
  auctionId: number,
  input: SendCatalogueNotificationBody,
  userId: number,
): Promise<{ recipientCount: number }> {
  const ctx = await loadAuctionContext(auctionId);
  assertPublished(ctx);

  if (!(await hasActiveCatalogue(auctionId))) {
    throw new AuctionValidationError(
      AuctionsValidationMessages.CATALOGUE_NOTIFY_REQUIRES_CATALOGUE,
    );
  }

  if (input.catalogueType === "revised") {
    const reason = input.reasonForRevision?.trim() ?? "";
    if (!reason) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.REASON_FOR_REVISION_REQUIRED,
        {
          reasonForRevision: [
            AuctionsValidationMessages.REASON_FOR_REVISION_REQUIRED,
          ],
        },
      );
    }
  }

  const eligible = await loadEligibleCatalogueBidders(auctionId, ctx.clientId);
  if (eligible.length === 0) {
    throw new AuctionValidationError(
      AuctionsValidationMessages.CATALOGUE_NOTIFY_NO_ELIGIBLE_BIDDERS,
    );
  }

  const requestedIds = input.bidderIds ?? [];
  const selected =
    requestedIds.length === 0
      ? eligible
      : (() => {
          const eligibleById = new Map(eligible.map((b) => [b.bidderId, b]));
          return requestedIds
            .map((id) => eligibleById.get(id))
            .filter((b): b is CatalogueEligibleBidder => b != null);
        })();

  // Deduplicate by email so one address does not get multiple copies.
  const seenEmails = new Set<string>();
  const recipients: CatalogueEligibleBidder[] = [];
  for (const bidder of selected) {
    const key = bidder.contactEmail.toLowerCase();
    if (seenEmails.has(key)) continue;
    seenEmails.add(key);
    recipients.push(bidder);
  }

  if (recipients.length === 0) {
    throw new AuctionValidationError(
      AuctionsValidationMessages.CATALOGUE_NOTIFY_NO_ELIGIBLE_BIDDERS,
    );
  }

  const plantLocationsSummary = await loadPlantLocationsSummary(auctionId);
  const auctionNumber = displayAuctionNumber(ctx.auctionNumber, auctionId);
  const auctionDate = formatDate(ctx.auctionDate);
  const materialsSummary = input.materialsSummary.trim();
  const additionalInfo = input.additionalInfo?.trim() || null;
  const reasonForRevision =
    input.catalogueType === "revised"
      ? input.reasonForRevision?.trim() || null
      : null;
  const kamContact = input.kamContact?.trim() || null;
  const catalogueUrl = await pgActiveCatalogueDownloadUrl(auctionId);
  if (!catalogueUrl) {
    throw new AuctionValidationError(
      AuctionsValidationMessages.CATALOGUE_NOTIFY_REQUIRES_CATALOGUE,
    );
  }

  const templateVars = {
    catalogueType: input.catalogueType,
    clientName: ctx.clientName,
    plantLocationsSummary,
    materialsSummary,
    auctionNumber,
    auctionDate,
    catalogueUrl,
    additionalInfo,
    reasonForRevision,
    kamContact,
  };
  const subject = buildCatalogueNotificationSubject(templateVars);
  const emailBody = buildCatalogueNotificationHtml(templateVars);

  const [header] = await db
    .insert(auctionCatalogueNotifications)
    .values({
      auctionId,
      clientId: ctx.clientId,
      catalogueType: input.catalogueType,
      materialsSummary,
      additionalInfo,
      reasonForRevision,
      kamContact,
      plantLocationsSummary,
      subject,
      emailBody,
      recipientCount: recipients.length,
      sentBy: userId,
    })
    .returning({ id: auctionCatalogueNotifications.id });

  if (!header) {
    throw new Error("Failed to insert catalogue notification header");
  }

  const inputs: EnqueueEmailInput[] = recipients.map((bidder) => ({
    notificationId: NOTIFICATION_TYPE_CATALOGUE_NOTIFICATION,
    emailTo: bidder.contactEmail,
    emailBody,
    subject,
    auctionId,
    requiresAttachment: false,
    sourceType: EMAIL_SOURCE_TYPE_AUCTION_CATALOGUE_NOTIFICATION,
    sourceId: header.id,
    enqueuedBy: userId,
  }));

  await enqueueEmails(inputs);

  return { recipientCount: recipients.length };
}
