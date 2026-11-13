import { and, asc, desc, eq, ilike, ne, or, sql, type SQL } from "drizzle-orm";
import { BenchmarksErrorMessages, BenchmarksValidationMessages } from "@auctionit/messages/benchmarks";
import type {
  BenchmarkCombosListParams,
  CreateBenchmarkComboInput,
  PatchBenchmarkComboInput,
} from "../lib/benchmarks/schemas.js";
import { db } from "../db/index.js";
import {
  BENCHMARK_BASE_CURRENCY,
  benchmarkMaterialLocations,
  type BenchmarkCurrency,
} from "../db/schema/benchmark-material-locations.js";
import { benchmarkMaterials } from "../db/schema/benchmark-materials.js";
import { benchmarkLocations } from "../db/schema/benchmark-locations.js";
import {
  activeInactiveStatus,
  clampPagination,
  combineConditions,
} from "./list-query.js";
import {
  nonInrPriceDateRange,
  rateBenchmarkPrices,
} from "./benchmark-price-rating.js";
import { FxRateUnavailableError, fxRatesService } from "./fx-rates.service.js";
import { formatUtcNow } from "@auctionit/lib/date";

export type { BenchmarkCombosListParams } from "../lib/benchmarks/schemas.js";

export type BenchmarkComboListRow = {
  id: number;
  materialId: number;
  material: string;
  locationId: number;
  location: string;
  currency: BenchmarkCurrency;
  isActive: boolean;
  createdAt: string;
  updatedAt: string | null;
};

export type BenchmarkComboListCounts = {
  total: number;
  active: number;
  inactive: number;
};

export type BenchmarkComboListResult = {
  items: BenchmarkComboListRow[];
  total: number;
  page: number;
  pageSize: number;
  counts: BenchmarkComboListCounts;
};

export type BenchmarkEntityOption = {
  id: number;
  name: string;
};

export class BenchmarkComboNotFoundError extends Error {
  constructor(id: number | string) {
    super(BenchmarksErrorMessages.COMBO_NOT_FOUND);
    this.name = "BenchmarkComboNotFoundError";
  }
}

export class BenchmarkComboValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchmarkComboValidationError";
  }
}

function normalizeLabel(value: string): string {
  return value.trim();
}

const COMBO_SORT_FIELDS = new Set([
  "material",
  "location",
  "isActive",
  "createdAt",
  "updatedAt",
] as const);

function buildSortOrder(
  sortBy: BenchmarkCombosListParams["sortBy"],
  sortOrder: BenchmarkCombosListParams["sortOrder"],
) {
  const field =
    sortBy && COMBO_SORT_FIELDS.has(sortBy) ? sortBy : ("material" as const);
  const dir = sortOrder === "desc" ? desc : asc;

  switch (field) {
    case "location":
      return [dir(benchmarkLocations.name), asc(benchmarkMaterials.name)];
    case "isActive":
      return [dir(benchmarkMaterialLocations.isActive), asc(benchmarkMaterials.name)];
    case "createdAt":
      return [dir(benchmarkMaterialLocations.createdAt)];
    case "updatedAt":
      return [dir(benchmarkMaterialLocations.updatedAt)];
    case "material":
    default:
      return [dir(benchmarkMaterials.name), asc(benchmarkLocations.name)];
  }
}

function buildComboListWhere(opts: BenchmarkCombosListParams): SQL | undefined {
  const search = opts.search?.trim();
  const conditions = [
    activeInactiveStatus(benchmarkMaterialLocations.isActive, opts.status ?? "all"),
    opts.location ? ilike(benchmarkLocations.name, `%${opts.location}%`) : undefined,
  ];

  if (search) {
    const term = `%${search}%`;
    conditions.push(
      or(
        ilike(benchmarkMaterials.name, term),
        ilike(benchmarkLocations.name, term),
      )!,
    );
  }

  return combineConditions(conditions);
}

type ComboJoinRow = {
  id: number;
  materialId: number;
  material: string;
  locationId: number;
  location: string;
  currency: BenchmarkCurrency;
  isActive: boolean;
  createdAt: string;
  updatedAt: string | null;
};

