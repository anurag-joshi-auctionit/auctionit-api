import { z } from "zod";
import { closedDateRangeQuerySchema } from "../../lib/closed-auction-date-range.js";
import { ErrorBody } from "../common.js";
import { documentRouter } from "../define.js";
import {
  ClientDashboardAuctions,
  ClientDashboardBidder,
  ClientDashboardClients,
  ClientDashboardLifting,
  ClientDashboardMaterialFilters,
  ClientDashboardMaterialSeries,
  ClientDashboardSummary,
} from "../responses/client-dashboard.js";

// Docs for src/routes/client-dashboard.ts — see docs/api/README.md.
const r = documentRouter("/client/dashboard");

/**
 * The routes use `closedDateRangeQuerySchema.and(z.object({...}))`; OpenAPI query params need a
 * flat object, so the docs merge the same fields (the from/to refinements are described in prose).
 */
function rangeWith<T extends z.ZodRawShape>(extra: z.ZodObject<T>) {
  return closedDateRangeQuerySchema.innerType().merge(extra);
}

// Recreated from src/routes/client-dashboard.ts.
const clientIdQuerySchema = z.object({
  clientId: z.coerce.number().int().positive(),
});
const rangeClientSchema = rangeWith(clientIdQuerySchema);
const materialQuerySchema = rangeClientSchema.extend({
  plantLocationId: z.coerce.number().int().positive().optional(),
  itemId: z.coerce.number().int().positive().optional(),
});
const bidderQuerySchema = rangeClientSchema.extend({
  auctionId: z.coerce.number().int().positive().optional(),
});

const RANGE_NOTE =
  "`clientId` must be one of the user's linked clients. `from` and `to` (`YYYY-MM-DD`, inclusive auction dates) are both required; " +
  "`from` must not be after `to`. Only closed, active auctions count.";

const range400 = {
  description:
    "Invalid query (`ValidationErrorBody` with `fieldErrors`), or `from`/`to` missing (plain `{ error }`).",
  schema: ErrorBody,
};
const forbidden403 = { description: "The client is not linked to the user.", schema: ErrorBody };

r.get("/clients", {
  summary: "Linked clients",
  description: "Active clients linked to the logged-in user, for the client picker.",
  responses: { 200: ClientDashboardClients },
});

r.get("/auctions", {
  summary: "Closed auctions in range",
  description: `Closed auctions of the client in the range, newest first. ${RANGE_NOTE}`,
  query: rangeClientSchema,
  responses: { 200: ClientDashboardAuctions, 400: range400, 403: forbidden403 },
});

r.get("/summary", {
  summary: "Dashboard summary",
  description:
    "Headline metrics for the range, each with the value for the equal-length period immediately before it, " +
    `plus lifting delay reasons. ${RANGE_NOTE}`,
  query: rangeClientSchema,
  responses: { 200: ClientDashboardSummary, 400: range400, 403: forbidden403 },
});

r.get("/material/filters", {
  summary: "Material filter options",
  description: `Plant locations and items for the Material Details filters. ${RANGE_NOTE}`,
  query: rangeClientSchema,
  responses: { 200: ClientDashboardMaterialFilters, 400: range400, 403: forbidden403 },
});

r.get("/material", {
  summary: "Material details series",
  description: `Offered / bid / approved quantities and amounts (lakh) per period, optionally for one plant or item. ${RANGE_NOTE}`,
  query: materialQuerySchema,
  responses: { 200: ClientDashboardMaterialSeries, 400: range400, 403: forbidden403 },
});

r.get("/lifting", {
  summary: "Lifting details",
  description:
    "Approved, lifted and pending MT per auction (approved, won lots in MT), with a break-up of lifted MT by days since the auction. " +
    RANGE_NOTE,
  query: rangeClientSchema,
  responses: { 200: ClientDashboardLifting, 400: range400, 403: forbidden403 },
});

r.get("/bidder", {
  summary: "Bidder details",
  description: `Attached, participated and new bidder counts with prior-period deltas, optionally for one auction. ${RANGE_NOTE}`,
  query: bidderQuerySchema,
  responses: {
    200: ClientDashboardBidder,
    400: range400,
    403: forbidden403,
    404: {
      description: "`auctionId` is not a closed auction of this client within the range.",
      schema: ErrorBody,
    },
  },
});
