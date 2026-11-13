import { beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionsValidationMessages } from "@auctionit/messages/permissions";

const { selectMock, insertMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  insertMock: vi.fn(),
}));

vi.mock("../db/index.js", () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
  },
}));

const { RolesServiceError, rolesService } = await import("./roles.service.js");

/** A select chain that resolves to `rows` whether awaited directly or via `.limit()`. */
function mockSelect(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "leftJoin", "innerJoin", "orderBy"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.limit = vi.fn(async () => rows);
  Object.defineProperty(chain, "then", {
    value: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(ok, err),
  });
  selectMock.mockReturnValueOnce(chain);
}

function mockInsert(returning: unknown[] = []) {
  const values = vi.fn();
  const chain = {
    values,
    onConflictDoUpdate: vi.fn(async () => undefined),
    returning: vi.fn(async () => returning),
  };
  values.mockReturnValue(chain);
  insertMock.mockReturnValueOnce(chain);
  return values;
}

const adminRole = { id: 1, code: "admin", name: "Admin", isAdmin: true };

describe("rolesService.setRolePermissions on admin roles", () => {
  beforeEach(() => {
    selectMock.mockReset();
    insertMock.mockReset();
  });

  it("rejects disabling a governance key", async () => {
    mockSelect([adminRole]);
    const err = await rolesService
      .setRolePermissions(1, [{ key: "roles.write", enabled: false }])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RolesServiceError);
    expect((err as Error).message).toBe(
      PermissionsValidationMessages.ADMIN_GOVERNANCE_LOCKED,
    );
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("allows editing other keys and reports governance keys as enabled", async () => {
    mockSelect([adminRole]); // getById
    mockSelect([{ id: 10, key: "emd.refunds.verify" }]); // permission ids
    const values = mockInsert();
    mockSelect([adminRole]); // getRolePermissions → getById
    mockSelect([
      { permissionId: 10, key: "emd.refunds.verify", label: "", description: null, group: "EMD", enabled: false },
      { permissionId: 11, key: "roles.write", label: "", description: null, group: "Roles", enabled: false },
    ]);

    const result = await rolesService.setRolePermissions(1, [
      { key: "emd.refunds.verify", enabled: false },
    ]);

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ roleId: 1, permissionId: 10, enabled: false }),
    );
    const byKey = Object.fromEntries(result.permissions.map((p) => [p.key, p.enabled]));
    expect(byKey).toEqual({ "emd.refunds.verify": false, "roles.write": true });
  });
});

describe("rolesService.create", () => {
  beforeEach(() => {
    selectMock.mockReset();
    insertMock.mockReset();
  });

  it("seeds admin defaults (minus Accounts/HOD stages) for an isAdmin role", async () => {
    mockSelect([]); // getByCode → none
    mockInsert([{ id: 7, code: "super", isAdmin: true }]);
    mockSelect([
      { id: 1, key: "module.emd" },
      { id: 2, key: "emd.refunds.verify" },
      { id: 3, key: "emd.transfers.review" },
    ]);
    const matrixValues = mockInsert();

    await rolesService.create({ code: "super", name: "Super", isAdmin: true });

    const rows = matrixValues.mock.calls[0]![0] as { permissionId: number; enabled: boolean }[];
    expect(rows.map((r) => [r.permissionId, r.enabled])).toEqual([
      [1, true],
      [2, false],
      [3, false],
    ]);
  });

  it("seeds a disabled matrix for a non-admin role", async () => {
    mockSelect([]);
    mockInsert([{ id: 8, code: "ops", isAdmin: false }]);
    mockSelect([{ id: 1, key: "module.emd" }]);
    const matrixValues = mockInsert();

    await rolesService.create({ code: "ops", name: "Ops" });

    expect(matrixValues.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ permissionId: 1, enabled: false }),
    ]);
  });
});
