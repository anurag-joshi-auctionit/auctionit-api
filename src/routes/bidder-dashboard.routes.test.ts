import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import type { AuthUser } from "../services/auth.service.js";

vi.mock("../auth/middleware.js", () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      id: 10,
      userLoginName: "bidder1",
      name: "Bidder One",
      role: {
        id: 2,
        code: "bidder",
        name: "Bidder",
        description: null,
        isAdmin: false,
        createdAt: "2024-01-01T00:00:00.000Z",
      },
      bidderId: 42,
      permissions: ["module.portal-bidder-dashboard"],
    } as AuthUser;
    next();
  },
  requirePortalRole:
    () => (_req: Request, _res: Response, next: NextFunction) => {
      next();
    },
  requirePermission:
    () => (_req: Request, _res: Response, next: NextFunction) => {
      next();
    },
}));

vi.mock("../services/bidder-dashboard.service.js", () => ({
  bidderDashboardService: {
    listClients: vi.fn(),
    getLiftingFilters: vi.fn(),
    getLiftingDetails: vi.fn(),
  },
}));

const { default: bidderDashboardRouter } = await import(
  "./bidder-dashboard.js"
);
const { bidderDashboardService } = await import(
  "../services/bidder-dashboard.service.js"
);

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/bidder/dashboard", bidderDashboardRouter);
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    },
  );
  return app;
}

describe("GET /bidder/dashboard/lifting", () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    app = createTestApp();
    vi.mocked(bidderDashboardService.getLiftingDetails).mockResolvedValue({
      summary: {
        materialApprovedMt: 10,
        materialLiftedMt: 4,
        materialPendingMt: 6,
        approvedValue: 150_000,
        liftedValue: 60_000,
      },
      rows: [
        {
          clientId: 7,
          clientName: "Acme Corp",
          materialApprovedMt: 10,
          materialLiftedMt: 4,
          materialPendingMt: 6,
          approvedValue: 150_000,
          liftedValue: 60_000,
        },
      ],
      series: {
        grain: "month",
        points: [
          {
            period: "2026-01-01",
            periodLabel: "Jan-26",
            approvedQty: 10,
            liftedQty: 4,
            approvedAmount: 150_000,
            liftedAmount: 60_000,
          },
        ],
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when date range is missing", async () => {
    const res = await request(app).get("/bidder/dashboard/lifting");
    expect(res.status).toBe(400);
    expect(bidderDashboardService.getLiftingDetails).not.toHaveBeenCalled();
  });

  it("returns lifting details scoped to session bidder", async () => {
    const res = await request(app).get(
      "/bidder/dashboard/lifting?from=2026-01-01&to=2026-03-31&clientId=7",
    );
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.summary.materialApprovedMt).toBe(10);
    expect(bidderDashboardService.getLiftingDetails).toHaveBeenCalledWith(
      42,
      { from: "2026-01-01", to: "2026-03-31" },
      {
        clientId: 7,
        plantLocationId: undefined,
        itemId: undefined,
      },
    );
  });
});
