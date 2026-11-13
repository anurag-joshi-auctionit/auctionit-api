import { and, eq, inArray, sql } from "drizzle-orm";
import { AuctionsValidationMessages } from "@auctionit/messages/auctions";
import { db } from "../db/index.js";
import { auctionLotConfirmationDocuments } from "../db/schema/auction-lot-confirmation-documents.js";
import { auctionLots } from "../db/schema/auction-lots.js";
import { auctions } from "../db/schema/auctions.js";
import { bidders } from "../db/schema/bidders.js";
import { clients } from "../db/schema/clients.js";
import { locations } from "../db/schema/locations.js";
import {
  EMAIL_SOURCE_TYPE_LOT_CONFIRMATION,
} from "../db/schema/notification-email-logs.js";
import { NOTIFICATION_TYPE_LOT_CONFIRMATION } from "../db/schema/notification-types.js";
import { plantLocations } from "../db/schema/plant-locations.js";
import { uoms } from "../db/schema/uoms.js";
import { users } from "../db/schema/users.js";
import {
  buildLotConfirmationEmailHtml,
  buildLotConfirmationEmailSubject,
  LOT_CONFIRMATION_EMAIL_BCC,
  LOT_CONFIRMATION_EMAIL_CC,
} from "../lib/auctions/lot-confirmation-email-template.js";
import { buildLotConfirmationPdf } from "../lib/auctions/lot-confirmation-pdf.js";
import { LOT_CONFIRMATION_PDF_CONTENT_TYPE } from "../lib/auctions/lot-confirmation-r2-keys.js";
import {
  deleteLotConfirmationPdf,
  persistLotConfirmationPdf,
} from "../lib/auctions/lot-confirmation-r2.js";
import { nextId } from "./_id.js";
import { AuctionNotFoundError, AuctionValidationError } from "./auctions-errors.js";
import { enqueueEmails } from "./email-dispatch.service.js";
import { formatUtcNow } from "@auctionit/lib/date";

