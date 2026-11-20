import { formatUtcNow } from "@auctionit/lib/date";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { auctionRaStages } from "../../db/schema/auction-ra-stages.js";
import type { SaveStagesConfigInput } from "../../lib/auction-ra-stages/schemas.js";
import { requireReverseAuction } from "./auction-context.js";
import { ensureStagesExist, isStageLocked, loadStagesDto, type AuctionRaStagesDto } from "./dto.js";

export const auctionRaStagesConfigService = {
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
      // Locked (published/closed) stages are left untouched regardless of the
      // new enabled set — nothing time-based can be undone once it started.
      if (isStageLocked(row.status)) continue;

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
