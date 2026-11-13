import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { istDateOnly } from "@auctionit/lib/date";
import {
  AdminReportsMessages,
  LiftingReportExportMessages,
  RevenueReportExportMessages,
} from "@auctionit/messages/reports";
import type { PermissionKey } from "@auctionit/authz";
import {
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from "../auth/middleware.js";
import { closedDateRangeQuerySchema } from "../lib/closed-auction-date-range.js";
import {
  buildRevenueReportFilename,
  buildRevenueReportXlsx,
} from "../lib/admin-reports/revenue-report-xlsx.js";
import {
  buildLiftingReportFilename,
  buildLiftingReportXlsx,
} from "../lib/admin-reports/lifting-report-xlsx.js";
import { encodeSseEvent } from "../lib/import/sse.js";
import {
  ReportExportBusyError,
  ReportExportConflictError,
  reportExportsService,
  type ReportExportEvent,
  type ReportExportProgressFn,
  type ReportExportType,
} from "../services/report-exports.service.js";
import {
  liftingReportService,
  type LiftingReportParams,
} from "../services/lifting-report.service.js";
import {
  revenueReportService,
  type RevenueReportParams,
} from "../services/revenue-report.service.js";
import {
  buildAdminBidDetailsReportFilename,
  buildAdminBidDetailsReportXlsx,
  buildAuctionDetailsReportFilename,
  buildAuctionDetailsReportXlsx,
  buildAuctionOverviewReportFilename,
  buildAuctionOverviewReportXlsx,
  buildBenchmarkReportFilename,
  buildBenchmarkReportXlsx,
  buildBidOverviewReportFilename,
  buildBidOverviewReportXlsx,
  buildBidderOverviewReportFilename,
  buildBidderOverviewReportXlsx,
  buildBidderDetailsReportFilename,
  buildBidderDetailsReportXlsx,
  buildSealedBidReportFilename,
  buildSealedBidReportXlsx,
  buildSubscriptionReportFilename,
  buildSubscriptionReportXlsx,
} from "../lib/admin-reports/export-xlsx.js";
import {
  auctionReportTitle,
  dateRangeReportTitle,
  reportGeneratedAt,
} from "../lib/reports/report-title.js";
import { zodValidationErrorBody } from "../lib/validation-error.js";
import {
  AdminReportsNotFoundError,
  adminReportsService,
  type BidOverviewMode,
} from "../services/admin-reports.service.js";
import {
  benchmarkReportService,
  type BenchmarkReportParams,
} from "../services/benchmark-report.service.js";
import {
  MarketReportValidationError,
  marketReportService,
  type MarketReportParams,
} from "../services/market-report.service.js";
import { sealedBidReportService } from "../services/sealed-bid-report.service.js";
import { subscriptionReportService } from "../services/subscription-report.service.js";
import {
  buildMarketReportDocx,
  buildMarketReportFilename,
} from "../lib/market-report/build-market-report-docx.js";
import {
  hasRichTextContent,
  isRichTextWithinLimits,
  richTextNodeSchema,
  type RichTextNode,
} from "../lib/market-report/rich-text.js";

const router = Router();
router.use(requireAuth);
router.use(requirePermission("module.reports"));

const AUCTION_LOOKUP_REPORT_PERMISSIONS: readonly PermissionKey[] = [
  "reports.bid-overview",
  "reports.bid-details",
  "reports.bidder-overview",
  "reports.bidder-details",
  "reports.auction-overview",
  "reports.auction-details",
];

const REPORT_EXPORT_PERMISSIONS: Record<ReportExportType, PermissionKey> = {
  revenue: "reports.revenue",
  lifting: "reports.lifting",
};

router.use("/auctions", requireAnyPermission(AUCTION_LOOKUP_REPORT_PERMISSIONS));
router.use("/bid-overview", requirePermission("reports.bid-overview"));
router.use("/bid-details", requirePermission("reports.bid-details"));
router.use("/bidder-overview", requirePermission("reports.bidder-overview"));
router.use("/bidder-details", requirePermission("reports.bidder-details"));
router.use("/auction-overview", requirePermission("reports.auction-overview"));
router.use("/auction-details", requirePermission("reports.auction-details"));
router.use("/subscription", requirePermission("reports.subscription"));
router.use("/benchmark", requirePermission("reports.benchmark"));
router.use("/market", requirePermission("reports.market"));
router.use("/sealed-bids", requirePermission("reports.sealed-bids"));
router.use("/revenue", requirePermission("reports.revenue"));
router.use("/lifting", requirePermission("reports.lifting"));
// Unknown / foreign jobs fall through so the handlers answer 404 / 410.
router.use("/exports/:jobId", (req, res, next) => {
  const job = reportExportsService.get(req.params.jobId, req.user!.id);
  if (!job) {
    next();
    return;
  }
  return requirePermission(REPORT_EXPORT_PERMISSIONS[job.reportType])(
    req,
    res,
    next,
  );
});

/** Comma-separated positive ints, e.g. `1,2,3`. Empty / omitted → []. */
const optionalIdListSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => {
    if (value == null) return [] as number[];
    const raw = Array.isArray(value) ? value.join(",") : value;
    if (!raw.trim()) return [] as number[];
    return [
      ...new Set(
        raw
          .split(",")
          .map((part) => Number(part.trim()))
          .filter((n) => Number.isInteger(n) && n > 0),
      ),
    ];
  });

