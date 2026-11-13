import { MastersValidationMessages } from "@auctionit/messages/masters";
import { and, asc, eq, ne } from "drizzle-orm";
import type { MasterListResult } from "../../lib/masters/list-query.js";
import type { DispositionsMasterListParams } from "../../lib/validation/masters.js";
import { db } from "../../db/index.js";
import { liftingBidderDispositions } from "../../db/schema/index.js";
import { listPaginatedMaster } from "./list-paginated.js";
import { invalidateDispositionCache } from "./resolve-disposition.js";
import {
  MasterConflictError,
  MasterNotFoundError,
  type ClientDispositionDto,
} from "./lifting-client-disposition.service.js";
import { formatUtcNow } from "@auctionit/lib/date";

export { MasterConflictError, MasterNotFoundError };

export type BidderDispositionDto = ClientDispositionDto & {
  requiresLiftedQty: boolean;
  requiresNextFollowup: boolean;
};

function toDto(row: {
  id: number;
  label: string;
  description: string | null;
  isActive: boolean | null;
  requiresLiftedQty: boolean | null;
  requiresNextFollowup: boolean | null;
}): BidderDispositionDto {
  return {
    id: String(row.id),
    label: row.label,
    description: row.description ?? "",
    isActive: Boolean(row.isActive),
    requiresLiftedQty: Boolean(row.requiresLiftedQty),
    requiresNextFollowup: Boolean(row.requiresNextFollowup),
  };
}

export const liftingBidderDispositionMasterService = {
  async list(activeOnly = false): Promise<BidderDispositionDto[]> {
    const conditions = activeOnly
      ? eq(liftingBidderDispositions.isActive, true)
      : undefined;

    const rows = await db
      .select()
      .from(liftingBidderDispositions)
      .where(conditions)
      .orderBy(asc(liftingBidderDispositions.id));

    return rows.map(toDto);
  },

  async listPaginated(
    params: DispositionsMasterListParams,
  ): Promise<MasterListResult<BidderDispositionDto>> {
    return listPaginatedMaster({
      table: liftingBidderDispositions,
      isActiveColumn: liftingBidderDispositions.isActive,
      searchColumns: [
        liftingBidderDispositions.label,
        liftingBidderDispositions.description,
      ],
      searchIdColumn: liftingBidderDispositions.id,
      sortColumns: {
        id: liftingBidderDispositions.id,
        label: liftingBidderDispositions.label,
        description: liftingBidderDispositions.description,
        isActive: liftingBidderDispositions.isActive,
      },
      defaultOrderBy: [asc(liftingBidderDispositions.id)],
      params,
      toDto,
    });
  },

  async create(
    input: {
      label: string;
      description?: string;
      requiresLiftedQty?: boolean;
      requiresNextFollowup?: boolean;
    },
    userId?: number,
  ): Promise<BidderDispositionDto> {
    const existing = await db
      .select({ id: liftingBidderDispositions.id })
      .from(liftingBidderDispositions)
      .where(eq(liftingBidderDispositions.label, input.label));

    if (existing.length > 0) {
      throw new MasterConflictError(MastersValidationMessages.DISPOSITION_LABEL_EXISTS);
    }

    const now = formatUtcNow();
    const [inserted] = await db
      .insert(liftingBidderDispositions)
      .values({
        label: input.label,
        description: input.description ?? "",
        isActive: true,
        requiresLiftedQty: input.requiresLiftedQty ?? false,
        requiresNextFollowup: input.requiresNextFollowup ?? true,
        createdAt: now,
        createdBy: userId ?? null,
        updatedAt: now,
        updatedBy: userId ?? null,
      })
      .returning();

    if (!inserted) {
      throw new Error("Failed to create bidder disposition master");
    }

    invalidateDispositionCache();
    return toDto(inserted);
  },

  async update(
    id: string,
    input: {
      label?: string;
      description?: string;
      isActive?: boolean;
      requiresLiftedQty?: boolean;
      requiresNextFollowup?: boolean;
    },
    userId?: number,
  ): Promise<BidderDispositionDto> {
    const masterId = Number(id);
    if (!Number.isInteger(masterId) || masterId < 1) {
      throw new MasterNotFoundError(id);
    }

    const [existing] = await db
      .select()
      .from(liftingBidderDispositions)
      .where(eq(liftingBidderDispositions.id, masterId));

    if (!existing) {
      throw new MasterNotFoundError(id);
    }

    if (input.label !== undefined && input.label !== existing.label) {
      const [clash] = await db
        .select({ id: liftingBidderDispositions.id })
        .from(liftingBidderDispositions)
        .where(
          and(
            eq(liftingBidderDispositions.label, input.label),
            ne(liftingBidderDispositions.id, masterId),
          ),
        )
        .limit(1);
      if (clash) {
        throw new MasterConflictError(MastersValidationMessages.DISPOSITION_LABEL_EXISTS);
      }
    }

    const patch: Partial<typeof liftingBidderDispositions.$inferInsert> = {};
    if (input.label !== undefined) patch.label = input.label;
    if (input.description !== undefined) patch.description = input.description;
    if (input.isActive !== undefined) patch.isActive = input.isActive;
    if (input.requiresLiftedQty !== undefined) {
      patch.requiresLiftedQty = input.requiresLiftedQty;
    }
    if (input.requiresNextFollowup !== undefined) {
      patch.requiresNextFollowup = input.requiresNextFollowup;
    }

    if (Object.keys(patch).length === 0) {
      return toDto(existing);
    }

    patch.updatedAt = formatUtcNow();
    patch.updatedBy = userId ?? null;

    await db
      .update(liftingBidderDispositions)
      .set(patch)
      .where(eq(liftingBidderDispositions.id, masterId));

    invalidateDispositionCache();

    const [updated] = await db
      .select()
      .from(liftingBidderDispositions)
      .where(eq(liftingBidderDispositions.id, masterId));

    if (!updated) throw new MasterNotFoundError(id);
    return toDto(updated);
  },
};
