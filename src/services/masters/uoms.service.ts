import {
  MastersErrorMessages,
  MastersValidationMessages,
} from "@auctionit/messages/masters";
import { and, asc, eq, max, ne, sql } from "drizzle-orm";
import type {
  CreateUomInput,
  PatchUomInput,
  UomsListParams,
} from "../../lib/uoms/schemas.js";
import type { MasterListResult } from "../../lib/masters/list-query.js";
import { db } from "../../db/index.js";
import { uoms } from "../../db/schema/uoms.js";
import { listPaginatedMaster } from "./list-paginated.js";
import { formatUtcNow } from "@auctionit/lib/date";

export type UomMasterDto = {
  id: number;
  code: string;
  isActive: boolean;
};

export class UomNotFoundError extends Error {
  constructor(id: number | string) {
    super(MastersErrorMessages.UOM_NOT_FOUND(id));
    this.name = "UomNotFoundError";
  }
}

export class UomValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UomValidationError";
  }
}

function toDto(row: typeof uoms.$inferSelect): UomMasterDto {
  return {
    id: row.id,
    code: row.code,
    isActive: row.isActive,
  };
}

async function nextUomId(): Promise<number> {
  const [row] = await db.select({ value: max(uoms.id) }).from(uoms);
  return (row?.value ?? 0) + 1;
}

async function assertUniqueCode(
  code: string,
  excludeId?: number,
): Promise<void> {
  const codeMatch = sql`lower(${uoms.code}) = ${code.toLowerCase()}`;
  const conditions = excludeId
    ? and(codeMatch, ne(uoms.id, excludeId))
    : codeMatch;

  const [existing] = await db
    .select({ id: uoms.id })
    .from(uoms)
    .where(conditions)
    .limit(1);

  if (existing) {
    throw new UomValidationError(MastersValidationMessages.UOM_CODE_EXISTS);
  }
}

export const uomsMasterService = {
  async list(activeOnly = false): Promise<UomMasterDto[]> {
    const rows = await db
      .select()
      .from(uoms)
      .where(activeOnly ? eq(uoms.isActive, true) : undefined)
      .orderBy(asc(uoms.code));
    return rows.map(toDto);
  },

  async listPaginated(
    params: UomsListParams,
  ): Promise<MasterListResult<UomMasterDto>> {
    return listPaginatedMaster({
      table: uoms,
      isActiveColumn: uoms.isActive,
      searchColumns: [uoms.code],
      searchIdColumn: uoms.id,
      sortColumns: {
        id: uoms.id,
        code: uoms.code,
        isActive: uoms.isActive,
      },
      defaultOrderBy: [asc(uoms.code)],
      params,
      toDto,
    });
  },

  async create(input: CreateUomInput, userId?: number): Promise<UomMasterDto> {
    await assertUniqueCode(input.code);

    const id = await nextUomId();
    if (id > 32767) {
      throw new UomValidationError(MastersValidationMessages.UOM_ID_RANGE_EXHAUSTED);
    }

    const now = formatUtcNow();
    const [created] = await db
      .insert(uoms)
      .values({
        id,
        code: input.code,
        isActive: input.isActive,
        createdAt: now,
        createdBy: userId ?? null,
        updatedAt: now,
        updatedBy: userId ?? null,
      })
      .returning();

    if (!created) {
      throw new UomValidationError(MastersErrorMessages.UOM_CREATE_FAILED);
    }

    return toDto(created);
  },

  async update(
    id: number,
    input: PatchUomInput,
    userId?: number,
  ): Promise<UomMasterDto> {
    const [existing] = await db
      .select()
      .from(uoms)
      .where(eq(uoms.id, id))
      .limit(1);

    if (!existing) {
      throw new UomNotFoundError(id);
    }

    if (input.code !== undefined) {
      await assertUniqueCode(input.code, id);
    }

    const patch: Partial<typeof uoms.$inferInsert> = {
      updatedAt: formatUtcNow(),
      updatedBy: userId ?? null,
    };
    if (input.code !== undefined) patch.code = input.code;
    if (input.isActive !== undefined) patch.isActive = input.isActive;

    const [updated] = await db
      .update(uoms)
      .set(patch)
      .where(eq(uoms.id, id))
      .returning();

    if (!updated) {
      throw new UomNotFoundError(id);
    }

    return toDto(updated);
  },
};
