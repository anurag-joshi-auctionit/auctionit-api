import {
  MaterialsErrorMessages,
  MaterialsValidationMessages,
} from "@auctionit/messages/masters";
import {
  asc,
  count,
  desc,
  eq,
  ilike,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type {
  CreateMaterialInput,
  MaterialsExportParams,
  MaterialsListParams,
  PatchMaterialInput,
} from "../lib/materials/schemas.js";
import { MATERIALS_EXPORT_MAX_ROWS } from "../lib/materials/export-constants.js";
import { db } from "../db/index.js";
import { materials } from "../db/schema/index.js";
import {
  activeInactiveStatus,
  clampPagination,
  combineConditions,
} from "./list-query.js";
import { formatUtcNow } from "@auctionit/lib/date";

const BREADCRUMB_SEPARATOR = " \u2192 ";

export type MaterialListItem = {
  id: number;
  label: string;
  parentId: number | null;
  parentLabel: string | null;
  breadcrumbLabel: string;
  depth: number;
  isLeaf: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MaterialListCounts = {
  total: number;
  active: number;
  inactive: number;
};

export type MaterialListResult = {
  items: MaterialListItem[];
  total: number;
  page: number;
  pageSize: number;
  counts: MaterialListCounts;
};

export class MaterialNotFoundError extends Error {
  constructor(id: number | string) {
    super(MaterialsErrorMessages.MATERIAL_NOT_FOUND(id));
    this.name = "MaterialNotFoundError";
  }
}

export class MaterialValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterialValidationError";
  }
}

type MaterialRow = typeof materials.$inferSelect;

function buildBreadcrumbs(rows: MaterialRow[]): {
  labelById: Map<number, string>;
  breadcrumbById: Map<number, string>;
  hasChildren: Set<number>;
} {
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const labelById = new Map(rows.map((r) => [r.id, r.label] as const));
  const breadcrumbById = new Map<number, string>();
  const hasChildren = new Set<number>();

  for (const r of rows) {
    if (r.parentId != null) hasChildren.add(r.parentId);
  }

  function chain(id: number): string {
    const cached = breadcrumbById.get(id);
    if (cached != null) return cached;
    const parts: string[] = [];
    let cursor: number | null = id;
    for (let i = 0; i < 64 && cursor != null; i++) {
      const node = byId.get(cursor);
      if (!node) break;
      parts.push(node.label);
      cursor = node.parentId;
    }
    const value = parts.reverse().join(BREADCRUMB_SEPARATOR);
    breadcrumbById.set(id, value);
    return value;
  }

  for (const r of rows) chain(r.id);

  return { labelById, breadcrumbById, hasChildren };
}

