import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  ItemsErrorMessages,
  ItemsValidationMessages,
} from "@auctionit/messages/items";
import type {
  CreateItemInput,
  ItemsExportParams,
  ItemsListParams,
  PatchItemInput,
} from "../lib/items/schemas.js";
import { ITEMS_EXPORT_MAX_ROWS } from "../lib/items/export-constants.js";
import { db } from "../db/index.js";
import { benchmarkMaterials } from "../db/schema/benchmark-materials.js";
import { clients } from "../db/schema/clients.js";
import { items } from "../db/schema/items.js";
import { materials } from "../db/schema/materials.js";
import { nextId } from "./_id.js";
import {
  activeInactiveStatus,
  clampPagination,
  combineConditions,
} from "./list-query.js";
import {
  MAX_SELECT_ALL_IDS,
  mergeOptionsById,
  resolveOptionsLimit,
  toOptionIdsResult,
  type EntityOptionIdsResult,
} from "../lib/options-query.js";
import {
  MaterialNotFoundError,
  materialsService,
} from "./materials.service.js";
import { formatUtcNow } from "@auctionit/lib/date";
import { unionClientMaterials } from "../lib/array-set.js";

export type { ItemsListParams } from "../lib/items/schemas.js";

export type ItemListCounts = {
  total: number;
  active: number;
  inactive: number;
};

export type ItemListRow = {
  itemId: number;
  clientId: number;
  clientName: string;
  name: string | null;
  materialId: number | null;
  materialLabel: string | null;
  benchmarkMaterialId: number | null;
  benchmarkMaterialLabel: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string | null;
};

export type ItemListResult = {
  items: ItemListRow[];
  total: number;
  page: number;
  pageSize: number;
  counts: ItemListCounts;
};

export type ItemDetail = ItemListRow;

export class ItemNotFoundError extends Error {
  constructor(id: number | string) {
    super(ItemsErrorMessages.ITEM_NOT_FOUND);
    this.name = "ItemNotFoundError";
  }
}

export class ItemClientNotFoundError extends Error {
  constructor() {
    super(ItemsErrorMessages.CLIENT_NOT_FOUND);
    this.name = "ItemClientNotFoundError";
  }
}

export class ItemBenchmarkMaterialNotFoundError extends Error {
  constructor() {
    super(ItemsValidationMessages.BENCHMARK_MATERIAL_NOT_FOUND);
    this.name = "ItemBenchmarkMaterialNotFoundError";
  }
}

export class ItemDuplicateNameError extends Error {
  constructor() {
    super(ItemsValidationMessages.ITEM_NAME_EXISTS);
    this.name = "ItemDuplicateNameError";
  }
}

const BREADCRUMB_SEPARATOR = " \u2192 ";

const ITEM_SORT_FIELDS = new Set([
  "name",
  "clientName",
  "createdAt",
  "updatedAt",
  "itemId",
] as const);

function dateRange(
  column: typeof items.createdAt | typeof items.updatedAt,
  opts: {
    dateField?: "createdAt" | "updatedAt";
    dateFrom?: string;
    dateTo?: string;
  },
  field: "createdAt" | "updatedAt",
): SQL | undefined {
  if (opts.dateField !== field || !opts.dateFrom) return undefined;
  if (opts.dateTo) {
    return sql`${column}::date >= CAST(${opts.dateFrom} AS date) AND ${column}::date <= CAST(${opts.dateTo} AS date)`;
  }
  return sql`${column}::date >= CAST(${opts.dateFrom} AS date)`;
}

function buildSortOrder(
  sortBy: ItemsListParams["sortBy"],
  sortOrder: ItemsListParams["sortOrder"],
) {
  const field =
    sortBy && ITEM_SORT_FIELDS.has(sortBy) ? sortBy : ("createdAt" as const);
  const dir = sortOrder === "desc" ? desc : asc;

  switch (field) {
    case "name":
      return [dir(items.name)];
    case "clientName":
      return [dir(clients.companyName)];
    case "updatedAt":
      return [dir(items.updatedAt)];
    case "itemId":
      return [dir(items.id)];
    case "createdAt":
    default:
      return [dir(items.createdAt)];
  }
}

