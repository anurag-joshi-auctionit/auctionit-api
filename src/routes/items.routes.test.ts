import { ItemsValidationMessages } from "@auctionit/messages/items";
import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../auth/middleware.js", () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      id: 1,
      userLoginName: "admin",
      name: "Admin",
      role: { isAdmin: true, code: "admin" },
    };
    next();
  },
  requireAdmin: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
  requireAnyPermission:
    () => (_req: Request, _res: Response, next: NextFunction) => {
      next();
    },
  requirePermission:
    () => (_req: Request, _res: Response, next: NextFunction) => {
      next();
    },
}));

const { createApp } = await import("../app.js");
const { itemsService } = await import("../services/items.service.js");

describe("GET /items", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns paginated items with server-side params", async () => {
    const result = {
      items: [],
      total: 0,
      page: 1,
      pageSize: 10,
      counts: { total: 0, active: 0, inactive: 0 },
    };
    const list = vi.spyOn(itemsService, "list").mockResolvedValue(result);

    const res = await request(app).get(
      "/items?page=1&pageSize=10&search=scrap&status=active&clientId=5&sortBy=name&sortOrder=asc",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 1,
        pageSize: 10,
        search: "scrap",
        status: "active",
        clientId: 5,
        sortBy: "name",
        sortOrder: "asc",
      }),
    );
  });
});

describe("GET /items/stats", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns counts optionally scoped by clientId", async () => {
    const getCounts = vi
      .spyOn(itemsService, "getCounts")
      .mockResolvedValue({ total: 3, active: 2, inactive: 1 });

    const res = await request(app).get("/items/stats?clientId=7");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 3, active: 2, inactive: 1 });
    expect(getCounts).toHaveBeenCalledWith(7);
  });
});

describe("POST /items", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(app).post("/items").send({
      clientId: 1,
      name: "",
      materialId: 1,
    });

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.name).toContain(
      ItemsValidationMessages.NAME_REQUIRED,
    );
  });

  it("returns 400 when materialId is missing", async () => {
    const res = await request(app).post("/items").send({
      clientId: 1,
      name: "Scrap drums",
    });

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.materialId).toContain(
      ItemsValidationMessages.MATERIAL_REQUIRED,
    );
  });

  it("creates an item", async () => {
    const created = {
      itemId: 99,
      clientId: 1,
      clientName: "Acme",
      name: "Scrap drums",
      materialId: 1,
      materialLabel: "Metal → Scrap",
      isActive: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const create = vi.spyOn(itemsService, "create").mockResolvedValue(created);

    const res = await request(app).post("/items").send({
      clientId: 1,
      name: "Scrap drums",
      materialId: 1,
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(created);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 1,
        name: "Scrap drums",
        materialId: 1,
      }),
      1,
    );
  });
});

describe("PATCH /items/:id", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates an item", async () => {
    const updated = {
      itemId: 10,
      clientId: 1,
      clientName: "Acme",
      name: "Updated name",
      materialId: 2,
      materialLabel: "Metal → Scrap",
      isActive: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const patch = vi.spyOn(itemsService, "update").mockResolvedValue(updated);

    const res = await request(app)
      .patch("/items/10")
      .send({ name: "Updated name", isActive: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(updated);
    expect(patch).toHaveBeenCalledWith(
      10,
      expect.objectContaining({ name: "Updated name", isActive: false }),
      1,
    );
  });

  it("returns 400 when materialId is cleared", async () => {
    const res = await request(app)
      .patch("/items/10")
      .send({ materialId: null });

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.materialId).toContain(
      ItemsValidationMessages.MATERIAL_REQUIRED,
    );
  });
});
