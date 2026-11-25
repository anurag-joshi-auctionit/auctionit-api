import { formatUtcNow } from "@auctionit/lib/date";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { auctionRaStages } from "../../db/schema/auction-ra-stages.js";
import { type AuctionRaStageKey } from "../../db/schema/question-templates.js";
import { auctions } from "../../db/schema/auctions.js";
import { clients } from "../../db/schema/clients.js";
import type { SaveStagesConfigInput } from "../../lib/auction-ra-stages/schemas.js";
import { requireReverseAuction } from "./auction-context.js";
import { ensureStagesExist, isStageLocked, loadStagesDto, type AuctionRaStagesDto } from "./dto.js";

export type ActiveRaAuctionDto = {
  auctionId: number;
  auctionNumber: string | null;
  clientName: string | null;
  enabledStages: AuctionRaStageKey[];
};

export const auctionRaStagesConfigService = {
  async listActiveAuctions(): Promise<ActiveRaAuctionDto[]> {
    const rows = await db
      .select({
        auctionId: auctions.id,
        auctionNumber: auctions.auctionNumber,
        clientName: clients.companyName,
        stageKey: auctionRaStages.stageKey,
      })
      .from(auctionRaStages)
      .innerJoin(auctions, eq(auctionRaStages.auctionId, auctions.id))
      .leftJoin(clients, eq(auctions.clientId, clients.id))
      .where(
        and(
          eq(auctionRaStages.enabled, true),
          eq(auctions.status, "published"),
          eq(auctions.isActive, true),
        ),
      )
      .orderBy(auctions.auctionNumber, auctionRaStages.stageKey);

    const map = new Map<number, ActiveRaAuctionDto>();
    for (const r of rows) {
      let entry = map.get(r.auctionId);
      if (!entry) {
        entry = {
          auctionId: r.auctionId,
          auctionNumber: r.auctionNumber,
          clientName: r.clientName ?? null,
          enabledStages: [],
        };
        map.set(r.auctionId, entry);
      }
      entry.enabledStages.push(r.stageKey);
    }
    return [...map.values()];
  },

  async getStages(auctionId: number): Promise<AuctionRaStagesDto> {
    await requireReverseAuction(auctionId);
    return loadStagesDto(auctionId);
  },

  async saveConfig(
    auctionId: number,
    input: SaveStagesConfigInput,
    userId: number,
  ): Promise<AuctionRaStagesDto> {
    await requireReverseAuction(auctionId);
    const rows = await ensureStagesExist(auctionId);
    const now = formatUtcNow();

    for (const row of rows) {
      // Stages are locked once a bidder has submitted — skip those.
      if (await isStageLocked(row.id)) continue;

      const enabled = input.enabledKeys.includes(row.stageKey);
      if (enabled === row.enabled) continue;

      await db
        .update(auctionRaStages)
        .set({ enabled, updatedAt: now, updatedBy: userId })
        .where(eq(auctionRaStages.id, row.id));
    }

    return loadStagesDto(auctionId);
  },
};
