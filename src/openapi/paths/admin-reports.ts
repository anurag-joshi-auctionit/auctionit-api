import { z } from "zod";
import { closedDateRangeQuerySchema } from "../../lib/closed-auction-date-range.js";
import { BinaryFile, ErrorBody } from "../common.js";
import { documentRouter } from "../define.js";
import {
  AdminReportAuctionDetails,
  AdminReportAuctionOptions,
  AdminReportAuctionOverview,
  AdminReportBenchmark,
  AdminReportBenchmarkMaterials,
  AdminReportBidDetails,
  AdminReportBidOverview,
  AdminReportBidderDetails,
  AdminReportBidderOverview,
  AdminReportExportJob,
  AdminReportLiftingOverviewPage,
  AdminReportMarketBenchmarkOptions,
  AdminReportRevenueSummaryPage,
  AdminReportSealedBids,
  AdminReportSubscriptionPage,
} from "../responses/admin-reports.js";

// Docs for src/routes/admin-reports.ts — see docs/api/README.md.
const r = documentRouter("/admin/reports");

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * The routes use `closedDateRangeQuerySchema.and(z.object({...}))`; OpenAPI query params need a
 * flat object, so the docs merge the same fields (the from/to refinements are described in prose).
 */
function rangeWith<T extends z.ZodRawShape>(extra: z.ZodObject<T>) {
  return closedDateRangeQuerySchema.innerType().merge(extra);
}

// ---- Request schemas recreated from src/routes/admin-reports.ts ----

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
  })
  .describe("Comma-separated ids (or a repeated param), e.g. `1,2,3`. Non-numeric parts are ignored; empty = all.");

const auctionsQuerySchema = rangeWith(z.object({ clientIds: optionalIdListSchema }));

const bidOverviewQuerySchema = rangeWith(
  z.object({
    clientIds: optionalIdListSchema,
    auctionIds: optionalIdListSchema,
    bidMode: z
      .enum(["bid", "no-bid"])
      .optional()
      .describe("`bid` = only lots with a winner; `no-bid` = only lots with no bids; omitted = both."),
  }),
);

const bidderOverviewQuerySchema = rangeWith(
  z.object({
    clientIds: optionalIdListSchema,
    auctionIds: optionalIdListSchema,
  }),
);

const auctionOverviewQuerySchema = bidderOverviewQuerySchema;

const pageFields = {
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().default(10),
};

const subscriptionReportQuerySchema = rangeWith(z.object(pageFields));

// /lifting/overview parses the paged range and `liftingOverviewQuerySchema` from the same query.
const liftingOverviewQuerySchema = rangeWith(z.object({ ...pageFields, clientIds: optionalIdListSchema }));

const bidDetailsQuerySchema = z.object({
  clientId: z.coerce.number().int().positive(),
  auctionId: z.coerce.number().int().positive(),
});

const sealedBidAuctionsQuerySchema = rangeWith(
  z.object({ clientId: z.coerce.number().int().positive() }),
);

const benchmarkReportQuerySchema = rangeWith(
  z.object({ material: z.string().trim().min(1).max(500).describe("Benchmark material name.") }),
);

const marketAuctionsQuerySchema = z.object({
  clientId: z.coerce.number().int().positive(),
});

const reportRangeBodySchema = closedDateRangeQuerySchema;

const liftingExportBodySchema = closedDateRangeQuerySchema.innerType().extend({
  clientIds: z
    .array(z.number().int().positive())
    .optional()
    .describe("Clients to include; empty / omitted = every client."),
});

// Simplified from richTextNodeSchema (lib/market-report/rich-text.ts), which is recursive (z.lazy).
const richTextDoc = z
  .object({
    type: z.literal("doc"),
    content: z.array(z.record(z.unknown())).optional(),
  })
  .passthrough()
  .describe(
    "Tiptap / ProseMirror JSON document (`doc` root). Node types: doc, paragraph, heading, bulletList, orderedList, " +
      "listItem, text, hardBreak; marks: bold, italic, underline, strike. Max 5000 nodes and 50000 text characters; " +
      "must contain some non-whitespace text.",
  );

// Recreated (flattened) from marketReportBodySchema in src/routes/admin-reports.ts.
const marketReportBodySchema = z.object({
  clientId: z.coerce.number().int().positive(),
  auctionId: z.coerce.number().int().positive(),
  from: z.string().describe("`YYYY-MM-DD`; range at most 366 days."),
  to: z.string().describe("`YYYY-MM-DD`; not before `from`."),
  benchmarks: z
    .array(
      z.object({
        material: z.string().trim().nullish(),
        comboId: z.coerce.number().int().positive().nullish().describe("Benchmark material-location id."),
      }),
    )
    .max(10)
    .describe(
      "Up to 10 benchmark rows. Blank rows are ignored; a row with a material but no `comboId` is rejected; " +
        "at least one `comboId` is required and ids must be unique.",
    ),
  marketMaking: richTextDoc,
});

