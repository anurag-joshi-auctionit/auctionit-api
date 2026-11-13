import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_GOVERNANCE_KEYS } from "@auctionit/authz";

const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));

vi.mock("../db/index.js", () => ({
  db: { select: (...args: unknown[]) => selectMock(...args) },
}));

const { hasAnyPermission, hasPermission, loadEnabledPermissionKeys } =
  await import("./permissions.js");

function mockMatrixRows(keys: string[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.where = vi.fn(async () => keys.map((key) => ({ key })));
  selectMock.mockReturnValueOnce(chain);
}

function user(isAdmin: boolean, permissions: string[]) {
  return {
    role: { id: 1, code: isAdmin ? "admin" : "kam", name: "R", isAdmin },
    isOwner: false,
    permissions,
  } as unknown as Parameters<typeof hasPermission>[0];
}

describe("loadEnabledPermissionKeys", () => {
  beforeEach(() => selectMock.mockReset());

  it("reads the matrix for admin roles and adds governance keys", async () => {
    mockMatrixRows(["module.emd", "emd.refunds.review"]);
    const keys = await loadEnabledPermissionKeys(1, true);
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(keys).toEqual(
      expect.arrayContaining(["module.emd", "emd.refunds.review", ...ADMIN_GOVERNANCE_KEYS]),
    );
    expect(keys).not.toContain("emd.refunds.verify");
  });

  it("does not duplicate governance keys already enabled", async () => {
    mockMatrixRows(["roles.read"]);
    const keys = await loadEnabledPermissionKeys(1, true);
    expect(keys.filter((k) => k === "roles.read")).toHaveLength(1);
  });

  it("returns only matrix keys for non-admin roles", async () => {
    mockMatrixRows(["emd.refunds.verify"]);
    expect(await loadEnabledPermissionKeys(2, false)).toEqual(["emd.refunds.verify"]);
  });
});

describe("hasPermission / hasAnyPermission", () => {
  it("does not let admin roles bypass the matrix", () => {
    const admin = user(true, ["emd.refunds.review"]);
    expect(hasPermission(admin, "emd.refunds.review")).toBe(true);
    expect(hasPermission(admin, "emd.refunds.verify")).toBe(false);
    expect(hasAnyPermission(admin, ["emd.refunds.pay", "emd.forfeitures.review"])).toBe(false);
  });

  it("checks non-admin roles against their keys", () => {
    const accounts = user(false, ["emd.refunds.verify"]);
    expect(hasPermission(accounts, "emd.refunds.verify")).toBe(true);
    expect(hasAnyPermission(accounts, ["emd.refunds.pay", "emd.refunds.verify"])).toBe(true);
  });
});