function buildItemListWhere(
  opts: Omit<ItemsListParams, "page" | "pageSize">,
): SQL | undefined {
  const search = opts.search?.trim();
  const conditions = [
    activeInactiveStatus(items.isActive, opts.status ?? "all"),
    opts.clientId != null ? eq(items.clientId, opts.clientId) : undefined,
    opts.materialId != null ? eq(items.materialId, opts.materialId) : undefined,
    dateRange(items.createdAt, opts, "createdAt"),
    dateRange(items.updatedAt, opts, "updatedAt"),
  ];

  if (search) {
    const term = `%${search}%`;
    conditions.push(
      or(
        ilike(sql`cast(${items.id} as text)`, term),
        ilike(items.name, term),
        ilike(clients.companyName, term),
        ilike(materials.label, term),
      )!,
    );
  }

  return combineConditions(conditions);
}

function clientScope(clientId?: number): SQL | undefined {
  return clientId != null ? eq(items.clientId, clientId) : undefined;
}

async function assertUniqueItemName(
  clientId: number,
  name: string,
  excludeId?: number,
): Promise<void> {
  const conditions = and(
    eq(items.clientId, clientId),
    sql`lower(${items.name}) = lower(${name})`,
    excludeId != null ? ne(items.id, excludeId) : undefined,
  );

  const [existing] = await db
    .select({ id: items.id })
    .from(items)
    .where(conditions)
    .limit(1);

  if (existing) {
    throw new ItemDuplicateNameError();
  }
}

async function breadcrumbLabelsForMaterialIds(
  materialIds: number[],
): Promise<Map<number, string>> {
  const uniqueIds = [...new Set(materialIds)];
  if (uniqueIds.length === 0) return new Map();

  const byId = new Map<
    number,
    { id: number; label: string; parentId: number | null }
  >();
  let pending = new Set(uniqueIds);

  while (pending.size > 0) {
    const batch = [...pending];
    pending = new Set();

    const rows = await db
      .select({
        id: materials.id,
        label: materials.label,
        parentId: materials.parentId,
      })
      .from(materials)
      .where(inArray(materials.id, batch));

    for (const row of rows) {
      byId.set(row.id, row);
      if (row.parentId != null && !byId.has(row.parentId)) {
        pending.add(row.parentId);
      }
    }
  }

  const result = new Map<number, string>();
  for (const id of uniqueIds) {
    const parts: string[] = [];
    let cursor: number | null = id;
    for (let i = 0; i < 64 && cursor != null; i++) {
      const node = byId.get(cursor);
      if (!node) break;
      parts.push(node.label);
      cursor = node.parentId;
    }
    result.set(id, parts.reverse().join(BREADCRUMB_SEPARATOR));
  }

  return result;
}

function mapRow(
  row: {
    itemId: number;
    clientId: number;
    clientName: string;
    name: string | null;
    materialId: number | null;
    benchmarkMaterialId: number | null;
    benchmarkMaterialLabel: string | null;
    isActive: boolean;
    createdAt: string;
    updatedAt: string | null;
  },
  materialLabels: Map<number, string>,
): ItemListRow {
  return {
    ...row,
    materialLabel:
      row.materialId != null
        ? (materialLabels.get(row.materialId) ?? null)
        : null,
  };
}

const itemListSelect = {
  itemId: items.id,
  clientId: items.clientId,
  clientName: clients.companyName,
  name: items.name,
  materialId: items.materialId,
  benchmarkMaterialId: items.benchmarkMaterialId,
  benchmarkMaterialLabel: benchmarkMaterials.name,
  isActive: items.isActive,
  createdAt: items.createdAt,
  updatedAt: items.updatedAt,
};

function itemListFrom() {
  return db
    .select(itemListSelect)
    .from(items)
    .innerJoin(clients, eq(items.clientId, clients.id))
    .leftJoin(materials, eq(items.materialId, materials.id))
    .leftJoin(benchmarkMaterials, eq(items.benchmarkMaterialId, benchmarkMaterials.id));
}

function itemCountFrom() {
  return db
    .select({ total: sql<number>`count(*)::int` })
    .from(items)
    .innerJoin(clients, eq(items.clientId, clients.id))
    .leftJoin(materials, eq(items.materialId, materials.id));
}

