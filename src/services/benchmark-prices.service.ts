import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";
import type {
  BenchmarkPriceHistoryParams,
  BenchmarkPricesBulkInput,
  BenchmarkPricesGridParams,
  BenchmarkPricesListParams,
} from "../lib/benchmarks/schemas.js";
import { db } from "../db/index.js";
import {
  benchmarkMaterialLocations,
  type BenchmarkCurrency,
} from "../db/schema/benchmark-material-locations.js";
import { benchmarkMaterials } from "../db/schema/benchmark-materials.js";
import { benchmarkLocations } from "../db/schema/benchmark-locations.js";
import { benchmarkPrices } from "../db/schema/benchmark-prices.js";
import { convertToInr } from "../lib/fx/convert.js";
import {
  BenchmarkComboNotFoundError,
  benchmarkMaterialLocationsService,
} from "./benchmark-material-locations.service.js";
import { fxRatesService, type RateToInr } from "./fx-rates.service.js";
import { clampPagination, combineConditions } from "./list-query.js";
import { formatUtcNow } from "@auctionit/lib/date";

/** FX snapshot stored with each price; `price` is in `currency`. */
export type BenchmarkPriceFx = {
  currency: BenchmarkCurrency;
  exchangeRate: string;
  priceInr: string;
  rateDate: string | null;
};

export type BenchmarkPriceListRow = BenchmarkPriceFx & {
  id: number;
  benchmarkMaterialLocationId: number;
  material: string;
  location: string;
  benchmarkDate: string;
  price: string;
  createdAt: string;
  updatedAt: string | null;
};

export type BenchmarkPriceListResult = {
  items: BenchmarkPriceListRow[];
  total: number;
  page: number;
  pageSize: number;
};

export type BenchmarkPriceGridRow = {
  benchmarkMaterialLocationId: number;
  material: string;
  location: string;
  /** Combo currency — the currency `price` is entered in. */
  currency: BenchmarkCurrency;
  price: string | null;
  priceId: number | null;
  exchangeRate: string | null;
  priceInr: string | null;
  rateDate: string | null;
};

export type BenchmarkPriceGridResult = {
  benchmarkDate: string;
  items: BenchmarkPriceGridRow[];
  filledCount: number;
  totalCount: number;
  page: number;
  pageSize: number;
};

export type BenchmarkPriceHistoryRow = BenchmarkPriceFx & {
  id: number;
  benchmarkDate: string;
  price: string;
  createdAt: string;
  updatedAt: string | null;
};

const fxColumns = {
  currency: benchmarkPrices.currency,
  exchangeRate: benchmarkPrices.exchangeRate,
  priceInr: benchmarkPrices.priceInr,
  rateDate: benchmarkPrices.rateDate,
};

function mapFx(row: {
  currency: BenchmarkCurrency;
  exchangeRate: string;
  priceInr: string;
  rateDate: string | null;
}): BenchmarkPriceFx {
  return {
    currency: row.currency,
    exchangeRate: String(row.exchangeRate),
    priceInr: String(row.priceInr),
    rateDate: row.rateDate != null ? String(row.rateDate) : null,
  };
}

const PRICE_SORT_FIELDS = new Set([
  "benchmarkDate",
  "price",
  "material",
  "location",
  "createdAt",
] as const);

function buildPriceSortOrder(
  sortBy: BenchmarkPricesListParams["sortBy"],
  sortOrder: BenchmarkPricesListParams["sortOrder"],
) {
  const field =
    sortBy && PRICE_SORT_FIELDS.has(sortBy) ? sortBy : ("benchmarkDate" as const);
  const dir = sortOrder === "desc" ? desc : asc;

  switch (field) {
    case "price":
      return [dir(benchmarkPrices.price)];
    case "material":
      return [dir(benchmarkMaterials.name)];
    case "location":
      return [dir(benchmarkLocations.name)];
    case "createdAt":
      return [dir(benchmarkPrices.createdAt)];
    case "benchmarkDate":
    default:
      return [dir(benchmarkPrices.benchmarkDate)];
  }
}

function buildPriceListWhere(opts: BenchmarkPricesListParams): SQL | undefined {
  const conditions = [
    opts.comboId != null
      ? eq(benchmarkPrices.benchmarkMaterialLocationId, opts.comboId)
      : undefined,
    opts.benchmarkDate
      ? eq(benchmarkPrices.benchmarkDate, opts.benchmarkDate)
      : undefined,
    opts.dateFrom ? gte(benchmarkPrices.benchmarkDate, opts.dateFrom) : undefined,
    opts.dateTo ? lte(benchmarkPrices.benchmarkDate, opts.dateTo) : undefined,
    opts.location
      ? ilike(benchmarkLocations.name, `%${opts.location}%`)
      : undefined,
    opts.material
      ? ilike(benchmarkMaterials.name, `%${opts.material}%`)
      : undefined,
  ];
  return combineConditions(conditions);
}

