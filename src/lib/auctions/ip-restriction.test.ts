import { describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { LiveBidMessages } from "@auctionit/messages/auctions";
import {
  checkIpRestriction,
  findIpClaimant,
  normalizeClientIp,
} from "./ip-restriction.js";

const dialect = new PgDialect();

function stubTx(claimantRows: { bidder_id: number }[] = []) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const execute = vi.fn(async (query: SQL) => {
    const q = dialect.sqlToQuery(query);
    queries.push(q);
    return { rows: q.sql.includes("pg_advisory_xact_lock") ? [] : claimantRows };
  });
  const tx = { execute } as unknown as Parameters<typeof checkIpRestriction>[0];
  return { tx, execute, queries };
}

describe("normalizeClientIp", () => {
  it("returns plain IPv4 unchanged", () => {
    expect(normalizeClientIp("1.2.3.4")).toBe("1.2.3.4");
  });

  it("strips the legacy ' | device' suffix", () => {
    expect(normalizeClientIp("1.2.3.4 | Desktop")).toBe("1.2.3.4");
    expect(normalizeClientIp("1.2.3.4|Mobile")).toBe("1.2.3.4");
  });

  it("unwraps IPv4-mapped IPv6", () => {
    expect(normalizeClientIp("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeClientIp("::FFFF:10.0.0.1")).toBe("10.0.0.1");
  });

  it("keeps real IPv6", () => {
    expect(normalizeClientIp("2001:db8::1")).toBe("2001:db8::1");
  });

  it("returns null for missing or blank values", () => {
    expect(normalizeClientIp(null)).toBeNull();
    expect(normalizeClientIp(undefined)).toBeNull();
    expect(normalizeClientIp("")).toBeNull();
    expect(normalizeClientIp("   ")).toBeNull();
    expect(normalizeClientIp(" | Desktop")).toBeNull();
  });
});

describe("checkIpRestriction", () => {
  const base = { auctionId: 10, bidderId: 1 };

  it("does not touch the DB when the auction flag is off", async () => {
    const { tx, execute } = stubTx([{ bidder_id: 2 }]);
    for (const enabled of [false, null, undefined]) {
      expect(
        await checkIpRestriction(tx, { ...base, enabled, ip: "1.2.3.4" }),
      ).toBe(false);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not touch the DB when there is no usable IP", async () => {
    const { tx, execute } = stubTx([{ bidder_id: 2 }]);
    expect(await checkIpRestriction(tx, { ...base, enabled: true, ip: null })).toBe(
      false,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("locks (auction, ip) before looking up claimants", async () => {
    const { tx, queries } = stubTx();
    await checkIpRestriction(tx, { ...base, enabled: true, ip: "1.2.3.4" });
    expect(queries).toHaveLength(2);
    expect(queries[0]!.sql).toContain("pg_advisory_xact_lock");
    expect(queries[0]!.params).toContain("ipr:10:1.2.3.4");
    expect(queries[1]!.sql).toContain("auction_tnc_acceptances");
    expect(queries[1]!.sql).toContain("auction_bid_logs");
  });

  it("allows when no other bidder has used the IP", async () => {
    const { tx } = stubTx([]);
    expect(
      await checkIpRestriction(tx, { ...base, enabled: true, ip: "1.2.3.4" }),
    ).toBe(false);
  });

  it("blocks when another bidder has used the IP", async () => {
    const { tx } = stubTx([{ bidder_id: 2 }]);
    expect(
      await checkIpRestriction(tx, { ...base, enabled: true, ip: "1.2.3.4" }),
    ).toBe(true);
  });
});

describe("findIpClaimant query", () => {
  it("excludes the acting bidder and IP-restricted rejections, scoped to the auction", async () => {
    const { tx, queries } = stubTx([{ bidder_id: 7 }]);
    const claimant = await findIpClaimant(tx, {
      auctionId: 10,
      bidderId: 1,
      ip: "1.2.3.4",
    });
    expect(claimant).toBe(7);
    const q = queries[0]!;
    expect(q.sql).toMatch(/bidder_id <> \$\d+/);
    expect(q.sql).toContain("btrim(split_part(ip, '|', 1))");
    expect(q.sql).toContain("reject_reason IS DISTINCT FROM");
    expect(q.params).toEqual(
      expect.arrayContaining([10, 1, "1.2.3.4", LiveBidMessages.IP_RESTRICTED]),
    );
  });

  it("returns null when nobody else has used the IP", async () => {
    const { tx } = stubTx([]);
    expect(
      await findIpClaimant(tx, { auctionId: 10, bidderId: 1, ip: "1.2.3.4" }),
    ).toBeNull();
  });
});
