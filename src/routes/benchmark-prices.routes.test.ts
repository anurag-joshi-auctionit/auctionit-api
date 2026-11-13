import {
  BenchmarksErrorMessages,
  BenchmarksValidationMessages,
} from "@auctionit/messages/benchmarks";
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
const { benchmarkPricesService } = await import(
  "../services/benchmark-prices.service.js"
);
const { FxRateUnavailableError } = await import(
  "../services/fx-rates.service.js"
);

describe("GET /benchmark-prices/grid", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns grid rows for a benchmark date", async () => {
    const result = {
      benchmarkDate: "2026-07-02",
      items: [
        {
          benchmarkMaterialLocationId: 1,
          material: "HMS 80:20",
          location: "Mumbai",
          currency: "INR" as const,
          price: "42000.00",
          priceId: 10,
          exchangeRate: "1.000000",
          priceInr: "42000.00",
          rateDate: null,
        },
        {
          benchmarkMaterialLocationId: 2,
          material: "Copper",
          location: "LME$",
          currency: "USD" as const,
          price: "9013.08",
          priceId: 11,
          exchangeRate: "95.970000",
          priceInr: "864985.29",
          rateDate: "2026-07-01",
        },
      ],
      filledCount: 2,
      totalCount: 2,
      page: 1,
      pageSize: 10,
    };
    const grid = vi.spyOn(benchmarkPricesService, "grid").mockResolvedValue(result);

    const res = await request(app).get(
      "/benchmark-prices/grid?benchmarkDate=2026-07-02&locations=Mumbai&materials=HMS%2080:20",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
    expect(grid).toHaveBeenCalledWith(
      expect.objectContaining({
        benchmarkDate: "2026-07-02",
        locations: ["Mumbai"],
        materials: ["HMS 80:20"],
        page: 1,
        pageSize: 10,
      }),
    );
  });

  it("returns 400 when benchmark date is missing", async () => {
    const res = await request(app).get("/benchmark-prices/grid");

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.benchmarkDate).toContain(
      BenchmarksValidationMessages.DATE_REQUIRED,
    );
  });
});

describe("POST /benchmark-prices/bulk", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 when items array is empty", async () => {
    const res = await request(app).post("/benchmark-prices/bulk").send({
      benchmarkDate: "2026-07-02",
      items: [],
    });

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors.items).toContain(
      BenchmarksValidationMessages.AT_LEAST_ONE_PRICE,
    );
  });

  it("bulk upserts benchmark prices", async () => {
    const bulkUpsert = vi
      .spyOn(benchmarkPricesService, "bulkUpsert")
      .mockResolvedValue({ upserted: 2 });

    const res = await request(app)
      .post("/benchmark-prices/bulk")
      .send({
        benchmarkDate: "2026-07-02",
        items: [
          { benchmarkMaterialLocationId: 1, price: 42000 },
          { benchmarkMaterialLocationId: 2, price: 38000 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ upserted: 2 });
    expect(bulkUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        benchmarkDate: "2026-07-02",
        items: expect.arrayContaining([
          expect.objectContaining({ benchmarkMaterialLocationId: 1, price: 42000 }),
        ]),
      }),
      1,
    );
  });

  it("returns 503 when the exchange rate is unavailable", async () => {
    vi.spyOn(benchmarkPricesService, "bulkUpsert").mockRejectedValue(
      new FxRateUnavailableError("USD", "2026-07-02"),
    );

    const res = await request(app)
      .post("/benchmark-prices/bulk")
      .send({
        benchmarkDate: "2026-07-02",
        items: [{ benchmarkMaterialLocationId: 2, price: 9013.08 }],
      });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: BenchmarksErrorMessages.FX_RATE_UNAVAILABLE,
    });
  });
});