function buildGridWhere(opts: BenchmarkPricesGridParams): SQL {
  const conditions = [eq(benchmarkMaterialLocations.isActive, true)];
  if (opts.materials?.length) {
    conditions.push(inArray(benchmarkMaterials.name, opts.materials));
  }
  if (opts.locations?.length) {
    conditions.push(inArray(benchmarkLocations.name, opts.locations));
  }
  return and(...conditions)!;
}

function buildGridSortOrder(
  sortBy: BenchmarkPricesGridParams["sortBy"],
  sortOrder: BenchmarkPricesGridParams["sortOrder"],
) {
  const dir = sortOrder === "desc" ? desc : asc;
  if (sortBy === "location") {
    return [dir(benchmarkLocations.name), asc(benchmarkMaterials.name)];
  }
  return [dir(benchmarkMaterials.name), asc(benchmarkLocations.name)];
}

function priceJoinCondition(benchmarkDate: string): SQL {
  return and(
    eq(
      benchmarkPrices.benchmarkMaterialLocationId,
      benchmarkMaterialLocations.id,
    ),
    eq(benchmarkPrices.benchmarkDate, benchmarkDate),
  )!;
}

function gridFrom(benchmarkDate: string) {
  return db
    .select({
      benchmarkMaterialLocationId: benchmarkMaterialLocations.id,
      material: benchmarkMaterials.name,
      location: benchmarkLocations.name,
      currency: benchmarkMaterialLocations.currency,
      price: benchmarkPrices.price,
      priceId: benchmarkPrices.id,
      exchangeRate: benchmarkPrices.exchangeRate,
      priceInr: benchmarkPrices.priceInr,
      rateDate: benchmarkPrices.rateDate,
    })
    .from(benchmarkMaterialLocations)
    .innerJoin(benchmarkMaterials, eq(benchmarkMaterialLocations.materialId, benchmarkMaterials.id))
    .innerJoin(benchmarkLocations, eq(benchmarkMaterialLocations.locationId, benchmarkLocations.id))
    .leftJoin(benchmarkPrices, priceJoinCondition(benchmarkDate));
}

function gridCountFrom(benchmarkDate: string) {
  return db
    .select({
      totalCount: sql<number>`count(*)::int`,
      filledCount: sql<number>`count(${benchmarkPrices.id})::int`,
    })
    .from(benchmarkMaterialLocations)
    .innerJoin(benchmarkMaterials, eq(benchmarkMaterialLocations.materialId, benchmarkMaterials.id))
    .innerJoin(benchmarkLocations, eq(benchmarkMaterialLocations.locationId, benchmarkLocations.id))
    .leftJoin(benchmarkPrices, priceJoinCondition(benchmarkDate));
}