function num(value: string | number | null | undefined): number {
  if (value == null || value === "") return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function uniqueEmails(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const email = raw?.trim();
    if (!email || !email.includes("@")) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

export async function winnerBidderIdsForLots(
  auctionId: number,
  lotIds: number[] | "all",
): Promise<number[]> {
  const conditions = [
    eq(auctionLots.auctionId, auctionId),
    eq(auctionLots.isActive, true),
  ];
  if (lotIds !== "all") {
    if (lotIds.length === 0) return [];
    conditions.push(inArray(auctionLots.id, lotIds));
  }
  const rows = await db
    .select({ winnerBidderId: auctionLots.winnerBidderId })
    .from(auctionLots)
    .where(and(...conditions));
  return [
    ...new Set(
      rows
        .map((r) => r.winnerBidderId)
        .filter((id): id is number => id != null && id > 0),
    ),
  ];
}

async function loadAuctionContext(auctionId: number) {
  const [row] = await db
    .select({
      auctionId: auctions.id,
      auctionNumber: auctions.auctionNumber,
      auctionDate: auctions.auctionDate,
      auctionType: auctions.auctionType,
      clientId: auctions.clientId,
      clientName: clients.companyName,
      country: locations.country,
    })
    .from(auctions)
    .innerJoin(clients, eq(clients.id, auctions.clientId))
    .leftJoin(locations, eq(locations.id, clients.locationId))
    .where(eq(auctions.id, auctionId))
    .limit(1);
  return row ?? null;
}

async function loadBidder(bidderId: number) {
  const [row] = await db
    .select({
      id: bidders.id,
      companyName: bidders.companyName,
      address: bidders.address,
      city: bidders.city,
      pincode: bidders.pincode,
      gstin: bidders.gstin,
      pan: bidders.pan,
      userEmail: users.emailId,
      userPhone: users.phoneNumber,
      userActive: users.isActive,
    })
    .from(bidders)
    .leftJoin(users, eq(users.bidderId, bidders.id))
    .where(eq(bidders.id, bidderId))
    .limit(1);
  return row ?? null;
}

async function loadApprovedLots(auctionId: number, bidderId: number) {
  return db
    .select({
      lotId: auctionLots.id,
      lotNumber: auctionLots.lotNumber,
      quantity: auctionLots.quantity,
      winningAmount: auctionLots.winningAmount,
      gstPercentage: auctionLots.gstPercentage,
      tcsPercentage: auctionLots.tcsPercentage,
      materialLiftingDays: auctionLots.materialLiftingDays,
      reviewedAt: auctionLots.reviewedAt,
      uom: uoms.code,
      plantLocationName: plantLocations.name,
      pocName: plantLocations.pocName,
      pocPhone: plantLocations.pocPhone,
      pocEmail: plantLocations.pocEmail,
    })
    .from(auctionLots)
    .leftJoin(uoms, eq(uoms.id, auctionLots.uomId))
    .leftJoin(plantLocations, eq(plantLocations.id, auctionLots.plantLocationId))
    .where(
      and(
        eq(auctionLots.auctionId, auctionId),
        eq(auctionLots.winnerBidderId, bidderId),
        eq(auctionLots.isApproved, true),
        eq(auctionLots.isActive, true),
        sql`coalesce(${auctionLots.winningAmount}::numeric, 0) > 0`,
      ),
    )
    .orderBy(auctionLots.displayOrder, auctionLots.id);
}

async function getDocumentRow(auctionId: number, bidderId: number) {
  const [row] = await db
    .select({
      id: auctionLotConfirmationDocuments.id,
      s3Key: auctionLotConfirmationDocuments.s3Key,
      fileName: auctionLotConfirmationDocuments.fileName,
      isActive: auctionLotConfirmationDocuments.isActive,
    })
    .from(auctionLotConfirmationDocuments)
    .where(
      and(
        eq(auctionLotConfirmationDocuments.auctionId, auctionId),
        eq(auctionLotConfirmationDocuments.bidderId, bidderId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function upsertDocument(opts: {
  auctionId: number;
  bidderId: number;
  fileName: string;
  s3Key: string;
  userId: number;
}): Promise<number> {
  const at = formatUtcNow();
  const existing = await getDocumentRow(opts.auctionId, opts.bidderId);
  if (existing) {
    await db
      .update(auctionLotConfirmationDocuments)
      .set({
        fileName: opts.fileName,
        s3Key: opts.s3Key,
        isActive: true,
        updatedAt: at,
        updatedBy: opts.userId,
      })
      .where(eq(auctionLotConfirmationDocuments.id, existing.id));
    return existing.id;
  }
  const id = await nextId("auction_lot_confirmation_documents", "id");
  await db.insert(auctionLotConfirmationDocuments).values({
    id,
    auctionId: opts.auctionId,
    bidderId: opts.bidderId,
    fileName: opts.fileName,
    s3Key: opts.s3Key,
    isActive: true,
    createdAt: at,
    createdBy: opts.userId,
    updatedAt: null,
    updatedBy: null,
  });
  return id;
}

async function deactivateDocument(
  auctionId: number,
  bidderId: number,
  userId: number,
): Promise<void> {
  const existing = await getDocumentRow(auctionId, bidderId);
  if (!existing) return;
  if (existing.s3Key) await deleteLotConfirmationPdf(existing.s3Key);
  await db
    .update(auctionLotConfirmationDocuments)
    .set({
      isActive: false,
      updatedAt: formatUtcNow(),
      updatedBy: userId,
    })
    .where(eq(auctionLotConfirmationDocuments.id, existing.id));
}

function paymentContacts(
  lots: Array<{
    pocName: string | null;
    pocPhone: string | null;
    plantLocationName: string | null;
  }>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const lot of lots) {
    const name = lot.pocName?.trim() ?? "";
    const phone = lot.pocPhone?.trim() ?? "";
    const plant = lot.plantLocationName?.trim() ?? "";
    if (!name && !phone) continue;
    const label = `${name}${phone ? ` (${phone})` : ""}${plant ? ` For ${plant}` : ""}`.trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

export async function syncLotConfirmationPdf(
  auctionId: number,
  bidderIds: number[],
  userId: number,
): Promise<void> {
  const uniqueBidderIds = [...new Set(bidderIds.filter((id) => id > 0))];
  if (uniqueBidderIds.length === 0) return;

  const auction = await loadAuctionContext(auctionId);
  if (!auction) {
    throw new AuctionNotFoundError();
  }

  const taxLabel: "GST" | "VAT" =
    (auction.country ?? "India").toLowerCase() === "india" ? "GST" : "VAT";

  for (const bidderId of uniqueBidderIds) {
    const lots = await loadApprovedLots(auctionId, bidderId);
    if (lots.length === 0) {
      await deactivateDocument(auctionId, bidderId, userId);
      continue;
    }

    const bidder = await loadBidder(bidderId);
    if (!bidder) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.LOT_CONFIRMATION_WINNER_MISSING,
      );
    }

    const cityPin = [bidder.city, bidder.pincode].filter(Boolean).join(" ");
    const buffer = await buildLotConfirmationPdf({
      auctionType: auction.auctionType,
      auctionNumber: auction.auctionNumber ?? String(auction.auctionId),
      auctionDate: auction.auctionDate,
      clientName: auction.clientName,
      taxLabel,
      bidderCompany: bidder.companyName,
      bidderAddress: bidder.address ?? "",
      bidderCityPin: cityPin,
      bidderEmail:
        (bidder.userActive ? bidder.userEmail : null)?.trim() ||
        bidder.userEmail?.trim() ||
        "",
      bidderPhone:
        (bidder.userActive ? bidder.userPhone : null)?.trim() ||
        bidder.userPhone?.trim() ||
        "",
      bidderPan: bidder.pan ?? "",
      bidderGstin: bidder.gstin ?? "",
      paymentContacts: paymentContacts(lots),
      lots: lots.map((lot) => ({
        lotNumber: lot.lotNumber ?? String(lot.lotId),
        plantLocationName: lot.plantLocationName ?? "",
        reviewedAt: lot.reviewedAt,
        materialLiftingDays: lot.materialLiftingDays,
        quantity: num(lot.quantity),
        uom: lot.uom ?? "",
        winningAmount: num(lot.winningAmount),
        gstPercentage: num(lot.gstPercentage),
        tcsPercentage: num(lot.tcsPercentage),
      })),
    });

    const existing = await getDocumentRow(auctionId, bidderId);
    const stored = await persistLotConfirmationPdf({
      auctionId,
      bidderId,
      buffer,
      previousS3Key: existing?.s3Key,
    });
    await upsertDocument({
      auctionId,
      bidderId,
      fileName: stored.filename,
      s3Key: stored.s3Key,
      userId,
    });
  }
}

export async function notifyLotConfirmationWinners(
  auctionId: number,
  lotIds: number[],
  userId: number,
): Promise<{ emailedBidderCount: number; lotCount: number }> {
  if (lotIds.length === 0) {
    throw new AuctionValidationError(
      AuctionsValidationMessages.LOT_NOTIFY_REQUIRE_SELECTION,
    );
  }

  const uniqueLotIds = [...new Set(lotIds)];
  const lotRows = await db
    .select({
      id: auctionLots.id,
      isApproved: auctionLots.isApproved,
      winnerBidderId: auctionLots.winnerBidderId,
      winningAmount: auctionLots.winningAmount,
      isActive: auctionLots.isActive,
    })
    .from(auctionLots)
    .where(
      and(
        eq(auctionLots.auctionId, auctionId),
        inArray(auctionLots.id, uniqueLotIds),
      ),
    );

  if (lotRows.length !== uniqueLotIds.length) {
    throw new AuctionValidationError(
      AuctionsValidationMessages.LOT_NOTIFY_REQUIRE_APPROVED,
    );
  }

  const invalid = lotRows.some(
    (row) =>
      row.isActive !== true ||
      row.isApproved !== true ||
      row.winnerBidderId == null ||
      row.winningAmount == null,
  );
  if (invalid) {
    throw new AuctionValidationError(
      AuctionsValidationMessages.LOT_NOTIFY_REQUIRE_APPROVED,
    );
  }

  const bidderIds = [
    ...new Set(lotRows.map((r) => r.winnerBidderId!).filter((id) => id > 0)),
  ];

  // Always rebuild letters for distinct winners of the selected lots (not only
  // missing docs), so Notify matches the current selection.
  await syncLotConfirmationPdf(auctionId, bidderIds, userId);

  const auction = await loadAuctionContext(auctionId);
  if (!auction) {
    throw new AuctionNotFoundError();
  }

  const inputs = [];
  for (const bidderId of bidderIds) {
    const doc = await getDocumentRow(auctionId, bidderId);
    if (!doc?.isActive || !doc.s3Key) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.LOT_CONFIRMATION_PDF_MISSING,
      );
    }
    const bidder = await loadBidder(bidderId);
    if (!bidder) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.LOT_CONFIRMATION_WINNER_MISSING,
      );
    }
    const to =
      (bidder.userActive ? bidder.userEmail?.trim() : "") ||
      bidder.userEmail?.trim() ||
      "";
    if (!to) {
      throw new AuctionValidationError(
        AuctionsValidationMessages.LOT_NOTIFY_WINNER_EMAIL_MISSING,
      );
    }

    const lots = await loadApprovedLots(auctionId, bidderId);
    const ccParts = uniqueEmails([
      ...lots.map((l) => l.pocEmail),
      LOT_CONFIRMATION_EMAIL_CC,
    ]).filter((email) => email.toLowerCase() !== to.toLowerCase());

    const vars = {
      bidderCompany: bidder.companyName,
      clientName: auction.clientName,
      auctionNumber: auction.auctionNumber ?? String(auction.auctionId),
    };

    inputs.push({
      notificationId: NOTIFICATION_TYPE_LOT_CONFIRMATION,
      emailTo: to,
      emailCc: ccParts.length > 0 ? ccParts.join(",") : null,
      emailBcc: LOT_CONFIRMATION_EMAIL_BCC,
      emailBody: buildLotConfirmationEmailHtml(vars),
      subject: buildLotConfirmationEmailSubject(vars),
      auctionId,
      attachments: [
        {
          s3Key: doc.s3Key,
          filename: doc.fileName,
          contentType: LOT_CONFIRMATION_PDF_CONTENT_TYPE,
        },
      ],
      requiresAttachment: true,
      sourceType: EMAIL_SOURCE_TYPE_LOT_CONFIRMATION,
      sourceId: doc.id,
      enqueuedBy: userId,
    });
  }

  await enqueueEmails(inputs);
  return { emailedBidderCount: bidderIds.length, lotCount: uniqueLotIds.length };
}
