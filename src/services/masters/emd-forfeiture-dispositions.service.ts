import { and, asc, eq, ne, sql } from "drizzle-orm";
import { formatUtcNow } from "@auctionit/lib/date";
import { EmdErrorMessages } from "@auctionit/messages/emd";
import type { MasterListResult } from "../../lib/masters/list-query.js";
import type { DispositionsMasterListParams } from "../../lib/validation/masters.js";
import { db } from "../../db/index.js";
import { emdForfeitureDispositions } from "../../db/schema/index.js";
import { listPaginatedMaster } from "./list-paginated.js";
import {
  MasterConflictError,
  MasterNotFoundError,
  type ClientDispositionDto,
} from "./lifting-client-disposition.service.js";

export { MasterConflictError, MasterNotFoundError };

export type EmdForfeitureDispositionDto = ClientDispositionDto;

function toDto(row: typeof emdForfeitureDispositions.$inferSelect): EmdForfeitureDispositionDto {
  return {
    id: String(row.id),
    label: row.label,
    description: row.description,
    isActive: row.isActive,
  };
}

async function assertUniqueLabel(label: string, excludeId?: number): Promise<void> {
  const match = sql`lower(${emdForfeitureDispositions.label}) = ${label.toLowerCase()}`;
  const [existing] = await db
    .select({ id: emdForfeitureDispositions.id })
    .from(emdForfeitureDispositions)
    .where(excludeId ? and(match, ne(emdForfeitureDispositions.id, excludeId)) : match)
    .limit(1);
  if (existing) throw new MasterConflictError(EmdErrorMessages.FORFEITURE_DISPOSITION_EXISTS);
}

export const emdForfeitureDispositionsMasterService = {
  async list(activeOnly = false): Promise<EmdForfeitureDispositionDto[]> {
    const rows = await db
      .select()
      .from(emdForfeitureDispositions)
      .where(activeOnly ? eq(emdForfeitureDispositions.isActive, true) : undefined)
      .orderBy(asc(emdForfeitureDispositions.label));
    return rows.map(toDto);
  },

  async listPaginated(
    params: DispositionsMasterListParams,
  ): Promise<MasterListResult<EmdForfeitureDispositionDto>> {
    return listPaginatedMaster({
      table: emdForfeitureDispositions,
      isActiveColumn: emdForfeitureDispositions.isActive,
      searchColumns: [emdForfeitureDispositions.label, emdForfeitureDispositions.description],
      searchIdColumn: emdForfeitureDispositions.id,
      sortColumns: {
        id: emdForfeitureDispositions.id,
        label: emdForfeitureDispositions.label,
        description: emdForfeitureDispositions.description,
        isActive: emdForfeitureDispositions.isActive,
      },
      defaultOrderBy: [asc(emdForfeitureDispositions.label)],
      params,
      toDto,
    });
  },

  async create(
    input: { label: string; description?: string },
    userId?: number,
  ): Promise<EmdForfeitureDispositionDto> {
    await assertUniqueLabel(input.label);
    const now = formatUtcNow();
    const [inserted] = await db
      .insert(emdForfeitureDispositions)
      .values({
        label: input.label,
        description: input.description ?? "",
        isActive: true,
        createdAt: now,
        createdBy: userId ?? null,
        updatedAt: now,
        updatedBy: userId ?? null,
      })
      .returning();
    return toDto(inserted!);
  },

  async update(
    id: string,
    input: { label?: string; description?: string; isActive?: boolean },
    userId?: number,
  ): Promise<EmdForfeitureDispositionDto> {
    const masterId = Number(id);
    if (!Number.isInteger(masterId) || masterId < 1) throw new MasterNotFoundError(id);
    if (input.label !== undefined) await assertUniqueLabel(input.label, masterId);

    const [updated] = await db
      .update(emdForfeitureDispositions)
      .set({
        ...(input.label !== undefined && { label: input.label }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        updatedAt: formatUtcNow(),
        updatedBy: userId ?? null,
      })
      .where(eq(emdForfeitureDispositions.id, masterId))
      .returning();
    if (!updated) throw new MasterNotFoundError(id);
    return toDto(updated);
  },
};