const comboJoinSelect = {
  id: benchmarkMaterialLocations.id,
  materialId: benchmarkMaterialLocations.materialId,
  material: benchmarkMaterials.name,
  locationId: benchmarkMaterialLocations.locationId,
  location: benchmarkLocations.name,
  currency: benchmarkMaterialLocations.currency,
  isActive: benchmarkMaterialLocations.isActive,
  createdAt: benchmarkMaterialLocations.createdAt,
  updatedAt: benchmarkMaterialLocations.updatedAt,
};

function comboFrom() {
  return db
    .select(comboJoinSelect)
    .from(benchmarkMaterialLocations)
    .innerJoin(benchmarkMaterials, eq(benchmarkMaterialLocations.materialId, benchmarkMaterials.id))
    .innerJoin(benchmarkLocations, eq(benchmarkMaterialLocations.locationId, benchmarkLocations.id));
}

function mapComboRow(row: ComboJoinRow): BenchmarkComboListRow {
  return { ...row };
}

/** Caches the rates a combo's price history needs before it is re-rated. */
async function loadRatesForCombo(
  comboId: number,
  currency: BenchmarkCurrency,
): Promise<void> {
  if (currency === BENCHMARK_BASE_CURRENCY) return;
  const today = new Date().toISOString().slice(0, 10);
  for (const range of await nonInrPriceDateRange({ comboId, currency })) {
    try {
      await fxRatesService.loadRange(
        currency,
        range.from,
        range.to > today ? today : range.to,
      );
    } catch (err) {
      console.error(`[benchmarks] loading ${currency}/INR rates failed`, err);
      throw new FxRateUnavailableError(currency, range.from);
    }
  }
}

async function findDuplicateCombo(
  materialId: number,
  locationId: number,
  excludeId?: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: benchmarkMaterialLocations.id })
    .from(benchmarkMaterialLocations)
    .where(
      and(
        eq(benchmarkMaterialLocations.materialId, materialId),
        eq(benchmarkMaterialLocations.locationId, locationId),
        excludeId != null ? ne(benchmarkMaterialLocations.id, excludeId) : undefined,
      ),
    )
    .limit(1);
  return row != null;
}

