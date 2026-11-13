import {
  MastersErrorMessages,
  MastersValidationMessages,
} from "@auctionit/messages/masters";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type {
  BenchmarkMaterialsListParams,
  CreateBenchmarkMaterialMasterInput,
  PatchBenchmarkMaterialMasterInput,
} from "../../lib/benchmark-materials/schemas.js";
import type { MasterListResult } from "../../lib/masters/list-query.js";
import { db } from "../../db/index.js";
import { benchmarkMaterials } from "../../db/schema/benchmark-materials.js";
import { listPaginatedMaster } from "./list-paginated.js";
import { formatUtcNow } from "@auctionit/lib/date";

export type BenchmarkMaterialMasterDto = {
  id: number;
  name: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string | null;
};

export class BenchmarkMaterialNotFoundError extends Error {
  constructor(id: number | string) {
    super(MastersErrorMessages.BENCHMARK_MATERIAL_NOT_FOUND(id));
    this.name = "BenchmarkMaterialNotFoundError";
  }
}

export class BenchmarkMaterialValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchmarkMaterialValidationError";
  }
}

function toDto(
  row: typeof benchmarkMaterials.$inferSelect,
): BenchmarkMaterialMasterDto {
  return {
    id: row.id,
    name: row.name,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? null,
  };
}

async function assertUniqueName(name: string, excludeId?: number): Promise<void> {
  const conditions = excludeId
    ? and(
        sql`lower(${benchmarkMaterials.name}) = lower(${name})`,
        ne(benchmarkMaterials.id, excludeId),
      )
    : sql`lower(${benchmarkMaterials.name}) = lower(${name})`;

  const [existing] = await db
    .select({ id: benchmarkMaterials.id })
    .from(benchmarkMaterials)
    .where(conditions)
    .limit(1);

  if (existing) {
    throw new BenchmarkMaterialValidationError(
      MastersValidationMessages.BENCHMARK_MATERIAL_NAME_EXISTS,
    );
  }
}

export const benchmarkMaterialsMasterService = {
  async list(activeOnly = false): Promise<BenchmarkMaterialMasterDto[]> {
    const rows = await db
      .select()
      .from(benchmarkMaterials)
      .where(activeOnly ? eq(benchmarkMaterials.isActive, true) : undefined)
      .orderBy(asc(benchmarkMaterials.name));

    return rows.map(toDto);
  },

  async listPaginated(
    params: BenchmarkMaterialsListParams,
  ): Promise<MasterListResult<BenchmarkMaterialMasterDto>> {
    return listPaginatedMaster({
      table: benchmarkMaterials,
      isActiveColumn: benchmarkMaterials.isActive,
      searchColumns: [benchmarkMaterials.name],
      searchIdColumn: benchmarkMaterials.id,
      sortColumns: {
        id: benchmarkMaterials.id,
        name: benchmarkMaterials.name,
        isActive: benchmarkMaterials.isActive,
        createdAt: benchmarkMaterials.createdAt,
        updatedAt: benchmarkMaterials.updatedAt,
      },
      defaultOrderBy: [asc(benchmarkMaterials.name)],
      params,
      toDto,
    });
  },

  async create(
    input: CreateBenchmarkMaterialMasterInput,
    userId?: number,
  ): Promise<BenchmarkMaterialMasterDto> {
    await assertUniqueName(input.name);

    const now = formatUtcNow();
    const [created] = await db
      .insert(benchmarkMaterials)
      .values({
        name: input.name,
        isActive: input.isActive,
        createdAt: now,
        createdBy: userId ?? null,
        updatedAt: now,
        updatedBy: userId ?? null,
      })
      .returning();

    if (!created) {
      throw new BenchmarkMaterialValidationError(
        MastersErrorMessages.BENCHMARK_MATERIAL_CREATE_FAILED,
      );
    }

    return toDto(created);
  },

  async update(
    id: number,
    input: PatchBenchmarkMaterialMasterInput,
    userId?: number,
  ): Promise<BenchmarkMaterialMasterDto> {
    const [existing] = await db
      .select()
      .from(benchmarkMaterials)
      .where(eq(benchmarkMaterials.id, id))
      .limit(1);

    if (!existing) {
      throw new BenchmarkMaterialNotFoundError(id);
    }

    if (input.name !== undefined) {
      await assertUniqueName(input.name, id);
    }

    const patch: Partial<typeof benchmarkMaterials.$inferInsert> = {
      updatedAt: formatUtcNow(),
      updatedBy: userId ?? null,
    };
    if (input.name !== undefined) patch.name = input.name;
    if (input.isActive !== undefined) patch.isActive = input.isActive;

    const [updated] = await db
      .update(benchmarkMaterials)
      .set(patch)
      .where(eq(benchmarkMaterials.id, id))
      .returning();

    if (!updated) {
      throw new BenchmarkMaterialNotFoundError(id);
    }

    return toDto(updated);
  },
};
