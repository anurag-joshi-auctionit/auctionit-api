import {
  MastersErrorMessages,
  MastersValidationMessages,
} from "@auctionit/messages/masters";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type {
  BenchmarkLocationsListParams,
  CreateBenchmarkLocationMasterInput,
  PatchBenchmarkLocationMasterInput,
} from "../../lib/benchmark-locations/schemas.js";
import type { MasterListResult } from "../../lib/masters/list-query.js";
import { db } from "../../db/index.js";
import { benchmarkLocations } from "../../db/schema/benchmark-locations.js";
import { listPaginatedMaster } from "./list-paginated.js";
import { formatUtcNow } from "@auctionit/lib/date";

export type BenchmarkLocationMasterDto = {
  id: number;
  name: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string | null;
};

export class BenchmarkLocationNotFoundError extends Error {
  constructor(id: number | string) {
    super(MastersErrorMessages.BENCHMARK_LOCATION_NOT_FOUND(id));
    this.name = "BenchmarkLocationNotFoundError";
  }
}

export class BenchmarkLocationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchmarkLocationValidationError";
  }
}

function toDto(
  row: typeof benchmarkLocations.$inferSelect,
): BenchmarkLocationMasterDto {
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
        sql`lower(${benchmarkLocations.name}) = lower(${name})`,
        ne(benchmarkLocations.id, excludeId),
      )
    : sql`lower(${benchmarkLocations.name}) = lower(${name})`;

  const [existing] = await db
    .select({ id: benchmarkLocations.id })
    .from(benchmarkLocations)
    .where(conditions)
    .limit(1);

  if (existing) {
    throw new BenchmarkLocationValidationError(
      MastersValidationMessages.BENCHMARK_LOCATION_NAME_EXISTS,
    );
  }
}

export const benchmarkLocationsMasterService = {
  async list(activeOnly = false): Promise<BenchmarkLocationMasterDto[]> {
    const rows = await db
      .select()
      .from(benchmarkLocations)
      .where(activeOnly ? eq(benchmarkLocations.isActive, true) : undefined)
      .orderBy(asc(benchmarkLocations.name));

    return rows.map(toDto);
  },

  async listPaginated(
    params: BenchmarkLocationsListParams,
  ): Promise<MasterListResult<BenchmarkLocationMasterDto>> {
    return listPaginatedMaster({
      table: benchmarkLocations,
      isActiveColumn: benchmarkLocations.isActive,
      searchColumns: [benchmarkLocations.name],
      searchIdColumn: benchmarkLocations.id,
      sortColumns: {
        id: benchmarkLocations.id,
        name: benchmarkLocations.name,
        isActive: benchmarkLocations.isActive,
        createdAt: benchmarkLocations.createdAt,
        updatedAt: benchmarkLocations.updatedAt,
      },
      defaultOrderBy: [asc(benchmarkLocations.name)],
      params,
      toDto,
    });
  },

  async create(
    input: CreateBenchmarkLocationMasterInput,
    userId?: number,
  ): Promise<BenchmarkLocationMasterDto> {
    await assertUniqueName(input.name);

    const now = formatUtcNow();
    const [created] = await db
      .insert(benchmarkLocations)
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
      throw new BenchmarkLocationValidationError(
        MastersErrorMessages.BENCHMARK_LOCATION_CREATE_FAILED,
      );
    }

    return toDto(created);
  },

  async update(
    id: number,
    input: PatchBenchmarkLocationMasterInput,
    userId?: number,
  ): Promise<BenchmarkLocationMasterDto> {
    const [existing] = await db
      .select()
      .from(benchmarkLocations)
      .where(eq(benchmarkLocations.id, id))
      .limit(1);

    if (!existing) {
      throw new BenchmarkLocationNotFoundError(id);
    }

    if (input.name !== undefined) {
      await assertUniqueName(input.name, id);
    }

    const patch: Partial<typeof benchmarkLocations.$inferInsert> = {
      updatedAt: formatUtcNow(),
      updatedBy: userId ?? null,
    };
    if (input.name !== undefined) patch.name = input.name;
    if (input.isActive !== undefined) patch.isActive = input.isActive;

    const [updated] = await db
      .update(benchmarkLocations)
      .set(patch)
      .where(eq(benchmarkLocations.id, id))
      .returning();

    if (!updated) {
      throw new BenchmarkLocationNotFoundError(id);
    }

    return toDto(updated);
  },
};