const auctionsQuerySchema = closedDateRangeQuerySchema.and(
  z.object({
    clientIds: optionalIdListSchema,
  }),
);

const bidOverviewQuerySchema = closedDateRangeQuerySchema.and(
  z.object({
    clientIds: optionalIdListSchema,
    auctionIds: optionalIdListSchema,
    bidMode: z.enum(["bid", "no-bid"]).optional(),
  }),
);

const bidderOverviewQuerySchema = closedDateRangeQuerySchema.and(
  z.object({
    clientIds: optionalIdListSchema,
    auctionIds: optionalIdListSchema,
  }),
);

const auctionOverviewQuerySchema = bidderOverviewQuerySchema;

const liftingOverviewQuerySchema = z.object({
  clientIds: optionalIdListSchema,
});

const liftingExportBodySchema = z.object({
  clientIds: z
    .array(z.number().int().positive())
    .optional()
    .transform((ids) => [...new Set(ids ?? [])]),
});

const subscriptionReportQuerySchema = closedDateRangeQuerySchema.and(
  z.object({
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().positive().default(10),
  }),
);

const bidDetailsQuerySchema = z.object({
  clientId: z.coerce.number().int().positive({
    message: AdminReportsMessages.CLIENT_REQUIRED,
  }),
  auctionId: z.coerce.number().int().positive({
    message: AdminReportsMessages.AUCTION_REQUIRED,
  }),
});

const sealedBidAuctionsQuerySchema = closedDateRangeQuerySchema.and(
  z.object({
    clientId: z.coerce.number().int().positive({
      message: AdminReportsMessages.CLIENT_REQUIRED,
    }),
  }),
);

const MAX_BENCHMARK_RANGE_DAYS = 366;

const benchmarkReportQuerySchema = closedDateRangeQuerySchema.and(
  z.object({
    material: z
      .string({
        required_error: AdminReportsMessages.BENCHMARK_MATERIAL_REQUIRED,
        invalid_type_error: AdminReportsMessages.BENCHMARK_MATERIAL_REQUIRED,
      })
      .trim()
      .min(1, AdminReportsMessages.BENCHMARK_MATERIAL_REQUIRED)
      .max(500, AdminReportsMessages.BENCHMARK_MATERIAL_REQUIRED),
  }),
);

function inclusiveDayCount(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/** Sends a 400 and returns null when the query is invalid. */
function parseBenchmarkReportQuery(
  req: import("express").Request,
  res: import("express").Response,
): BenchmarkReportParams | null {
  const parsed = benchmarkReportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        AdminReportsMessages.VALIDATION_FAILED,
      ),
    );
    return null;
  }
  const { from, to, material } = parsed.data;
  if (!from || !to) {
    res.status(400).json({ error: AdminReportsMessages.DATE_RANGE_REQUIRED });
    return null;
  }
  if (inclusiveDayCount(from, to) > MAX_BENCHMARK_RANGE_DAYS) {
    res
      .status(400)
      .json({ error: AdminReportsMessages.BENCHMARK_DATE_RANGE_TOO_LONG });
    return null;
  }
  return { from, to, material };
}

