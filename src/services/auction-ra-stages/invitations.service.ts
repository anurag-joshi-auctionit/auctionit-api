import { formatUtcNow } from "@auctionit/lib/date";
import { and, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { auctionRaStageInvitedBidders } from "../../db/schema/auction-ra-stage-invitations.js";
import { auctionRaStageResponses } from "../../db/schema/auction-ra-stage-responses.js";
import { auctionRaStages } from "../../db/schema/auction-ra-stages.js";
import { bidders } from "../../db/schema/bidders.js";
import { materials } from "../../db/schema/materials.js";
import type { AuctionRaStageKey } from "../../db/schema/question-templates.js";
import { users } from "../../db/schema/users.js";
import type { InviteBiddersInput } from "../../lib/auction-ra-stages/schemas.js";
import { blockedBidderIdsForClient } from "../../lib/bidders/blocked-for-client.js";
import { AuctionRaStagesValidationMessages } from "@auctionit/messages/auction-ra-stages";
import { requireReverseAuction } from "./auction-context.js";
import { earliestEnabledStageKey, ensureStagesExist } from "./dto.js";
import { AuctionRaStageValidationError } from "./errors.js";
import { enqueueEmails } from "../email-dispatch.service.js";
import {
  buildRaStageInviteHtml,
  buildRaStageInviteSubject,
} from "../../lib/auction-ra-stages/invite-email-template.js";
import { NOTIFICATION_TYPE_AUCTION_RA_STAGE_INVITE } from "../../db/schema/notification-types.js";
import { EMAIL_SOURCE_TYPE_AUCTION_RA_STAGE_INVITE } from "../../db/schema/notification-email-logs.js";

const STAGE_LABEL: Record<AuctionRaStageKey, string> = {
  rfi: "RFI",
  rfp: "RFP",
  rfq: "RFQ",
};

export type InvitableBidderDto = {
  bidderId: number;
  companyName: string;
  materials: string[];
};

export type InvitedBidderDto = {
  bidderId: number;
  companyName: string;
  invitedBy: string;
  invitedAt: string;
  entryStages: string[];
};

async function activeInvitedBidderIds(auctionId: number): Promise<number[]> {
  const rows = await db
    .select({ bidderId: auctionRaStageInvitedBidders.bidderId })
    .from(auctionRaStageInvitedBidders)
    .where(
      and(
        eq(auctionRaStageInvitedBidders.auctionId, auctionId),
        eq(auctionRaStageInvitedBidders.isActive, true),
      ),
    );
  return rows.map((r) => r.bidderId);
}

export const auctionRaStagesInvitationsService = {
  async listInvitable(
    auctionId: number,
    filters: { material?: string; location?: string },
  ): Promise<InvitableBidderDto[]> {
    const ctx = await requireReverseAuction(auctionId);
    const alreadyInvited = await activeInvitedBidderIds(auctionId);

    let materialId: number | undefined;
    if (filters.material) {
      const [m] = await db
        .select({ id: materials.id })
        .from(materials)
        .where(eq(materials.label, filters.material))
        .limit(1);
      materialId = m?.id;
    }

    const conditions = [eq(bidders.isActive, true), eq(bidders.isVerified, true)];
    if (alreadyInvited.length > 0) conditions.push(notInArray(bidders.id, alreadyInvited));
    if (filters.location) conditions.push(eq(bidders.city, filters.location));

    const rows = await db
      .select({
        id: bidders.id,
        companyName: bidders.companyName,
        materials: bidders.materials,
      })
      .from(bidders)
      .where(and(...conditions));

    const filtered =
      materialId != null ? rows.filter((r) => r.materials.includes(materialId!)) : rows;

    const blocked = await blockedBidderIdsForClient(ctx.clientId, filtered.map((r) => r.id));
    const eligible = filtered.filter((r) => !blocked.has(r.id));

    const allMaterialIds = [...new Set(eligible.flatMap((r) => r.materials))];
    const materialRows = allMaterialIds.length
      ? await db.select().from(materials).where(inArray(materials.id, allMaterialIds))
      : [];
    const materialLabelById = new Map(materialRows.map((m) => [m.id, m.label]));

    return eligible.map((r) => ({
      bidderId: r.id,
      companyName: r.companyName,
      materials: r.materials.map((id) => materialLabelById.get(id) ?? `#${id}`),
    }));
  },

  async listInviteFilterOptions(
    auctionId: number,
  ): Promise<{ materials: { value: string; label: string }[]; locations: { value: string; label: string }[] }> {
    await requireReverseAuction(auctionId);
    const alreadyInvited = await activeInvitedBidderIds(auctionId);
    const conditions = [eq(bidders.isActive, true), eq(bidders.isVerified, true)];
    if (alreadyInvited.length > 0) conditions.push(notInArray(bidders.id, alreadyInvited));

    const rows = await db
      .select({ materials: bidders.materials, city: bidders.city })
      .from(bidders)
      .where(and(...conditions));

    const materialIds = [...new Set(rows.flatMap((r) => r.materials))];
    const materialRows = materialIds.length
      ? await db.select().from(materials).where(inArray(materials.id, materialIds))
      : [];

    const cities = [...new Set(rows.map((r) => r.city).filter((c): c is string => !!c))].sort();

    return {
      materials: materialRows
        .map((m) => ({ value: m.label, label: m.label }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      locations: cities.map((c) => ({ value: c, label: c })),
    };
  },

  async listInvited(auctionId: number): Promise<InvitedBidderDto[]> {
    await requireReverseAuction(auctionId);
    const rows = await db
      .select({
        bidderId: auctionRaStageInvitedBidders.bidderId,
        companyName: bidders.companyName,
        invitedByName: users.name,
        invitedAt: auctionRaStageInvitedBidders.invitedAt,
        entryStage: auctionRaStageInvitedBidders.entryStage,
      })
      .from(auctionRaStageInvitedBidders)
      .innerJoin(bidders, eq(bidders.id, auctionRaStageInvitedBidders.bidderId))
      .innerJoin(users, eq(users.id, auctionRaStageInvitedBidders.invitedBy))
      .where(
        and(
          eq(auctionRaStageInvitedBidders.auctionId, auctionId),
          eq(auctionRaStageInvitedBidders.isActive, true),
        ),
      );

    return rows.map((r) => ({
      bidderId: r.bidderId,
      companyName: r.companyName,
      invitedBy: r.invitedByName,
      invitedAt: r.invitedAt,
      entryStages: r.entryStage ? [STAGE_LABEL[r.entryStage]] : [],
    }));
  },

  async invite(auctionId: number, input: InviteBiddersInput, userId: number): Promise<void> {
    await requireReverseAuction(auctionId);
    const stageRows = await ensureStagesExist(auctionId);
    const entryStage = input.entryStage ?? earliestEnabledStageKey(stageRows);
    if (!entryStage) {
      throw new AuctionRaStageValidationError(
        AuctionRaStagesValidationMessages.SELECT_ENTRY_STAGE_REQUIRED,
      );
    }
    const entryStageRow = stageRows.find((r) => r.stageKey === entryStage);
    if (!entryStageRow) {
      throw new AuctionRaStageValidationError(
        AuctionRaStagesValidationMessages.SELECT_ENTRY_STAGE_REQUIRED,
      );
    }

    const now = formatUtcNow();
    const bidderRows = await db
      .select({ id: bidders.id, companyName: bidders.companyName })
      .from(bidders)
      .where(inArray(bidders.id, input.bidderIds));
    const emailRows = await db
      .select({ bidderId: users.bidderId, email: users.emailId })
      .from(users)
      .where(and(inArray(users.bidderId, input.bidderIds), isNotNull(users.emailId)));
    const emailByBidderId = new Map(
      emailRows.filter((r) => r.bidderId != null).map((r) => [r.bidderId as number, r.email!]),
    );

    for (const bidderRow of bidderRows) {
      const [existing] = await db
        .select({ id: auctionRaStageInvitedBidders.id })
        .from(auctionRaStageInvitedBidders)
        .where(
          and(
            eq(auctionRaStageInvitedBidders.auctionId, auctionId),
            eq(auctionRaStageInvitedBidders.bidderId, bidderRow.id),
            eq(auctionRaStageInvitedBidders.isActive, true),
          ),
        )
        .limit(1);
      if (existing) continue;

      await db.transaction(async (tx) => {
        await tx.insert(auctionRaStageInvitedBidders).values({
          auctionId,
          bidderId: bidderRow.id,
          entryStage: entryStage,
          invitedBy: userId,
          invitedAt: now,
        });

        await tx
          .insert(auctionRaStageResponses)
          .values({
            auctionRaStageId: entryStageRow.id,
            bidderId: bidderRow.id,
            status: "invited",
            createdAt: now,
          })
          .onConflictDoUpdate({
            target: [auctionRaStageResponses.auctionRaStageId, auctionRaStageResponses.bidderId],
            set: {
              status: sql`'invited'`,
              submittedAt: null,
              isShortlisted: null,
              rejectionReason: null,
              decidedBy: null,
              decidedAt: null,
              updatedAt: now,
            },
          });
      });

      const email = emailByBidderId.get(bidderRow.id);
      if (email) {
        await enqueueEmails([
          {
            notificationId: NOTIFICATION_TYPE_AUCTION_RA_STAGE_INVITE,
            emailTo: email,
            subject: buildRaStageInviteSubject(STAGE_LABEL[entryStage]),
            emailBody: buildRaStageInviteHtml(bidderRow.companyName, STAGE_LABEL[entryStage]),
            sourceType: EMAIL_SOURCE_TYPE_AUCTION_RA_STAGE_INVITE,
            sourceId: auctionId,
            enqueuedBy: userId,
          },
        ]);
      }
    }
  },

  async withdraw(auctionId: number, bidderId: number, userId: number): Promise<void> {
    await requireReverseAuction(auctionId);
    const now = formatUtcNow();
    await db.transaction(async (tx) => {
      await tx
        .update(auctionRaStageInvitedBidders)
        .set({ isActive: false, withdrawnAt: now, withdrawnBy: userId })
        .where(
          and(
            eq(auctionRaStageInvitedBidders.auctionId, auctionId),
            eq(auctionRaStageInvitedBidders.bidderId, bidderId),
            eq(auctionRaStageInvitedBidders.isActive, true),
          ),
        );
      // Remove unsubmitted response rows so re-inviting the same bidder later
      // doesn't hit the unique (auctionRaStageId, bidderId) constraint.
      const stageIds = await tx
        .select({ id: auctionRaStages.id })
        .from(auctionRaStages)
        .where(eq(auctionRaStages.auctionId, auctionId));
      if (stageIds.length > 0) {
        await tx
          .delete(auctionRaStageResponses)
          .where(
            and(
              eq(auctionRaStageResponses.bidderId, bidderId),
              inArray(
                auctionRaStageResponses.auctionRaStageId,
                stageIds.map((r) => r.id),
              ),
              inArray(auctionRaStageResponses.status, ["invited", "draft"]),
            ),
          );
      }
    });
  },
};
