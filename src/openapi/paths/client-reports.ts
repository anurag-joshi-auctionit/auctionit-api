import { z } from "zod";
import { closedDateRangeQuerySchema } from "../../lib/closed-auction-date-range.js";
import { BinaryFile, ErrorBody } from "../common.js";
import { documentRouter } from "../define.js";
import {
  ClientReportAuctions,
  ClientReportBidDetails,
  ClientReportBidOverview,
  ClientReportClients,
} from "../responses/client-reports.js";

// Docs for src/routes/client-reports.ts — see docs/api/README.md.
const r = documentRouter("/client/reports");

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * The routes use `closedDateRangeQuerySchema.and(z.object({...}))`; OpenAPI query params need a
 * flat object, so the docs merge the same fields (the from/to refinements are described in prose).
 */
function rangeWith<T extends z.ZodRawShape>(extra: z.ZodObject<T>) {
  return closedDateRangeQuerySchema.innerType().merge(extra);
}

// Recreated from src/routes/client-reports.ts.
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
  .describe("Comma-separated ids (or a repeated param), e.g. `1,2,3`. Non-numeric parts are ignored.");

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

const bidDetailsQuerySchema = z.object({
  clientId: z.coerce.number().int().positive(),
  auctionId: z.coerce.number().int().positive(),
});

const RANGE_NOTE =
  "`from` and `to` (`YYYY-MM-DD`, inclusive auction dates) are both required; `from` must not be after `to`.";

const range400 = {
  description:
    "Invalid query (`ValidationErrorBody` with `fieldErrors`), or `from`/`to` missing (plain `{ error }`).",
  schema: ErrorBody,
};
const forbidden403 = { description: "A requested client is not linked to the user.", schema: ErrorBody };
const auction404 = {
  description: "The auction is not a closed, active auction of that client.",
  schema: ErrorBody,
};

r.get("/clients", {
  summary: "Linked clients",
  description: "Active clients linked to the logged-in user, for the report filters.",
  responses: { 200: ClientReportClients },
});

r.get("/auctions", {
  summary: "Closed auctions for report filters",
  description: `Closed auctions of the selected clients in the range. At least one id in \`clientIds\` is required. ${RANGE_NOTE}`,
  query: auctionsQuerySchema,
  responses: {
    200: ClientReportAuctions,
    400: {
      description: "Invalid query, `from`/`to` missing, or no `clientIds`.",
      schema: ErrorBody,
    },
    403: forbidden403,
  },
});

r.get("/bid-overview", {
  summary: "Bid Overview report",
  description:
    "One row per lot of closed auctions in the range, limited to the user's linked clients " +
    `(and to \`clientIds\` / \`auctionIds\` when given). ${RANGE_NOTE}`,
  query: bidOverviewQuerySchema,
  responses: { 200: ClientReportBidOverview, 400: range400, 403: forbidden403 },
});

r.get("/bid-overview/export", {
  summary: "Export Bid Overview report",
  description: `Same rows as \`GET /client/reports/bid-overview\` as an Excel file. ${RANGE_NOTE}`,
  query: bidOverviewQuerySchema,
  responses: {
    200: { description: "Bid Overview workbook (attachment).", schema: BinaryFile, contentType: XLSX },
    400: range400,
    403: forbidden403,
  },
});

r.get("/bid-details", {
  summary: "Bid Details report",
  description: "Every bid on every lot of one closed auction, in lot order then bid time.",
  query: bidDetailsQuerySchema,
  responses: { 200: ClientReportBidDetails, 403: forbidden403, 404: auction404 },
});

r.get("/bid-details/export", {
  summary: "Export Bid Details report",
  description: "Same rows as `GET /client/reports/bid-details` as an Excel file.",
  query: bidDetailsQuerySchema,
  responses: {
    200: { description: "Bid Details workbook (attachment).", schema: BinaryFile, contentType: XLSX },
    403: forbidden403,
    404: auction404,
  },
});
