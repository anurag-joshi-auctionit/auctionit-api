import {
  MastersErrorMessages,
  MastersValidationMessages,
} from "@auctionit/messages/masters";
import { asc, eq } from "drizzle-orm";
import type { MasterListResult } from "../../lib/masters/list-query.js";
import { LIFTING_CLIENT_DISPOSITION } from "../../lib/masters/status-keys.js";
import type { DispositionsMasterListParams } from "../../lib/validation/masters.js";
import { db } from "../../db/index.js";
import { liftingClientDispositions } from "../../db/schema/index.js";
import { listPaginatedMaster } from "./list-paginated.js";
import {
  invalidateDispositionCache,
  type ClientDispositionRow,
} from "./resolve-disposition.js";
import { formatUtcNow } from "@auctionit/lib/date";

export type ClientDispositionDto = {
  id: string;
  label: string;
  description: string;
  isActive: boolean;
};

function toDto(row: ClientDispositionRow): ClientDispositionDto {
  return {
    id: String(row.id),
    label: row.label,
    description: row.description,
    isActive: row.isActive,
  };
}

export class MasterValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MasterValidationError";
  }
}

export class MasterNotFoundError extends Error {
  constructor(id: string) {
    super(MastersErrorMessages.MASTER_ROW_NOT_FOUND(id));
    this.name = "MasterNotFoundError";
  }
}

export class MasterConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MasterConflictError";
  }
}

function rowToDto(row: typeof liftingClientDispositions.$inferSelect): ClientDispositionDto {
  return toDto({
    id: row.id,
    label: row.label,
    description: row.description ?? "",
    isActive: Boolean(row.isActive),
  });
}

export const liftingClientDispositionMasterService = {
  async list(activeOnly = false): Promise<ClientDispositionDto[]> {
    const conditions = activeOnly
      ? eq(liftingClientDispositions.isActive, true)
      : undefined;

    const rows = await db
      .select()
      .from(liftingClientDispositions)
      .where(conditions)
      .orderBy(asc(liftingClientDispositions.id));

    return rows.map(rowToDto);
  },

  async listPaginated(
    params: DispositionsMasterListParams,
  ): Promise<MasterListResult<ClientDispositionDto>> {
    return listPaginatedMaster({
      table: liftingClientDispositions,
      isActiveColumn: liftingClientDispositions.isActive,
      searchColumns: [
        liftingClientDispositions.label,
        liftingClientDispositions.description,
      ],
      searchIdColumn: liftingClientDispositions.id,
      sortColumns: {
        id: liftingClientDispositions.id,
        label: liftingClientDispositions.label,
        description: liftingClientDispositions.description,
        isActive: liftingClientDispositions.isActive,
      },
      defaultOrderBy: [asc(liftingClientDispositions.id)],
      params,
      toDto: rowToDto,
    });
  },

  async update(
    id: string,
    input: {
      label?: string;
      description?: string;
      isActive?: boolean;
    },
    userId?: number,
  ): Promise<ClientDispositionDto> {
    const masterId = Number(id);
    if (!Number.isInteger(masterId) || masterId < 1) {
      throw new MasterNotFoundError(id);
    }

    const [existing] = await db
      .select()
      .from(liftingClientDispositions)
      .where(eq(liftingClientDispositions.id, masterId));

    if (!existing) {
      throw new MasterNotFoundError(id);
    }

    if (
      existing.id === LIFTING_CLIENT_DISPOSITION.OPEN &&
      input.isActive === false
    ) {
      throw new MasterValidationError(MastersValidationMessages.OPEN_DISPOSITION_DEACTIVATE);
    }

    const patch: Partial<typeof liftingClientDispositions.$inferInsert> =
      {};
    if (input.label !== undefined) patch.label = input.label;
    if (input.description !== undefined) patch.description = input.description;
    if (input.isActive !== undefined) patch.isActive = input.isActive;

    if (Object.keys(patch).length === 0) {
      return toDto({
        id: existing.id,
        label: existing.label,
        description: existing.description ?? "",
        isActive: Boolean(existing.isActive),
      });
    }

    patch.updatedAt = formatUtcNow();
    patch.updatedBy = userId ?? null;

    await db
      .update(liftingClientDispositions)
      .set(patch)
      .where(eq(liftingClientDispositions.id, masterId));

    invalidateDispositionCache();

    const [updated] = await db
      .select()
      .from(liftingClientDispositions)
      .where(eq(liftingClientDispositions.id, masterId));

    if (!updated) throw new MasterNotFoundError(id);

    return toDto({
      id: updated.id,
      label: updated.label,
      description: updated.description ?? "",
      isActive: Boolean(updated.isActive),
    });
  },
};