// ---- Shared response docs ----

const RANGE_NOTE =
  "`from` and `to` (`YYYY-MM-DD`, inclusive auction dates) are both required; `from` must not be after `to`. " +
  "Only closed, active auctions are included.";
const RANGE_NOTE_TO_TODAY =
  "`from` and `to` (`YYYY-MM-DD`, inclusive) are both required; `from` must not be after `to`, and `to` must not be after today (IST).";

const range400 = {
  description:
    "Invalid query (`ValidationErrorBody` with `fieldErrors`), or `from`/`to` missing (plain `{ error }`).",
  schema: ErrorBody,
};
const auction404 = {
  description: "The auction is not a closed, active auction of that client.",
  schema: ErrorBody,
};
const xlsx = (what: string) => ({ description: `${what} workbook (attachment).`, schema: BinaryFile, contentType: XLSX });

// ---- Auction lookup ----

r.get("/auctions", {
  summary: "Closed auctions for report filters",
  description: `Closed auctions of the selected clients in the range. At least one id in \`clientIds\` is required. ${RANGE_NOTE}`,
  query: auctionsQuerySchema,
  responses: {
    200: AdminReportAuctionOptions,
    400: { description: "Invalid query, `from`/`to` missing, or no `clientIds`.", schema: ErrorBody },
  },
});

// ---- Bid overview ----

r.get("/bid-overview", {
  summary: "Bid Overview report",
  description: `One row per lot in the range, optionally limited to \`clientIds\` / \`auctionIds\`. ${RANGE_NOTE}`,
  query: bidOverviewQuerySchema,
  responses: { 200: AdminReportBidOverview, 400: range400 },
});

r.get("/bid-overview/export", {
  summary: "Export Bid Overview report",
  description: `Same rows as \`GET /admin/reports/bid-overview\` as an Excel file. ${RANGE_NOTE}`,
  query: bidOverviewQuerySchema,
  responses: { 200: xlsx("Bid Overview"), 400: range400 },
});

// ---- Sealed-bids ----

r.get("/sealed-bids/auctions", {
  summary: "Sealed-bid auctions for report filters",
  description:
    "Sealed-bid auctions of one client whose sealed-bid date falls in the range, newest first. " +
    "`from` and `to` (`YYYY-MM-DD`) are both required; `from` must not be after `to`.",
  query: sealedBidAuctionsQuerySchema,
  responses: { 200: AdminReportAuctionOptions, 400: range400 },
});

r.get("/sealed-bids", {
  summary: "Sealed-Bid report",
  description: "Per-lot min / max / average sealed-bid, bidder count and winner for one sealed-bid auction.",
  query: bidDetailsQuerySchema,
  responses: {
    200: AdminReportSealedBids,
    404: { description: "Not a sealed-bid auction of that client.", schema: ErrorBody },
  },
});

r.get("/sealed-bids/export", {
  summary: "Export Sealed-Bid report",
  description: "Same rows as `GET /admin/reports/sealed-bids` as an Excel file.",
  query: bidDetailsQuerySchema,
  responses: {
    200: xlsx("Sealed-Bid"),
    404: { description: "Not a sealed-bid auction of that client.", schema: ErrorBody },
  },
});

// ---- Bid details ----

r.get("/bid-details", {
  summary: "Bid Details report",
  description: "Every bid on every lot of one closed auction, in lot order then bid time.",
  query: bidDetailsQuerySchema,
  responses: { 200: AdminReportBidDetails, 404: auction404 },
});

r.get("/bid-details/export", {
  summary: "Export Bid Details report",
  description: "Same rows as `GET /admin/reports/bid-details` as an Excel file.",
  query: bidDetailsQuerySchema,
  responses: { 200: xlsx("Bid Details"), 404: auction404 },
});

// ---- Bidder details ----

r.get("/bidder-details", {
  summary: "Bidder Details report",
  description:
    "Bidders attached to one closed auction with contact details, last login/logout, whether they bid, " +
    "whether they are new to the client and when they accepted the T&C.",
  query: bidDetailsQuerySchema,
  responses: { 200: AdminReportBidderDetails, 404: auction404 },
});

r.get("/bidder-details/export", {
  summary: "Export Bidder Details report",
  description: "Same rows as `GET /admin/reports/bidder-details` as an Excel file.",
  query: bidDetailsQuerySchema,
  responses: { 200: xlsx("Bidder Details"), 404: auction404 },
});

// ---- Bidder overview ----