function toListItem(
  r: MaterialRow,
  ctx: ReturnType<typeof buildBreadcrumbs>,
): MaterialListItem {
  return {
    id: r.id,
    label: r.label,
    parentId: r.parentId,
    parentLabel:
      r.parentId != null ? (ctx.labelById.get(r.parentId) ?? null) : null,
    breadcrumbLabel: ctx.breadcrumbById.get(r.id) ?? r.label,
    depth: r.depth,
    isLeaf: !ctx.hasChildren.has(r.id),
    isActive: r.isActive,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

async function buildBreadcrumbLabelForRow(row: {
  id: number;
  label: string;
  parentId: number | null;
}): Promise<string> {
  const parts = [row.label];
  let cursor = row.parentId;
  for (let i = 0; i < 64 && cursor != null; i++) {
    const [parent] = await db
      .select({ label: materials.label, parentId: materials.parentId })
      .from(materials)
      .where(eq(materials.id, cursor))
      .limit(1);
    if (!parent) break;
    parts.unshift(parent.label);
    cursor = parent.parentId;
  }
  return parts.join(BREADCRUMB_SEPARATOR);
}

const parentMaterial = alias(materials, "parent_material");

function buildMaterialListWhere(
  opts: Omit<MaterialsListParams, "page" | "pageSize">,
): SQL | undefined {
  const search = opts.search?.trim();
  const statusCond = activeInactiveStatus(
    materials.isActive,
    opts.status === "all" ? undefined : opts.status,
  );

  const searchCond = search
    ? or(
        ilike(materials.label, `%${search}%`),
        ilike(parentMaterial.label, `%${search}%`),
      )
    : undefined;

  return combineConditions([statusCond, searchCond]);
}

function buildMaterialOrderBy(
  opts: Pick<MaterialsListParams, "sortBy" | "sortOrder">,
) {
  const sortBy = opts.sortBy ?? "label";
  const descOrder = opts.sortOrder === "desc";
  const col = (() => {
    switch (sortBy) {
      case "depth":
        return materials.depth;
      case "isActive":
        return materials.isActive;
      case "createdAt":
        return materials.createdAt;
      case "updatedAt":
        return materials.updatedAt;
      case "label":
      default:
        return materials.label;
    }
  })();
  return descOrder
    ? [desc(col), asc(materials.id)]
    : [asc(col), asc(materials.id)];
}

export const materialsService = {
  async getCounts(): Promise<MaterialListCounts> {
    const [counts] = await db
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${materials.isActive})::int`,
        inactive: sql<number>`count(*) filter (where not ${materials.isActive})::int`,
      })
      .from(materials);

    return counts ?? { total: 0, active: 0, inactive: 0 };
  },

  async listPaginated(opts: MaterialsListParams): Promise<MaterialListResult> {
    const { page, pageSize, offset } = clampPagination(opts.page, opts.pageSize);
    const whereExpr = buildMaterialListWhere(opts);
    const orderBy = buildMaterialOrderBy(opts);

    const baseFrom = () =>
      db
        .select({
          id: materials.id,
          label: materials.label,
          parentId: materials.parentId,
          parentLabel: parentMaterial.label,
          depth: materials.depth,
          isActive: materials.isActive,
          createdAt: materials.createdAt,
          updatedAt: materials.updatedAt,
          hasChild: sql<boolean>`exists (
            select 1 from materials c where c.parent_id = ${materials.id}
          )`,
        })
        .from(materials)
        .leftJoin(
          parentMaterial,
          eq(parentMaterial.id, materials.parentId),
        )
        .$dynamic();

    const countFrom = () =>
      db
        .select({ total: count() })
        .from(materials)
        .leftJoin(
          parentMaterial,
          eq(parentMaterial.id, materials.parentId),
        )
        .$dynamic();

    const [countRow] = whereExpr
      ? await countFrom().where(whereExpr)
      : await countFrom();

    const rows = await (whereExpr ? baseFrom().where(whereExpr) : baseFrom())
      .orderBy(...orderBy)
      .limit(pageSize)
      .offset(offset);

    const [counts, breadcrumbs] = await Promise.all([
      this.getCounts(),
      Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          breadcrumbLabel: await buildBreadcrumbLabelForRow({
            id: row.id,
            label: row.label,
            parentId: row.parentId,
          }),
        })),
      ),
    ]);
    const breadcrumbById = new Map(
      breadcrumbs.map((b) => [b.id, b.breadcrumbLabel] as const),
    );

    return {
      items: rows.map((row) => ({
        id: row.id,
        label: row.label,
        parentId: row.parentId,
        parentLabel: row.parentLabel ?? null,
        breadcrumbLabel: breadcrumbById.get(row.id) ?? row.label,
        depth: row.depth,
        isLeaf: !row.hasChild,
        isActive: row.isActive,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
      total: Number(countRow?.total ?? 0),
      page,
      pageSize,
      counts,
    };
  },

  async export(opts: MaterialsExportParams): Promise<MaterialListItem[]> {
    const whereExpr = buildMaterialListWhere(opts);
    const orderBy = buildMaterialOrderBy(opts);

    const baseFrom = () =>
      db
        .select({
          id: materials.id,
          label: materials.label,
          parentId: materials.parentId,
          parentLabel: parentMaterial.label,
          depth: materials.depth,
          isActive: materials.isActive,
          createdAt: materials.createdAt,
          updatedAt: materials.updatedAt,
          hasChild: sql<boolean>`exists (
            select 1 from materials c where c.parent_id = ${materials.id}
          )`,
        })
        .from(materials)
        .leftJoin(parentMaterial, eq(parentMaterial.id, materials.parentId))
        .$dynamic();

    const rows = await (whereExpr ? baseFrom().where(whereExpr) : baseFrom())
      .orderBy(...orderBy)
      .limit(MATERIALS_EXPORT_MAX_ROWS);

    const breadcrumbs = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        breadcrumbLabel: await buildBreadcrumbLabelForRow({
          id: row.id,
          label: row.label,
          parentId: row.parentId,
        }),
      })),
    );
    const breadcrumbById = new Map(
      breadcrumbs.map((b) => [b.id, b.breadcrumbLabel] as const),
    );

    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      parentId: row.parentId,
      parentLabel: row.parentLabel ?? null,
      breadcrumbLabel: breadcrumbById.get(row.id) ?? row.label,
      depth: row.depth,
      isLeaf: !row.hasChild,
      isActive: row.isActive,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  },

  async list(activeOnly = false): Promise<MaterialListItem[]> {
    const rows = await db
      .select()
      .from(materials)
      .orderBy(asc(materials.depth), asc(materials.label));

    const ctx = buildBreadcrumbs(rows);

    return rows
      .filter((r) => !activeOnly || r.isActive)
      .map((r) => toListItem(r, ctx));
  },

  async create(
    input: CreateMaterialInput,
    userId?: number,
  ): Promise<MaterialListItem> {
    let depth = 1;
    if (input.parentId != null) {
      const [parent] = await db
        .select()
        .from(materials)
        .where(eq(materials.id, input.parentId));
      if (!parent) throw new MaterialValidationError(MaterialsValidationMessages.PARENT_NOT_FOUND);
      depth = parent.depth + 1;
    }

    const now = formatUtcNow();
    const [created] = await db
      .insert(materials)
      .values({
        label: input.label,
        parentId: input.parentId,
        depth,
        isActive: input.isActive,
        createdAt: now,
        createdBy: userId ?? null,
        updatedAt: now,
        updatedBy: userId ?? null,
      })
      .returning();

    if (!created) throw new MaterialValidationError(MaterialsErrorMessages.CREATE_FAILED);
    return this.get(created.id);
  },

  async update(
    id: number,
    input: PatchMaterialInput,
    userId?: number,
  ): Promise<MaterialListItem> {
    const rows = await db.select().from(materials);
    const byId = new Map(rows.map((r) => [r.id, r] as const));
    const node = byId.get(id);
    if (!node) throw new MaterialNotFoundError(id);

    const childrenByParent = new Map<number, number[]>();
    for (const r of rows) {
      if (r.parentId != null) {
        const list = childrenByParent.get(r.parentId) ?? [];
        list.push(r.id);
        childrenByParent.set(r.parentId, list);
      }
    }

    const descendants = new Set<number>();
    const stack = [...(childrenByParent.get(id) ?? [])];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (descendants.has(cur)) continue;
      descendants.add(cur);
      stack.push(...(childrenByParent.get(cur) ?? []));
    }

    const reparenting =
      input.parentId !== undefined && input.parentId !== node.parentId;
    let depthDelta = 0;

    if (reparenting) {
      const nextParentId = input.parentId ?? null;
      if (nextParentId === id) {
        throw new MaterialValidationError(MaterialsValidationMessages.SELF_PARENT);
      }
      if (nextParentId != null && descendants.has(nextParentId)) {
        throw new MaterialValidationError(
          MaterialsValidationMessages.DESCENDANT_PARENT,
        );
      }
      let nextDepth = 1;
      if (nextParentId != null) {
        const nextParent = byId.get(nextParentId);
        if (!nextParent) {
          throw new MaterialValidationError(MaterialsValidationMessages.PARENT_NOT_FOUND);
        }
        nextDepth = nextParent.depth + 1;
      }
      depthDelta = nextDepth - node.depth;
    }

    const now = formatUtcNow();

    await db.transaction(async (tx) => {
      const patch: Partial<typeof materials.$inferInsert> = {
        updatedAt: now,
        updatedBy: userId ?? null,
      };
      if (input.label !== undefined) patch.label = input.label;
      if (input.isActive !== undefined) patch.isActive = input.isActive;
      if (reparenting) {
        patch.parentId = input.parentId ?? null;
        patch.depth = node.depth + depthDelta;
      }

      await tx.update(materials).set(patch).where(eq(materials.id, id));

      if (reparenting && depthDelta !== 0 && descendants.size > 0) {
        for (const descId of descendants) {
          const desc = byId.get(descId)!;
          await tx
            .update(materials)
            .set({
              depth: desc.depth + depthDelta,
              updatedAt: now,
              updatedBy: userId ?? null,
            })
            .where(eq(materials.id, descId));
        }
      }
    });

    return this.get(id);
  },

  async get(id: number): Promise<MaterialListItem> {
    const [row] = await db
      .select()
      .from(materials)
      .where(eq(materials.id, id))
      .limit(1);
    if (!row) throw new MaterialNotFoundError(id);

    let parentLabel: string | null = null;
    if (row.parentId != null) {
      const [parent] = await db
        .select({ label: materials.label })
        .from(materials)
        .where(eq(materials.id, row.parentId))
        .limit(1);
      parentLabel = parent?.label ?? null;
    }

    const [child] = await db
      .select({ id: materials.id })
      .from(materials)
      .where(eq(materials.parentId, id))
      .limit(1);

    return {
      id: row.id,
      label: row.label,
      parentId: row.parentId,
      parentLabel,
      breadcrumbLabel: await buildBreadcrumbLabelForRow(row),
      depth: row.depth,
      isLeaf: !child,
      isActive: row.isActive,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  },
};
