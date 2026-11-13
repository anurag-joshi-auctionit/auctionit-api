import { z } from "zod";
import { closedDateRangeQuerySchema } from "../../lib/closed-auction-date-range.js";
import { ErrorBody } from "../common.js";
import { documentRouter } from "../define.js";
import {
  BidderDashboardClients,
  BidderDashboardLifting,
  BidderDashboardLiftingFilters,
} from "../responses/bidder-dashboard.js";

// Docs for src/routes/bidder-dashboard.ts — see docs/api/README.md.
const r = documentRouter("/bidder/dashboard");

/**
 * The routes use `closedDateRangeQuerySchema.and(z.object({...}))`; OpenAPI query params need a
 * flat object, so the docs merge the same fields (the from/to refinements are described in prose).
 */
function rangeWith<T extends z.ZodRawShape>(extra: z.ZodObject<T>) {
  return closedDateRangeQuerySchema.innerType().merge(extra);
}

// Recreated from src/routes/bidder-dashboard.ts (liftingQuerySchema / filtersQuerySchema).
const liftingQuerySchema = rangeWith(
  z.object({
    clientId: z.coerce.number().int().positive().optional(),
    plantLocationId: z.coerce.number().int().positive().optional(),
    itemId: z.coerce.number().int().positive().optional(),
  }),
);

const filtersQuerySchema = rangeWith(
  z.object({
    clientId: z.coerce.number().int().positive().optional(),
  }),
);

const RANGE_NOTE =
  "`from` and `to` (`YYYY-MM-DD`, inclusive auction dates) are both required; `from` must not be after `to`. " +
  "Only approved, won lots of the logged-in bidder in closed auctions, with quantities in MT, are counted.";

const range400 = {
  description:
    "Invalid query (`ValidationErrorBody` with `fieldErrors`), or `from`/`to` missing (plain `{ error }`).",
  schema: ErrorBody,
};
const notBidder403 = {
  description: "The session user is not linked to a bidder, or lacks the bidder portal role/permission.",
  schema: ErrorBody,
};

r.get("/clients", {
  summary: "Clients the bidder won lots from",
  description: `Sellers for the client filter. ${RANGE_NOTE}`,
  query: closedDateRangeQuerySchema,
  responses: { 200: BidderDashboardClients, 400: range400, 403: notBidder403 },
});

r.get("/lifting/filters", {
  summary: "Lifting filter options",
  description: `Plant locations and items for the lifting filters, optionally narrowed to one client. ${RANGE_NOTE}`,
  query: filtersQuerySchema,
  responses: { 200: BidderDashboardLiftingFilters, 400: range400, 403: notBidder403 },
});

r.get("/lifting", {
  summary: "Lifting details",
  description: `Approved / lifted / pending MT and values, per seller and as a time series. ${RANGE_NOTE}`,
  query: liftingQuerySchema,
  responses: { 200: BidderDashboardLifting, 400: range400, 403: notBidder403 },
});