const MAX_MARKET_BENCHMARK_ROWS = 10;

const marketAuctionsQuerySchema = z.object({
  clientId: z.coerce.number().int().positive({
    message: AdminReportsMessages.CLIENT_REQUIRED,
  }),
});

function requiredIdSchema(message: string) {
  return z.coerce
    .number({ required_error: message, invalid_type_error: message })
    .int(message)
    .positive(message);
}

const requiredDateSchema = z
  .string({
    required_error: AdminReportsMessages.DATE_RANGE_REQUIRED,
    invalid_type_error: AdminReportsMessages.DATE_RANGE_REQUIRED,
  })
  .min(1, AdminReportsMessages.DATE_RANGE_REQUIRED);

const marketBenchmarkRowSchema = z.object({
  material: z.string().trim().nullish(),
  comboId: z.coerce
    .number()
    .int(AdminReportsMessages.MARKET_BENCHMARK_INVALID)
    .positive(AdminReportsMessages.MARKET_BENCHMARK_INVALID)
    .nullish(),
});

/**
 * Blank rows are ignored; a material without a location is rejected.
 * Resolves to the selected combo ids.
 */
const marketBenchmarksSchema = z
  .array(marketBenchmarkRowSchema, {
    required_error: AdminReportsMessages.MARKET_BENCHMARK_ROW_REQUIRED,
    invalid_type_error: AdminReportsMessages.MARKET_BENCHMARK_ROW_REQUIRED,
  })
  .max(MAX_MARKET_BENCHMARK_ROWS, AdminReportsMessages.MARKET_BENCHMARK_ROWS_MAX)
  .superRefine((rows, ctx) => {
    if (rows.some((r) => r.material && r.comboId == null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: AdminReportsMessages.MARKET_BENCHMARK_ROW_INCOMPLETE,
      });
      return;
    }
    const ids = rows.flatMap((r) => (r.comboId != null ? [r.comboId] : []));
    if (ids.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: AdminReportsMessages.MARKET_BENCHMARK_ROW_REQUIRED,
      });
    } else if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: AdminReportsMessages.MARKET_BENCHMARK_DUPLICATE,
      });
    }
  })
  .transform((rows) =>
    rows.flatMap((r) => (r.comboId != null ? [r.comboId] : [])),
  );

const marketReportBodySchema = z
  .object({
    clientId: requiredIdSchema(AdminReportsMessages.CLIENT_REQUIRED),
    auctionId: requiredIdSchema(AdminReportsMessages.AUCTION_REQUIRED),
    from: requiredDateSchema,
    to: requiredDateSchema,
    benchmarks: marketBenchmarksSchema,
    marketMaking: z
      .unknown()
      .refine((value) => value != null, {
        message: AdminReportsMessages.MARKET_MAKING_REQUIRED,
      })
      .pipe(
        richTextNodeSchema
          .refine(isRichTextWithinLimits, {
            message: AdminReportsMessages.MARKET_MAKING_INVALID,
          })
          .refine(hasRichTextContent, {
            message: AdminReportsMessages.MARKET_MAKING_REQUIRED,
          }),
      ),
  })
  .and(closedDateRangeQuerySchema);

type MarketReportRequest = MarketReportParams & {
  marketMaking: RichTextNode;
};

/** Sends a 400 and returns null when the body is invalid. */
function parseMarketReportBody(
  req: import("express").Request,
  res: import("express").Response,
): MarketReportRequest | null {
  const parsed = marketReportBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        parsed.error.issues[0]?.message ?? AdminReportsMessages.VALIDATION_FAILED,
      ),
    );
    return null;
  }
  const { from, to, clientId, auctionId, benchmarks, marketMaking } =
    parsed.data;
  if (inclusiveDayCount(from, to) > MAX_BENCHMARK_RANGE_DAYS) {
    res
      .status(400)
      .json({ error: AdminReportsMessages.BENCHMARK_DATE_RANGE_TOO_LONG });
    return null;
  }
  return {
    clientId,
    auctionId,
    from,
    to,
    comboIds: benchmarks,
    marketMaking,
  };
}