export const benchmarkPricesService = {
  async list(opts: BenchmarkPricesListParams): Promise<BenchmarkPriceListResult> {
    const { page, pageSize, offset } = clampPagination(opts.page, opts.pageSize);
    const whereExpr = buildPriceListWhere(opts);
    const orderBy = buildPriceSortOrder(opts.sortBy, opts.sortOrder);

    const baseFrom = db
      .select({
        id: benchmarkPrices.id,
        benchmarkMaterialLocationId: benchmarkPrices.benchmarkMaterialLocationId,
        material: benchmarkMaterials.name,
        location: benchmarkLocations.name,
        benchmarkDate: benchmarkPrices.benchmarkDate,
        price: benchmarkPrices.price,
        ...fxColumns,
        createdAt: benchmarkPrices.createdAt,
        updatedAt: benchmarkPrices.updatedAt,
      })
      .from(benchmarkPrices)
      .innerJoin(
        benchmarkMaterialLocations,
        eq(
          benchmarkPrices.benchmarkMaterialLocationId,
          benchmarkMaterialLocations.id,
        ),
      )
      .innerJoin(benchmarkMaterials, eq(benchmarkMaterialLocations.materialId, benchmarkMaterials.id))
      .innerJoin(benchmarkLocations, eq(benchmarkMaterialLocations.locationId, benchmarkLocations.id))
      .$dynamic();

    const countQuery = db
      .select({ total: sql<number>`count(*)::int` })
      .from(benchmarkPrices)
      .innerJoin(
        benchmarkMaterialLocations,
        eq(
          benchmarkPrices.benchmarkMaterialLocationId,
          benchmarkMaterialLocations.id,
        ),
      )
      .innerJoin(benchmarkMaterials, eq(benchmarkMaterialLocations.materialId, benchmarkMaterials.id))
      .innerJoin(benchmarkLocations, eq(benchmarkMaterialLocations.locationId, benchmarkLocations.id))
      .$dynamic();

    const [countRow] = whereExpr
      ? await countQuery.where(whereExpr)
      : await countQuery;

    const rowsQuery = whereExpr ? baseFrom.where(whereExpr) : baseFrom;
    const rows = await rowsQuery.orderBy(...orderBy).limit(pageSize).offset(offset);

    return {
      items: rows.map((row) => ({
        ...row,
        ...mapFx(row),
        benchmarkDate: String(row.benchmarkDate),
        price: String(row.price),
      })),
      total: countRow?.total ?? 0,
      page,
      pageSize,
    };
  },

  async grid(opts: BenchmarkPricesGridParams): Promise<BenchmarkPriceGridResult> {
    const { page, pageSize, offset } = clampPagination(opts.page, opts.pageSize);
    const whereExpr = buildGridWhere(opts);
    const orderBy = buildGridSortOrder(opts.sortBy, opts.sortOrder);

    const countQuery = gridCountFrom(opts.benchmarkDate).$dynamic();
    const [counts] = await countQuery.where(whereExpr);

    if ((counts?.totalCount ?? 0) === 0) {
      return {
        benchmarkDate: opts.benchmarkDate,
        items: [],
        filledCount: 0,
        totalCount: 0,
        page,
        pageSize,
      };
    }

    const rowsQuery = gridFrom(opts.benchmarkDate).$dynamic();
    const rows = await rowsQuery
      .where(whereExpr)
      .orderBy(...orderBy)
      .limit(pageSize)
      .offset(offset);

    return {
      benchmarkDate: opts.benchmarkDate,
      items: rows.map((row) => ({
        benchmarkMaterialLocationId: row.benchmarkMaterialLocationId,
        material: row.material,
        location: row.location,
        currency: row.currency,
        price: row.price != null ? String(row.price) : null,
        priceId: row.priceId,
        exchangeRate: row.exchangeRate != null ? String(row.exchangeRate) : null,
        priceInr: row.priceInr != null ? String(row.priceInr) : null,
        rateDate: row.rateDate != null ? String(row.rateDate) : null,
      })),
      filledCount: counts?.filledCount ?? 0,
      totalCount: counts?.totalCount ?? 0,
      page,
      pageSize,
    };
  },

  async bulkUpsert(
    input: BenchmarkPricesBulkInput,
    userId?: number,
  ): Promise<{ upserted: number }> {
    const comboIds = [
      ...new Set(input.items.map((item) => item.benchmarkMaterialLocationId)),
    ];
    const combos = await db
      .select({
        id: benchmarkMaterialLocations.id,
        currency: benchmarkMaterialLocations.currency,
      })
      .from(benchmarkMaterialLocations)
      .where(inArray(benchmarkMaterialLocations.id, comboIds));
    const currencyByCombo = new Map(combos.map((c) => [c.id, c.currency]));
    const missing = comboIds.find((id) => !currencyByCombo.has(id));
    if (missing != null) throw new BenchmarkComboNotFoundError(missing);

    const rateByCurrency = new Map<BenchmarkCurrency, RateToInr>();
    for (const currency of new Set(currencyByCombo.values())) {
      rateByCurrency.set(
        currency,
        await fxRatesService.getRateToInr(currency, input.benchmarkDate),
      );
    }

    const now = formatUtcNow();
    let upserted = 0;

    await db.transaction(async (tx) => {
      for (const item of input.items) {
        const currency = currencyByCombo.get(item.benchmarkMaterialLocationId)!;
        const fx = rateByCurrency.get(currency)!;
        const price = item.price.toFixed(2);
        const priced = {
          price,
          currency,
          exchangeRate: fx.rate,
          priceInr: convertToInr(price, fx.rate),
          rateDate: fx.rateDate,
        };

        await tx
          .insert(benchmarkPrices)
          .values({
            benchmarkMaterialLocationId: item.benchmarkMaterialLocationId,
            benchmarkDate: input.benchmarkDate,
            ...priced,
            createdAt: now,
            createdBy: userId ?? null,
            updatedAt: now,
            updatedBy: userId ?? null,
          })
          .onConflictDoUpdate({
            target: [
              benchmarkPrices.benchmarkMaterialLocationId,
              benchmarkPrices.benchmarkDate,
            ],
            set: {
              ...priced,
              updatedAt: now,
              updatedBy: userId ?? null,
            },
          });
        upserted += 1;
      }
    });

    return { upserted };
  },

  async history(
    comboId: number,
    opts: BenchmarkPriceHistoryParams,
  ): Promise<BenchmarkPriceHistoryRow[]> {
    const combo = await benchmarkMaterialLocationsService.get(comboId);
    if (!combo) throw new BenchmarkComboNotFoundError(comboId);

    const conditions = [eq(benchmarkPrices.benchmarkMaterialLocationId, comboId)];
    if (opts.dateFrom) {
      conditions.push(gte(benchmarkPrices.benchmarkDate, opts.dateFrom));
    }
    if (opts.dateTo) {
      conditions.push(lte(benchmarkPrices.benchmarkDate, opts.dateTo));
    }

    const limit = opts.limit ?? 90;
    const rows = await db
      .select({
        id: benchmarkPrices.id,
        benchmarkDate: benchmarkPrices.benchmarkDate,
        price: benchmarkPrices.price,
        ...fxColumns,
        createdAt: benchmarkPrices.createdAt,
        updatedAt: benchmarkPrices.updatedAt,
      })
      .from(benchmarkPrices)
      .where(and(...conditions))
      .orderBy(desc(benchmarkPrices.benchmarkDate))
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      benchmarkDate: String(row.benchmarkDate),
      price: String(row.price),
      ...mapFx(row),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  },
};