export const itemsService = {
  async getCounts(clientId?: number): Promise<ItemListCounts> {
    const scope = clientScope(clientId);
    const [counts] = await db
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${items.isActive})::int`,
        inactive: sql<number>`count(*) filter (where not ${items.isActive})::int`,
      })
      .from(items)
      .where(scope);

    return counts ?? { total: 0, active: 0, inactive: 0 };
  },

  async listActiveOptions(opts: {
    clientId: number;
    q?: string;
    limit?: number;
    ids?: number[];
  }): Promise<Array<{ id: number; name: string | null }>> {
    const q = opts.q?.trim() ?? "";
    const ids = opts.ids ?? [];
    const clientId = opts.clientId;
    const limit = resolveOptionsLimit(q, opts.limit);

    const selectShape = {
      id: items.id,
      name: items.name,
    };

    const byIds =
      ids.length > 0
        ? await db
            .select(selectShape)
            .from(items)
            .where(
              and(
                eq(items.clientId, clientId),
                eq(items.isActive, true),
                inArray(items.id, ids),
              ),
            )
            .orderBy(asc(items.name))
        : [];

    const searchWhere = q
      ? and(
          eq(items.clientId, clientId),
          eq(items.isActive, true),
          or(
            ilike(items.name, `%${q}%`),
            sql`cast(${items.id} as text) ilike ${`%${q}%`}`,
          ),
        )
      : and(eq(items.clientId, clientId), eq(items.isActive, true));

    const searchQuery = db
      .select(selectShape)
      .from(items)
      .where(searchWhere)
      .orderBy(asc(items.name));

    const searched =
      limit != null ? await searchQuery.limit(limit) : await searchQuery;

    const merged = mergeOptionsById(byIds, searched, limit);
    merged.sort((a, b) =>
      (a.name ?? "").localeCompare(b.name ?? "", undefined, {
        sensitivity: "base",
      }),
    );
    return merged;
  },

  async listActiveOptionIds(opts: {
    clientId: number;
    q?: string;
  }): Promise<EntityOptionIdsResult> {
    const q = opts.q?.trim() ?? "";
    const clientId = opts.clientId;
    const searchWhere = q
      ? and(
          eq(items.clientId, clientId),
          eq(items.isActive, true),
          or(
            ilike(items.name, `%${q}%`),
            sql`cast(${items.id} as text) ilike ${`%${q}%`}`,
          ),
        )
      : and(eq(items.clientId, clientId), eq(items.isActive, true));

    const [countRow] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(items)
      .where(searchWhere);

    const total = countRow?.total ?? 0;
    const rows = await db
      .select({ id: items.id })
      .from(items)
      .where(searchWhere)
      .orderBy(asc(items.name))
      .limit(MAX_SELECT_ALL_IDS);

    return toOptionIdsResult(
      rows.map((r) => r.id),
      total,
    );
  },

  async list(opts: ItemsListParams): Promise<ItemListResult> {
    const { page, pageSize, offset } = clampPagination(opts.page, opts.pageSize);
    const whereExpr = buildItemListWhere(opts);
    const orderBy = buildSortOrder(opts.sortBy, opts.sortOrder);

    const countQuery = itemCountFrom().$dynamic();
    const [countRow] = whereExpr
      ? await countQuery.where(whereExpr)
      : await countQuery;

    const rowsQuery = itemListFrom().$dynamic();
    const rows = await (whereExpr ? rowsQuery.where(whereExpr) : rowsQuery)
      .orderBy(...orderBy)
      .limit(pageSize)
      .offset(offset);

    const materialIds = rows
      .map((row) => row.materialId)
      .filter((id): id is number => id != null);

    const [counts, materialLabels] = await Promise.all([
      this.getCounts(opts.clientId),
      breadcrumbLabelsForMaterialIds(materialIds),
    ]);

    return {
      items: rows.map((row) => mapRow(row, materialLabels)),
      total: countRow?.total ?? 0,
      page,
      pageSize,
      counts,
    };
  },

  async export(opts: ItemsExportParams): Promise<ItemListRow[]> {
    const whereExpr = buildItemListWhere(opts);
    const orderBy = buildSortOrder(opts.sortBy, opts.sortOrder);

    const rowsQuery = itemListFrom().$dynamic();
    const rows = await (whereExpr ? rowsQuery.where(whereExpr) : rowsQuery)
      .orderBy(...orderBy)
      .limit(ITEMS_EXPORT_MAX_ROWS);

    const materialIds = rows
      .map((row) => row.materialId)
      .filter((id): id is number => id != null);
    const materialLabels = await breadcrumbLabelsForMaterialIds(materialIds);

    return rows.map((row) => mapRow(row, materialLabels));
  },

  async get(itemId: number): Promise<ItemDetail | null> {
    const [row] = await itemListFrom()
      .where(eq(items.id, itemId))
      .limit(1);

    if (!row) return null;

    const materialLabels = await breadcrumbLabelsForMaterialIds(
      row.materialId != null ? [row.materialId] : [],
    );
    return mapRow(row, materialLabels);
  },

  async create(input: CreateItemInput, userId?: number): Promise<ItemDetail> {
    const [client] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.id, input.clientId))
      .limit(1);
    if (!client) throw new ItemClientNotFoundError();

    await assertUniqueItemName(input.clientId, input.name);

    if (input.materialId != null) {
      try {
        await materialsService.get(input.materialId);
      } catch (e) {
        if (e instanceof MaterialNotFoundError) throw e;
        throw e;
      }
    }

    if (input.benchmarkMaterialId != null) {
      const [benchmarkMaterial] = await db
        .select({ id: benchmarkMaterials.id })
        .from(benchmarkMaterials)
        .where(eq(benchmarkMaterials.id, input.benchmarkMaterialId))
        .limit(1);
      if (!benchmarkMaterial) throw new ItemBenchmarkMaterialNotFoundError();
    }

    const id = await nextId("items", "id");
    const now = formatUtcNow();

    await db.insert(items).values({
      id,
      clientId: input.clientId,
      name: input.name,
      materialId: input.materialId ?? null,
      benchmarkMaterialId: input.benchmarkMaterialId ?? null,
      isActive: input.isActive ?? true,
      createdAt: now,
      createdBy: userId ?? null,
      updatedAt: now,
      updatedBy: userId ?? null,
    });

    if (input.materialId != null) {
      await unionClientMaterials(
        db,
        input.clientId,
        [input.materialId],
        userId ?? null,
      );
    }

    const created = await this.get(id);
    if (!created) throw new ItemNotFoundError(id);
    return created;
  },

  async update(
    itemId: number,
    input: PatchItemInput,
    userId?: number,
  ): Promise<ItemDetail> {
    const [existing] = await db
      .select({ id: items.id, clientId: items.clientId })
      .from(items)
      .where(eq(items.id, itemId))
      .limit(1);
    if (!existing) throw new ItemNotFoundError(itemId);

    if (input.name !== undefined) {
      await assertUniqueItemName(existing.clientId, input.name, itemId);
    }

    if (input.materialId !== undefined && input.materialId != null) {
      try {
        await materialsService.get(input.materialId);
      } catch (e) {
        if (e instanceof MaterialNotFoundError) throw e;
        throw e;
      }
    }

    if (
      input.benchmarkMaterialId !== undefined &&
      input.benchmarkMaterialId != null
    ) {
      const [benchmarkMaterial] = await db
        .select({ id: benchmarkMaterials.id })
        .from(benchmarkMaterials)
        .where(eq(benchmarkMaterials.id, input.benchmarkMaterialId))
        .limit(1);
      if (!benchmarkMaterial) throw new ItemBenchmarkMaterialNotFoundError();
    }

    const now = formatUtcNow();
    const patch: Partial<typeof items.$inferInsert> = {
      updatedAt: now,
      updatedBy: userId ?? null,
    };
    if (input.name !== undefined) patch.name = input.name;
    if (input.materialId !== undefined) patch.materialId = input.materialId;
    if (input.benchmarkMaterialId !== undefined)
      patch.benchmarkMaterialId = input.benchmarkMaterialId;
    if (input.isActive !== undefined) patch.isActive = input.isActive;

    await db.update(items).set(patch).where(eq(items.id, itemId));

    if (input.materialId != null) {
      await unionClientMaterials(
        db,
        existing.clientId,
        [input.materialId],
        userId ?? null,
      );
    }

    const updated = await this.get(itemId);
    if (!updated) throw new ItemNotFoundError(itemId);
    return updated;
  },
};
