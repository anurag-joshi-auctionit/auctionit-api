import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  unionClientMaterialsMock,
  materialsGetMock,
  nextIdMock,
  selectMock,
  insertMock,
  updateMock,
} = vi.hoisted(() => ({
  unionClientMaterialsMock: vi.fn(),
  materialsGetMock: vi.fn(),
  nextIdMock: vi.fn(),
  selectMock: vi.fn(),
  insertMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock("../lib/array-set.js", () => ({
  unionClientMaterials: (...args: unknown[]) =>
    unionClientMaterialsMock(...args),
}));

vi.mock("./materials.service.js", () => ({
  MaterialNotFoundError: class MaterialNotFoundError extends Error {
    constructor() {
      super("Material not found");
      this.name = "MaterialNotFoundError";
    }
  },
  materialsService: {
    get: (...args: unknown[]) => materialsGetMock(...args),
  },
}));

vi.mock("./_id.js", () => ({
  nextId: (...args: unknown[]) => nextIdMock(...args),
}));

vi.mock("../db/index.js", () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
  },
}));

function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(async () => rows);
  chain.innerJoin = vi.fn(() => chain);
  chain.leftJoin = vi.fn(() => chain);
  chain.then = (
    resolve: (v: unknown) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(rows).then(resolve, reject);
  return chain;
}

function insertChain() {
  const chain: Record<string, unknown> = {};
  chain.values = vi.fn(async () => undefined);
  return chain;
}

function updateChain() {
  const chain: Record<string, unknown> = {};
  chain.set = vi.fn(() => chain);
  chain.where = vi.fn(async () => undefined);
  return chain;
}

const { itemsService } = await import("./items.service.js");
const { db } = await import("../db/index.js");

const detail = {
  itemId: 99,
  clientId: 5,
  clientName: "Acme",
  name: "Scrap",
  materialId: 11,
  materialLabel: "Metal",
  isActive: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("itemsService material → client union", () => {
  beforeEach(() => {
    unionClientMaterialsMock.mockReset().mockResolvedValue(true);
    materialsGetMock.mockReset().mockResolvedValue({ id: 11 });
    nextIdMock.mockReset().mockResolvedValue(99);
    selectMock.mockReset();
    insertMock.mockReset().mockReturnValue(insertChain());
    updateMock.mockReset().mockReturnValue(updateChain());
  });

  it("unions material onto client after create", async () => {
    selectMock
      .mockReturnValueOnce(selectChain([{ id: 5 }])) // client exists
      .mockReturnValue(selectChain([])); // unused fallback

    const getSpy = vi.spyOn(itemsService, "get").mockResolvedValue(detail);

    await itemsService.create(
      { clientId: 5, name: "Scrap", materialId: 11, isActive: true },
      7,
    );

    expect(unionClientMaterialsMock).toHaveBeenCalledWith(db, 5, [11], 7);
    getSpy.mockRestore();
  });

  it("unions material onto client after update that patches materialId", async () => {
    selectMock.mockReturnValueOnce(
      selectChain([{ id: 99, clientId: 5 }]),
    );

    const getSpy = vi.spyOn(itemsService, "get").mockResolvedValue({
      ...detail,
      materialId: 22,
    });

    await itemsService.update(99, { materialId: 22 }, 7);

    expect(unionClientMaterialsMock).toHaveBeenCalledWith(db, 5, [22], 7);
    getSpy.mockRestore();
  });

  it("does not union when update only changes name or isActive", async () => {
    selectMock
      .mockReturnValueOnce(selectChain([{ id: 99, clientId: 5 }])) // existing item
      .mockReturnValueOnce(selectChain([])); // name-uniqueness check — no conflict

    const getSpy = vi.spyOn(itemsService, "get").mockResolvedValue(detail);

    await itemsService.update(99, { name: "Renamed", isActive: false }, 7);

    expect(unionClientMaterialsMock).not.toHaveBeenCalled();
    getSpy.mockRestore();
  });
});
