import {
  matchAgainstCorpus,
  normalizeFuzzyText,
  type FuzzyCorpusEntry,
  type FuzzyMatchResult,
} from "@auctionit/lib/fuzzy-match";
import { and, asc, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { auctionLotItems, items } from "../db/schema/index.js";

export type ItemMatchOption = {
  id: number;
  name: string;
};

/**
 * Build match corpus for a client:
 * 1. Historical lot-item materialName → itemId (latest row wins; history first)
 * 2. Active items.name (does not overwrite history keys)
 */
export async function pgLoadClientItemMatchCorpus(
  clientId: number,
): Promise<FuzzyCorpusEntry[]> {
  const historyRows = await db
    .select({
      materialName: auctionLotItems.materialName,
      itemId: auctionLotItems.itemId,
      id: auctionLotItems.id,
    })
    .from(auctionLotItems)
    .innerJoin(items, eq(items.id, auctionLotItems.itemId))
    .where(
      and(
        eq(auctionLotItems.clientId, clientId),
        eq(items.clientId, clientId),
        eq(items.isActive, true),
        isNotNull(auctionLotItems.materialName),
        ne(auctionLotItems.materialName, ""),
        isNotNull(auctionLotItems.itemId),
      ),
    )
    .orderBy(desc(auctionLotItems.id));

  const byNormalized = new Map<string, number>();
  for (const row of historyRows) {
    const name = row.materialName?.trim() ?? "";
    const itemId = row.itemId;
    if (!name || itemId == null) continue;
    const key = normalizeFuzzyText(name);
    if (!key || byNormalized.has(key)) continue;
    byNormalized.set(key, itemId);
  }

  const itemRows = await db
    .select({ id: items.id, name: items.name })
    .from(items)
    .where(
      and(
        eq(items.clientId, clientId),
        eq(items.isActive, true),
        isNotNull(items.name),
        sql`length(trim(${items.name})) > 0`,
      ),
    )
    .orderBy(asc(items.name));

  for (const row of itemRows) {
    const name = row.name?.trim() ?? "";
    if (!name) continue;
    const key = normalizeFuzzyText(name);
    if (!key || byNormalized.has(key)) continue;
    byNormalized.set(key, row.id);
  }

  return [...byNormalized.entries()].map(([normalizedName, itemId]) => ({
    normalizedName,
    itemId,
  }));
}

export async function pgLoadClientActiveItems(
  clientId: number,
): Promise<ItemMatchOption[]> {
  const rows = await db
    .select({ id: items.id, name: items.name })
    .from(items)
    .where(
      and(
        eq(items.clientId, clientId),
        eq(items.isActive, true),
        isNotNull(items.name),
        sql`length(trim(${items.name})) > 0`,
      ),
    )
    .orderBy(asc(items.name));

  return rows
    .filter((r): r is { id: number; name: string } => !!r.name?.trim())
    .map((r) => ({ id: r.id, name: r.name.trim() }));
}

export function matchMaterialNames(
  materialNames: string[],
  corpus: FuzzyCorpusEntry[],
): Map<string, FuzzyMatchResult> {
  const cache = new Map<string, FuzzyMatchResult>();
  for (const name of materialNames) {
    const key = normalizeFuzzyText(name);
    if (cache.has(key)) continue;
    cache.set(key, matchAgainstCorpus(name, corpus));
  }
  return cache;
}
