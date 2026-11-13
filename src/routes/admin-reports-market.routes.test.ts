import { AdminReportsMessages } from "@auctionit/messages/reports";
import express, { type NextFunction, type Request, type Response } from "express";
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
  requirePermission:
    () => (_req: Request, _res: Response, next: NextFunction) => {
      next();
    },
  requireAnyPermission:
    () => (_req: Request, _res: Response, next: NextFunction) => {
      next();
    },
}));

vi.mock("../lib/market-report/build-market-report-docx.js", () => ({
  buildMarketReportDocx: vi.fn(async () => Buffer.from("docx")),
  buildMarketReportFilename: () => "Market Report.docx",
}));

const { default: adminReportsRouter } = await import("./admin-reports.js");
const { marketReportService } = await import(
  "../services/market-report.service.js"
);

const marketMaking = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Buyers" }] }],
};

const validBody = {
  clientId: 1,
  auctionId: 2,
  from: "2026-01-01",
  to: "2026-03-31",
  benchmarks: [
    { material: "CR Coil", comboId: 10 },
    { material: "HR Coil", comboId: 11 },
    { material: null, comboId: null },
  ],
  marketMaking,
};

const expectedParams = {
  clientId: 1,
  auctionId: 2,
  from: "2026-01-01",
  to: "2026-03-31",
  comboIds: [10, 11],
  marketMaking,
};

async function exportReport(app: express.Express, body: unknown) {
  return request(app).post("/admin/reports/market/export").send(body as object);
}

describe("POST /admin/reports/market/export", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use("/admin/reports", adminReportsRouter);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["clientId", AdminReportsMessages.CLIENT_REQUIRED],
    ["auctionId", AdminReportsMessages.AUCTION_REQUIRED],
    ["from", AdminReportsMessages.DATE_RANGE_REQUIRED],
    ["to", AdminReportsMessages.DATE_RANGE_REQUIRED],
    ["benchmarks", AdminReportsMessages.MARKET_BENCHMARK_ROW_REQUIRED],
    ["marketMaking", AdminReportsMessages.MARKET_MAKING_REQUIRED],
  ])("rejects a missing %s", async (field, message) => {
    const body: Record<string, unknown> = { ...validBody };
    delete body[field];
    const res = await exportReport(app, body);
    expect(res.status).toBe(400);
    expect(res.body.fieldErrors[field]).toContain(message);
  });

  it("rejects when every benchmark row is blank", async () => {
    const res = await exportReport(app, {
      ...validBody,
      benchmarks: [
        { material: null, comboId: null },
        { material: null, comboId: null },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(AdminReportsMessages.MARKET_BENCHMARK_ROW_REQUIRED);
  });

  it("rejects a material without a location", async () => {
    const res = await exportReport(app, {
      ...validBody,
      benchmarks: [
        { material: "CR Coil", comboId: 10 },
        { material: "HR Coil", comboId: null },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      AdminReportsMessages.MARKET_BENCHMARK_ROW_INCOMPLETE,
    );
  });

  it("rejects the same benchmark selected twice", async () => {
    const res = await exportReport(app, {
      ...validBody,
      benchmarks: [
        { material: "CR Coil", comboId: 10 },
        { material: "CR Coil", comboId: 10 },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(AdminReportsMessages.MARKET_BENCHMARK_DUPLICATE);
  });

  it("reports the first missing field in the error message", async () => {
    const res = await exportReport(app, {
      benchmarks: [{ material: null, comboId: null }],
      marketMaking: null,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(AdminReportsMessages.CLIENT_REQUIRED);
  });

  it("rejects Market Making with only whitespace", async () => {
    const res = await exportReport(app, {
      ...validBody,
      marketMaking: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "   " }] },
        ],
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(AdminReportsMessages.MARKET_MAKING_REQUIRED);
  });

  it("returns the DOCX built from the filled rows, ignoring blank ones", async () => {
    const build = vi
      .spyOn(marketReportService, "build")
      .mockResolvedValue({} as Awaited<ReturnType<typeof marketReportService.build>>);
    const res = await exportReport(app, validBody);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain(
      "wordprocessingml.document",
    );
    expect(res.headers["content-disposition"]).toContain("Market Report.docx");
    expect(build).toHaveBeenCalledWith(expectedParams);
  });
});