r.get("/bidder-overview", {
  summary: "Bidder Overview report",
  description:
    "Per auction: attached, logged-in, participating and winning bidder counts, and how many of each were new to the client. " +
    RANGE_NOTE,
  query: bidderOverviewQuerySchema,
  responses: { 200: AdminReportBidderOverview, 400: range400 },
});

r.get("/bidder-overview/export", {
  summary: "Export Bidder Overview report",
  description: `Same rows as \`GET /admin/reports/bidder-overview\` as an Excel file. ${RANGE_NOTE}`,
  query: bidderOverviewQuerySchema,
  responses: { 200: xlsx("Bidder Overview"), 400: range400 },
});

// ---- Auction overview ----

r.get("/auction-overview", {
  summary: "Auction Overview report",
  description: `One row per lot with timing, quantity, prices, winner and bid/bidder counts. ${RANGE_NOTE}`,
  query: auctionOverviewQuerySchema,
  responses: { 200: AdminReportAuctionOverview, 400: range400 },
});

r.get("/auction-overview/export", {
  summary: "Export Auction Overview report",
  description: `Same rows as \`GET /admin/reports/auction-overview\` as an Excel file. ${RANGE_NOTE}`,
  query: auctionOverviewQuerySchema,
  responses: { 200: xlsx("Auction Overview"), 400: range400 },
});

// ---- Auction details ----

r.get("/auction-details", {
  summary: "Auction Details report",
  description:
    "One closed auction: lot summary (with the client's additional-field columns), every bid, and participants with EMD balance.",
  query: bidDetailsQuerySchema,
  responses: { 200: AdminReportAuctionDetails, 404: auction404 },
});

r.get("/auction-details/export", {
  summary: "Export Auction Details report",
  description: "Same data as `GET /admin/reports/auction-details` as a multi-sheet Excel file.",
  query: bidDetailsQuerySchema,
  responses: { 200: xlsx("Auction Details"), 404: auction404 },
});

// ---- Subscription ----

r.get("/subscription", {
  summary: "Subscription report",
  description:
    "Paginated subscription payments whose payment date falls in the range, newest first, with totals over all pages. " +
    "`from` and `to` (`YYYY-MM-DD`) are both required; `from` must not be after `to`.",
  query: subscriptionReportQuerySchema,
  responses: { 200: AdminReportSubscriptionPage, 400: range400 },
});

r.get("/subscription/export", {
  summary: "Export Subscription report",
  description:
    "All subscription payments in the range as an Excel file. `from` and `to` (`YYYY-MM-DD`) are both required.",
  query: closedDateRangeQuerySchema,
  responses: { 200: xlsx("Subscription"), 400: range400 },
});

// ---- Benchmark ----

r.get("/benchmark/materials", {
  summary: "Benchmark materials",
  description: "Active benchmark material names for the Benchmark report picker.",
  responses: { 200: AdminReportBenchmarkMaterials },
});

r.get("/benchmark", {
  summary: "Benchmark report",
  description:
    "Daily benchmark prices (in INR) of one material across its locations. " +
    "`from` and `to` (`YYYY-MM-DD`) are both required, `from` must not be after `to`, and the range may span at most 366 days.",
  query: benchmarkReportQuerySchema,
  responses: {
    200: AdminReportBenchmark,
    400: { description: "Invalid query, `from`/`to` missing, or range longer than 366 days.", schema: ErrorBody },
  },
});

r.get("/benchmark/export", {
  summary: "Export Benchmark report",
  description: "Same data as `GET /admin/reports/benchmark` as an Excel file. Same range rules.",
  query: benchmarkReportQuerySchema,
  responses: {
    200: xlsx("Benchmark"),
    400: { description: "Invalid query, `from`/`to` missing, or range longer than 366 days.", schema: ErrorBody },
  },
});

// ---- Market ----

r.get("/market/auctions", {
  summary: "Upcoming auctions for the Market report",
  description: "Upcoming published auctions of one client, soonest first.",
  query: marketAuctionsQuerySchema,
  responses: { 200: AdminReportAuctionOptions },
});

r.get("/market/benchmark-options", {
  summary: "Benchmark options for the Market report",
  description: "Benchmark material-location combos (`id` is the `comboId` used in the Market report export).",
  responses: { 200: AdminReportMarketBenchmarkOptions },
});

r.post("/market/export", {
  summary: "Generate Market report",
  description:
    "Builds a Word document for an upcoming auction: header, benchmark price trends for the selected combos over " +
    "`from`–`to` (at most 366 days; `from` not after `to`), per-lot previous auction / benchmark / suggested start bid price, " +
    "and the Market Making rich text.",
  body: marketReportBodySchema,
  responses: {
    200: { description: "Market report document (attachment).", schema: BinaryFile, contentType: DOCX },
    400: {
      description:
        "Invalid body (first issue as `error`, plus `fieldErrors`), range longer than 366 days, auction is not an upcoming " +
        "published auction, or an unknown benchmark combo.",
      schema: ErrorBody,
    },
    404: { description: "Auction not found for that client.", schema: ErrorBody },
  },
});

