import { describe, expect, it } from "vitest";
import { buildAuctionListOrderBy } from "./list-order.js";

function flattenSqlText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (typeof value !== "object") return "";
  const obj = value as { queryChunks?: unknown[]; value?: unknown[] };
  if (Array.isArray(obj.queryChunks)) {
    return obj.queryChunks.map(flattenSqlText).join("");
  }
  if (Array.isArray(obj.value)) {
    return obj.value.map(flattenSqlText).join("");
  }
  return "";
}

describe("buildAuctionListOrderBy", () => {
  it("defaults and publishedAt sort by published_at descending with id tiebreak", () => {
    for (const sortBy of [undefined, "publishedAt"] as const) {
      const orderBy = buildAuctionListOrderBy(sortBy, "desc");
      expect(orderBy).toHaveLength(2);
      const primary = flattenSqlText(orderBy[0]);
      expect(primary.toLowerCase()).not.toMatch(/date_trunc|min\(/);
      expect(primary.toLowerCase()).toContain(" desc");
    }
  });

  it("keeps auctionDate as an explicit column sort", () => {
    const orderBy = buildAuctionListOrderBy("auctionDate", "desc");
    expect(orderBy).toHaveLength(2);
    const sqlText = flattenSqlText(orderBy[0]);
    expect(sqlText.toLowerCase()).toContain(" desc");
  });

  it("supports ascending auctionDate", () => {
    const orderBy = buildAuctionListOrderBy("auctionDate", "asc");
    const sqlText = flattenSqlText(orderBy[0]);
    expect(sqlText.toLowerCase()).toContain(" asc");
  });
});