function handleReportError(
  err: unknown,
  res: import("express").Response,
  next: import("express").NextFunction,
) {
  if (err instanceof AdminReportsNotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof MarketReportValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  next(err);
}

function sendXlsx(
  res: import("express").Response,
  buffer: Buffer,
  filename: string,
) {
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`,
  );
  res.setHeader("Cache-Control", "no-store");
  res.send(buffer);
}

router.get("/auctions", async (req, res, next) => {
  const parsed = auctionsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        AdminReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  if (!parsed.data.from || !parsed.data.to) {
    res.status(400).json({ error: AdminReportsMessages.DATE_RANGE_REQUIRED });
    return;
  }
  if (parsed.data.clientIds.length === 0) {
    res.status(400).json({ error: AdminReportsMessages.CLIENT_REQUIRED });
    return;
  }
  try {
    res.json(
      await adminReportsService.listAuctions(parsed.data.clientIds, {
        from: parsed.data.from,
        to: parsed.data.to,
      }),
    );
  } catch (e) {
    handleReportError(e, res, next);
  }
});

router.get("/bid-overview", async (req, res, next) => {
  const parsed = bidOverviewQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        AdminReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  if (!parsed.data.from || !parsed.data.to) {
    res.status(400).json({ error: AdminReportsMessages.DATE_RANGE_REQUIRED });
    return;
  }
  try {
    res.json(
      await adminReportsService.bidOverviewReport({
        from: parsed.data.from,
        to: parsed.data.to,
        clientIds: parsed.data.clientIds,
        auctionIds: parsed.data.auctionIds,
        bidMode: parsed.data.bidMode as BidOverviewMode | undefined,
      }),
    );
  } catch (e) {
    handleReportError(e, res, next);
  }
});

router.get("/bid-overview/export", async (req, res, next) => {
  const parsed = bidOverviewQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        AdminReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  if (!parsed.data.from || !parsed.data.to) {
    res.status(400).json({ error: AdminReportsMessages.DATE_RANGE_REQUIRED });
    return;
  }
  try {
    const rows = await adminReportsService.bidOverviewReport({
      from: parsed.data.from,
      to: parsed.data.to,
      clientIds: parsed.data.clientIds,
      auctionIds: parsed.data.auctionIds,
      bidMode: parsed.data.bidMode as BidOverviewMode | undefined,
    });
    const buffer = await buildBidOverviewReportXlsx(
      rows,
      dateRangeReportTitle(
        "Bid Overview Report",
        parsed.data.from,
        parsed.data.to,
      ),
    );
    sendXlsx(res, buffer, buildBidOverviewReportFilename());
  } catch (e) {
    handleReportError(e, res, next);
  }
});

router.get("/sealed-bids/auctions", async (req, res, next) => {
  const parsed = sealedBidAuctionsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        AdminReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  if (!parsed.data.from || !parsed.data.to) {
    res.status(400).json({ error: AdminReportsMessages.DATE_RANGE_REQUIRED });
    return;
  }
  try {
    res.json(
      await sealedBidReportService.listAuctions(parsed.data.clientId, {
        from: parsed.data.from,
        to: parsed.data.to,
      }),
    );
  } catch (e) {
    handleReportError(e, res, next);
  }
});

router.get("/sealed-bids", async (req, res, next) => {
  const parsed = bidDetailsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        AdminReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  try {
    res.json(
      await sealedBidReportService.report(
        parsed.data.clientId,
        parsed.data.auctionId,
      ),
    );
  } catch (e) {
    handleReportError(e, res, next);
  }
});

router.get("/sealed-bids/export", async (req, res, next) => {
  const parsed = bidDetailsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        AdminReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  try {
    const rows = await sealedBidReportService.report(
      parsed.data.clientId,
      parsed.data.auctionId,
    );
    const meta = await sealedBidReportService.auctionReportMeta(
      parsed.data.clientId,
      parsed.data.auctionId,
    );
    const buffer = await buildSealedBidReportXlsx(
      rows,
      auctionReportTitle("Sealed-Bid Report", meta, { includeClient: true }),
    );
    sendXlsx(res, buffer, buildSealedBidReportFilename());
  } catch (e) {
    handleReportError(e, res, next);
  }
});

router.get("/bid-details", async (req, res, next) => {
  const parsed = bidDetailsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        AdminReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  try {
    res.json(
      await adminReportsService.bidDetailsReport(
        parsed.data.clientId,
        parsed.data.auctionId,
      ),
    );
  } catch (e) {
    handleReportError(e, res, next);
  }
});

router.get("/bid-details/export", async (req, res, next) => {
  const parsed = bidDetailsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        AdminReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  try {
    const rows = await adminReportsService.bidDetailsReport(
      parsed.data.clientId,
      parsed.data.auctionId,
    );
    const meta = await adminReportsService.auctionReportMeta(
      parsed.data.clientId,
      parsed.data.auctionId,
    );
    const buffer = await buildAdminBidDetailsReportXlsx(
      rows,
      auctionReportTitle("Bid Details Report", meta, { includeClient: true }),
    );
    sendXlsx(res, buffer, buildAdminBidDetailsReportFilename());
  } catch (e) {
    handleReportError(e, res, next);
  }
});

router.get("/bidder-details", async (req, res, next) => {
  const parsed = bidDetailsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        AdminReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  try {
    res.json(
      await adminReportsService.bidderDetailsReport(
        parsed.data.clientId,
        parsed.data.auctionId,
      ),
    );
  } catch (e) {
    handleReportError(e, res, next);
  }
});

router.get("/bidder-details/export", async (req, res, next) => {
  const parsed = bidDetailsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        AdminReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  try {
    const rows = await adminReportsService.bidderDetailsReport(
      parsed.data.clientId,
      parsed.data.auctionId,
    );
    const meta = await adminReportsService.auctionReportMeta(
      parsed.data.clientId,
      parsed.data.auctionId,
    );
    const buffer = await buildBidderDetailsReportXlsx(
      rows,
      auctionReportTitle("Bidder Details Report", meta, {
        includeClient: true,
      }),
    );
    sendXlsx(res, buffer, buildBidderDetailsReportFilename());
  } catch (e) {
    handleReportError(e, res, next);
  }
});

router.get("/bidder-overview", async (req, res, next) => {
  const parsed = bidderOverviewQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        AdminReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  if (!parsed.data.from || !parsed.data.to) {
    res.status(400).json({ error: AdminReportsMessages.DATE_RANGE_REQUIRED });
    return;
  }
  try {
    res.json(
      await adminReportsService.bidderOverviewReport({
        from: parsed.data.from,
        to: parsed.data.to,
        clientIds: parsed.data.clientIds,
        auctionIds: parsed.data.auctionIds,
      }),
    );
  } catch (e) {
    handleReportError(e, res, next);
  }
});

router.get("/bidder-overview/export", async (req, res, next) => {
  const parsed = bidderOverviewQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        AdminReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  if (!parsed.data.from || !parsed.data.to) {
    res.status(400).json({ error: AdminReportsMessages.DATE_RANGE_REQUIRED });
    return;
  }
  try {
    const rows = await adminReportsService.bidderOverviewReport({
      from: parsed.data.from,
      to: parsed.data.to,
      clientIds: parsed.data.clientIds,
      auctionIds: parsed.data.auctionIds,
    });
    const buffer = await buildBidderOverviewReportXlsx(
      rows,
      dateRangeReportTitle(
        "Bidder Overview Report",
        parsed.data.from,
        parsed.data.to,
      ),
    );
    sendXlsx(res, buffer, buildBidderOverviewReportFilename());
  } catch (e) {
    handleReportError(e, res, next);
  }
});

router.get("/auction-overview", async (req, res, next) => {
  const parsed = auctionOverviewQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        AdminReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  if (!parsed.data.from || !parsed.data.to) {
    res.status(400).json({ error: AdminReportsMessages.DATE_RANGE_REQUIRED });
    return;
  }
  try {
    res.json(
      await adminReportsService.auctionOverviewReport({
        from: parsed.data.from,
        to: parsed.data.to,
        clientIds: parsed.data.clientIds,
        auctionIds: parsed.data.auctionIds,
      }),
    );
  } catch (e) {
    handleReportError(e, res, next);
  }
});

router.get("/auction-overview/export", async (req, res, next) => {
  const parsed = auctionOverviewQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        AdminReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  if (!parsed.data.from || !parsed.data.to) {
    res.status(400).json({ error: AdminReportsMessages.DATE_RANGE_REQUIRED });
    return;
  }
  try {
    const rows = await adminReportsService.auctionOverviewReport({
      from: parsed.data.from,
      to: parsed.data.to,
      clientIds: parsed.data.clientIds,
      auctionIds: parsed.data.auctionIds,
    });
    const buffer = await buildAuctionOverviewReportXlsx(
      rows,
      dateRangeReportTitle(
        "Auction Overview Report",
        parsed.data.from,
        parsed.data.to,
      ),
    );
    sendXlsx(res, buffer, buildAuctionOverviewReportFilename());
  } catch (e) {
    handleReportError(e, res, next);
  }
});

router.get("/auction-details", async (req, res, next) => {
  const parsed = bidDetailsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        AdminReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  try {
    res.json(
      await adminReportsService.auctionDetailsReport(
        parsed.data.clientId,
        parsed.data.auctionId,
      ),
    );
  } catch (e) {
    handleReportError(e, res, next);
  }
});

router.get("/auction-details/export", async (req, res, next) => {
  const parsed = bidDetailsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        AdminReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  try {
    const report = await adminReportsService.auctionDetailsReport(
      parsed.data.clientId,
      parsed.data.auctionId,
    );
    const buffer = await buildAuctionDetailsReportXlsx(report);
    sendXlsx(res, buffer, buildAuctionDetailsReportFilename());
  } catch (e) {
    handleReportError(e, res, next);
  }
});

router.get("/subscription", async (req, res, next) => {
  const parsed = subscriptionReportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        AdminReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  if (!parsed.data.from || !parsed.data.to) {
    res.status(400).json({ error: AdminReportsMessages.DATE_RANGE_REQUIRED });
    return;
  }
  try {
    res.json(
      await subscriptionReportService.page({
        from: parsed.data.from,
        to: parsed.data.to,
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
      }),
    );
  } catch (e) {
    next(e);
  }
});

router.get("/subscription/export", async (req, res, next) => {
  const parsed = closedDateRangeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        AdminReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  if (!parsed.data.from || !parsed.data.to) {
    res.status(400).json({ error: AdminReportsMessages.DATE_RANGE_REQUIRED });
    return;
  }
  try {
    const rows = await subscriptionReportService.all({
      from: parsed.data.from,
      to: parsed.data.to,
    });
    const buffer = await buildSubscriptionReportXlsx(
      rows,
      dateRangeReportTitle(
        "Subscription Report",
        parsed.data.from,
        parsed.data.to,
      ),
    );
    sendXlsx(res, buffer, buildSubscriptionReportFilename());
  } catch (e) {
    next(e);
  }
});

router.get("/benchmark/materials", async (_req, res, next) => {
  try {
    res.json(await benchmarkReportService.listMaterials());
  } catch (e) {
    next(e);
  }
});

router.get("/benchmark", async (req, res, next) => {
  const params = parseBenchmarkReportQuery(req, res);
  if (!params) return;
  try {
    res.json(await benchmarkReportService.report(params));
  } catch (e) {
    next(e);
  }
});

router.get("/benchmark/export", async (req, res, next) => {
  const params = parseBenchmarkReportQuery(req, res);
  if (!params) return;
  try {
    const report = await benchmarkReportService.report(params);
    const buffer = await buildBenchmarkReportXlsx(
      report,
      dateRangeReportTitle(
        `Benchmark Report - ${params.material}`,
        params.from,
        params.to,
      ),
    );
    sendXlsx(res, buffer, buildBenchmarkReportFilename());
  } catch (e) {
    next(e);
  }
});

router.get("/market/auctions", async (req, res, next) => {
  const parsed = marketAuctionsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        AdminReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  try {
    res.json(await marketReportService.listAuctions(parsed.data.clientId));
  } catch (e) {
    next(e);
  }
});

router.get("/market/benchmark-options", async (_req, res, next) => {
  try {
    res.json(await marketReportService.listBenchmarkOptions());
  } catch (e) {
    next(e);
  }
});

async function runRevenueExport(
  params: RevenueReportParams,
  progress: ReportExportProgressFn,
) {
  const data = await revenueReportService.build(params, (stage) => {
    if (stage === "summary") {
      progress(10, RevenueReportExportMessages.FETCHING_SUMMARY);
    } else if (stage === "details") {
      progress(25, RevenueReportExportMessages.FETCHING_DETAILS);
    } else {
      progress(40, RevenueReportExportMessages.FETCHING_LIFTING);
    }
  });
  const ratio = (written: number, total: number) =>
    total > 0 ? written / total : 1;
  const buffer = await buildRevenueReportXlsx(data, {
    from: params.from,
    to: params.to,
    generatedAt: reportGeneratedAt(),
    onProgress: (p) => {
      if (p.stage === "summary") {
        progress(50, RevenueReportExportMessages.WRITING_SUMMARY);
      } else if (p.stage === "details") {
        progress(
          50 + ratio(p.written, p.total) * 25,
          RevenueReportExportMessages.WRITING_DETAILS(p.written, p.total),
        );
      } else if (p.stage === "lifting") {
        progress(
          75 + ratio(p.written, p.total) * 17,
          RevenueReportExportMessages.WRITING_LIFTING(p.written, p.total),
        );
      } else {
        progress(95, RevenueReportExportMessages.ADDING_LOGO);
      }
    },
  });
  return { buffer, fileName: buildRevenueReportFilename(params.from, params.to) };
}

async function runLiftingExport(
  params: LiftingReportParams,
  progress: ReportExportProgressFn,
) {
  const data = await liftingReportService.build(params, (stage) => {
    if (stage === "overview") {
      progress(10, LiftingReportExportMessages.FETCHING_OVERVIEW);
    } else {
      progress(30, LiftingReportExportMessages.FETCHING_DETAIL);
    }
  });
  const ratio = (written: number, total: number) =>
    total > 0 ? written / total : 1;
  const buffer = await buildLiftingReportXlsx(data, {
    from: params.from,
    to: params.to,
    generatedAt: reportGeneratedAt(),
    onProgress: (p) => {
      if (p.stage === "overview") {
        progress(
          45 + ratio(p.written, p.total) * 5,
          LiftingReportExportMessages.WRITING_OVERVIEW(p.written, p.total),
        );
      } else if (p.stage === "detail") {
        progress(
          50 + ratio(p.written, p.total) * 42,
          LiftingReportExportMessages.WRITING_DETAIL(p.written, p.total),
        );
      } else {
        progress(95, LiftingReportExportMessages.ADDING_LOGO);
      }
    },
  });
  return { buffer, fileName: buildLiftingReportFilename(params.from, params.to) };
}

type ReportRange = { from: string; to: string };

/** Required From–To with To not after today; answers 400 and returns null otherwise. */
function checkReportRange(
  res: Response,
  from: string | undefined,
  to: string | undefined,
): ReportRange | null {
  if (!from || !to) {
    res.status(400).json({ error: AdminReportsMessages.DATE_RANGE_REQUIRED });
    return null;
  }
  if (to > istDateOnly()) {
    res.status(400).json({ error: AdminReportsMessages.TO_DATE_FUTURE });
    return null;
  }
  return { from, to };
}

function parsePagedReportRange(
  req: Request,
  res: Response,
): (ReportRange & { page: number; pageSize: number }) | null {
  const parsed = subscriptionReportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        AdminReportsMessages.VALIDATION_FAILED,
      ),
    );
    return null;
  }
  const range = checkReportRange(res, parsed.data.from, parsed.data.to);
  if (!range) return null;
  return { ...range, page: parsed.data.page, pageSize: parsed.data.pageSize };
}

/** Validates the body range and registers a background export job (202 / 409 / 429). */
function startExportJob(
  req: Request,
  res: Response,
  job: {
    reportType: ReportExportType;
    initialLabel: string;
    run: (
      range: ReportRange,
      progress: ReportExportProgressFn,
    ) => Promise<{ buffer: Buffer; fileName: string }>;
  },
) {
  const parsed = closedDateRangeQuerySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        parsed.error.issues[0]?.message ?? AdminReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  const range = checkReportRange(res, parsed.data.from, parsed.data.to);
  if (!range) return;
  try {
    const started = reportExportsService.start({
      userId: req.user!.id,
      reportType: job.reportType,
      initialLabel: job.initialLabel,
      run: (progress) => job.run(range, progress),
    });
    res.status(202).json({ jobId: started.jobId });
  } catch (e) {
    if (e instanceof ReportExportConflictError) {
      res.status(409).json({ error: e.message });
      return;
    }
    if (e instanceof ReportExportBusyError) {
      res.status(429).json({ error: e.message });
      return;
    }
    throw e;
  }
}

router.get("/revenue/summary", async (req, res, next) => {
  const params = parsePagedReportRange(req, res);
  if (!params) return;
  try {
    res.json(await revenueReportService.summaryPage(params));
  } catch (e) {
    next(e);
  }
});

router.post("/revenue/export", (req, res) => {
  startExportJob(req, res, {
    reportType: "revenue",
    initialLabel: RevenueReportExportMessages.QUEUED,
    run: runRevenueExport,
  });
});

router.get("/lifting/overview", async (req, res, next) => {
  const params = parsePagedReportRange(req, res);
  if (!params) return;
  const parsed = liftingOverviewQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        AdminReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  try {
    res.json(
      await liftingReportService.overviewPage({
        ...params,
        clientIds: parsed.data.clientIds,
      }),
    );
  } catch (e) {
    next(e);
  }
});

router.post("/lifting/export", (req, res) => {
  const parsed = liftingExportBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json(
      zodValidationErrorBody(
        parsed.error,
        AdminReportsMessages.VALIDATION_FAILED,
      ),
    );
    return;
  }
  const { clientIds } = parsed.data;
  startExportJob(req, res, {
    reportType: "lifting",
    initialLabel: LiftingReportExportMessages.QUEUED,
    run: (range, progress) => runLiftingExport({ ...range, clientIds }, progress),
  });
});

const SSE_HEARTBEAT_MS = 15_000;

router.get("/exports/:jobId/events", (req, res) => {
  const userId = req.user!.id;
  const jobId = req.params.jobId;
  const job = reportExportsService.get(jobId, userId);
  if (!job) {
    res.status(404).json({ error: AdminReportsMessages.REPORT_EXPORT_NOT_FOUND });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    if (heartbeat) clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  };

  const send = (event: ReportExportEvent) => {
    if (closed) return;
    const { type, ...data } = event;
    res.write(encodeSseEvent(type, data));
    if (type !== "progress") close();
  };

  req.on("close", close);

  if (job.status === "completed" && job.fileName) {
    send({ type: "complete", jobId: job.jobId, fileName: job.fileName });
    return;
  }
  if (job.status === "failed") {
    send({
      type: "error",
      message: job.error ?? AdminReportsMessages.REPORT_EXPORT_FAILED,
    });
    return;
  }

  unsubscribe = reportExportsService.subscribe(jobId, send);
  send({ type: "progress", percent: job.percent, label: job.label });
  heartbeat = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, SSE_HEARTBEAT_MS);
});

router.get("/exports/:jobId/download", (req, res) => {
  const userId = req.user!.id;
  const jobId = req.params.jobId;
  const result = reportExportsService.download(jobId, userId);
  if (result.kind === "not_found" || result.kind === "gone") {
    res.status(410).json({ error: AdminReportsMessages.REPORT_EXPORT_EXPIRED });
    return;
  }
  if (result.kind === "not_ready") {
    res.status(409).json({ error: AdminReportsMessages.REPORT_EXPORT_NOT_READY });
    return;
  }
  res.on("finish", () => reportExportsService.release(jobId, userId));
  sendXlsx(res, result.buffer, result.fileName);
});

router.delete("/exports/:jobId", (req, res) => {
  const userId = req.user!.id;
  reportExportsService.discard(req.params.jobId, userId);
  res.status(204).end();
});

router.post("/market/export", async (req, res, next) => {
  const params = parseMarketReportBody(req, res);
  if (!params) return;
  try {
    const report = await marketReportService.build(params);
    const buffer = await buildMarketReportDocx(report, params.marketMaking);
    const filename = buildMarketReportFilename(report);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  } catch (e) {
    handleReportError(e, res, next);
  }
});

export default router;