// ---- Revenue ----

r.get("/revenue/summary", {
  summary: "Revenue report summary",
  description:
    "Paginated per-client auctioned / approved / lifted values for the period and inception-to-date (up to `to`), " +
    `plus a service fee revenue estimate and totals over all clients. ${RANGE_NOTE_TO_TODAY}`,
  query: subscriptionReportQuerySchema,
  responses: {
    200: AdminReportRevenueSummaryPage,
    400: { description: "Invalid query, `from`/`to` missing, or `to` is in the future.", schema: ErrorBody },
  },
});

r.post("/revenue/export", {
  summary: "Start Revenue report export",
  description:
    "Queues a background build of the full Revenue workbook (summary, lot details, lifting sheets). " +
    "Follow progress with `GET /admin/reports/exports/{jobId}/events`, then download with `GET /admin/reports/exports/{jobId}/download`. " +
    RANGE_NOTE_TO_TODAY,
  body: reportRangeBodySchema,
  responses: {
    202: { description: "Export job started.", schema: AdminReportExportJob },
    400: { description: "Invalid body, `from`/`to` missing, or `to` is in the future.", schema: ErrorBody },
    409: { description: "This user already has a Revenue export running.", schema: ErrorBody },
    429: { description: "The server-wide export limit (2 running jobs) is reached.", schema: ErrorBody },
  },
});

// ---- Lifting ----

r.get("/lifting/overview", {
  summary: "Lifting report overview",
  description:
    "Paginated lots with at least one lifting entry dated within the period: approved, lifted before / during the period, " +
    `balance and status, plus stats over all lots. Optionally limited to \`clientIds\`. ${RANGE_NOTE_TO_TODAY}`,
  query: liftingOverviewQuerySchema,
  responses: {
    200: AdminReportLiftingOverviewPage,
    400: { description: "Invalid query, `from`/`to` missing, or `to` is in the future.", schema: ErrorBody },
  },
});

r.post("/lifting/export", {
  summary: "Start Lifting report export",
  description:
    "Queues a background build of the Lifting workbook (overview and per-entry detail sheets). " +
    "Follow progress with `GET /admin/reports/exports/{jobId}/events`, then download with `GET /admin/reports/exports/{jobId}/download`. " +
    RANGE_NOTE_TO_TODAY,
  body: liftingExportBodySchema,
  responses: {
    202: { description: "Export job started.", schema: AdminReportExportJob },
    400: { description: "Invalid body, `from`/`to` missing, or `to` is in the future.", schema: ErrorBody },
    409: { description: "This user already has a Lifting export running.", schema: ErrorBody },
    429: { description: "The server-wide export limit (2 running jobs) is reached.", schema: ErrorBody },
  },
});

// ---- Background export jobs ----

const jobParams = z.object({
  jobId: z.string().uuid().openapi({ param: { name: "jobId", in: "path" } }),
});

r.get("/exports/:jobId/events", {
  summary: "Export job progress (SSE)",
  description:
    "Server-Sent Events for one of the user's export jobs. Events:\n\n" +
    "- `progress` — `{ percent: number, label: string }` (sent immediately, then as the job advances)\n" +
    "- `complete` — `{ jobId: string, fileName: string }`; the stream then closes\n" +
    "- `error` — `{ message: string }`; the stream then closes\n\n" +
    "A `: ping` comment is sent every 15 s. Finished jobs answer with a single `complete` or `error` event.",
  params: jobParams,
  responses: {
    200: { description: "Event stream.", schema: z.string(), contentType: "text/event-stream" },
    404: { description: "No such job for this user.", schema: ErrorBody },
  },
});

r.get("/exports/:jobId/download", {
  summary: "Download export result",
  description:
    "Downloads the finished workbook. The result is kept for 15 minutes and freed after a successful download.",
  params: jobParams,
  responses: {
    200: xlsx("Revenue or Lifting report"),
    409: { description: "The job is still running.", schema: ErrorBody },
    410: { description: "Unknown job, failed job, or the result expired / was already downloaded.", schema: ErrorBody },
  },
});

r.delete("/exports/:jobId", {
  summary: "Discard export job",
  description: "Frees a finished job's result early. Running jobs are left to complete. Always 204, even for unknown ids.",
  params: jobParams,
  responses: { 204: { description: "Discarded (or nothing to discard)." } },
});