export const benchmarkMaterialLocationsService = {
  async getCounts(): Promise<BenchmarkComboListCounts> {
    const [counts] = await db
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${benchmarkMaterialLocations.isActive})::int`,
        inactive: sql<number>`count(*) filter (where not ${benchmarkMaterialLocations.isActive})::int`,
      })
      .from(benchmarkMaterialLocations);

    return counts ?? { total: 0, active: 0, inactive: 0 };
  },

  async list(opts: BenchmarkCombosListParams): Promise<BenchmarkComboListResult> {
    const { page, pageSize, offset } = clampPagination(opts.page, opts.pageSize);
    const whereExpr = buildComboListWhere(opts);
    const orderBy = buildSortOrder(opts.sortBy, opts.sortOrder);

    const baseFrom = comboFrom().$dynamic();
    const countQuery = db
      .select({ total: sql<number>`count(*)::int` })
      .from(benchmarkMaterialLocations)
      .innerJoin(benchmarkMaterials, eq(benchmarkMaterialLocations.materialId, benchmarkMaterials.id))
      .innerJoin(benchmarkLocations, eq(benchmarkMaterialLocations.locationId, benchmarkLocations.id))
      .$dynamic();

    const [countRow] = whereExpr
      ? await countQuery.where(whereExpr)
      : await countQuery;

    const rowsQuery = whereExpr ? baseFrom.where(whereExpr) : baseFrom;
    const rows = await rowsQuery.orderBy(...orderBy).limit(pageSize).offset(offset);

    const counts = await this.getCounts();

    return {
      items: rows.map(mapComboRow),
      total: countRow?.total ?? 0,
      page,
      pageSize,
      counts,
    };
  },

  async listActiveLocations(): Promise<string[]> {
    const rows = await db
      .select({ name: benchmarkLocations.name })
      .from(benchmarkLocations)
      .where(eq(benchmarkLocations.isActive, true))
      .orderBy(asc(benchmarkLocations.name));
    return rows.map((r) => r.name);
  },

  async listActiveMaterials(): Promise<string[]> {
    const rows = await db
      .select({ name: benchmarkMaterials.name })
      .from(benchmarkMaterials)
      .where(eq(benchmarkMaterials.isActive, true))
      .orderBy(asc(benchmarkMaterials.name));
    return rows.map((r) => r.name);
  },

  async searchMaterials(search?: string): Promise<BenchmarkEntityOption[]> {
    const term = search?.trim();
    const rows = await db
      .select({ id: benchmarkMaterials.id, name: benchmarkMaterials.name })
      .from(benchmarkMaterials)
      .where(term ? ilike(benchmarkMaterials.name, `%${term}%`) : undefined)
      .orderBy(asc(benchmarkMaterials.name))
      .limit(50);
    return rows;
  },

  async searchLocations(search?: string): Promise<BenchmarkEntityOption[]> {
    const term = search?.trim();
    const rows = await db
      .select({ id: benchmarkLocations.id, name: benchmarkLocations.name })
      .from(benchmarkLocations)
      .where(term ? ilike(benchmarkLocations.name, `%${term}%`) : undefined)
      .orderBy(asc(benchmarkLocations.name))
      .limit(50);
    return rows;
  },

  async get(id: number): Promise<BenchmarkComboListRow | null> {
    const [row] = await comboFrom().where(eq(benchmarkMaterialLocations.id, id)).limit(1);
    return row ? mapComboRow(row) : null;
  },

  async create(
    input: CreateBenchmarkComboInput,
    userId?: number,
  ): Promise<BenchmarkComboListRow> {
    if (await findDuplicateCombo(input.materialId, input.locationId)) {
      throw new BenchmarkComboValidationError(
        BenchmarksValidationMessages.DUPLICATE_COMBO,
      );
    }

    const now = formatUtcNow();
    const [created] = await db
      .insert(benchmarkMaterialLocations)
      .values({
        materialId: input.materialId,
        locationId: input.locationId,
        currency: input.currency ?? BENCHMARK_BASE_CURRENCY,
        isActive: input.isActive ?? true,
        createdAt: now,
        createdBy: userId ?? null,
        updatedAt: now,
        updatedBy: userId ?? null,
      })
      .returning({ id: benchmarkMaterialLocations.id });

    if (!created) {
      throw new BenchmarkComboValidationError(BenchmarksErrorMessages.COMBO_CREATE_FAILED);
    }
    const result = await this.get(created.id);
    if (!result) throw new BenchmarkComboValidationError(BenchmarksErrorMessages.COMBO_CREATE_FAILED);
    return result;
  },

  async update(
    id: number,
    input: PatchBenchmarkComboInput,
    userId?: number,
  ): Promise<BenchmarkComboListRow> {
    const existing = await this.get(id);
    if (!existing) throw new BenchmarkComboNotFoundError(id);

    const materialId = input.materialId ?? existing.materialId;
    const locationId = input.locationId ?? existing.locationId;

    if (await findDuplicateCombo(materialId, locationId, id)) {
      throw new BenchmarkComboValidationError(
        BenchmarksValidationMessages.DUPLICATE_COMBO,
      );
    }

    const now = formatUtcNow();
    const patch: Partial<typeof benchmarkMaterialLocations.$inferInsert> = {
      updatedAt: now,
      updatedBy: userId ?? null,
    };
    if (input.materialId !== undefined) patch.materialId = input.materialId;
    if (input.locationId !== undefined) patch.locationId = input.locationId;
    if (input.isActive !== undefined) patch.isActive = input.isActive;

    const currencyChanged =
      input.currency !== undefined && input.currency !== existing.currency;
    if (currencyChanged) {
      patch.currency = input.currency;
      await loadRatesForCombo(id, input.currency!);
    }

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(benchmarkMaterialLocations)
        .set(patch)
        .where(eq(benchmarkMaterialLocations.id, id))
        .returning();
      if (row && currencyChanged) {
        const result = await rateBenchmarkPrices({ comboId: id }, tx);
        if (result.unratedRows > 0) {
          console.warn(
            `[benchmarks] combo ${id}: ${result.unratedRows} price(s) have no ${row.currency}/INR rate`,
          );
        }
      }
      return row;
    });

    if (!updated) throw new BenchmarkComboNotFoundError(id);
    const result = await this.get(id);
    if (!result) throw new BenchmarkComboNotFoundError(id);
    return result;
  },
};
