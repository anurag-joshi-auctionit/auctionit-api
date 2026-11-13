import { z } from "zod";
import {
  liftingBiddersListQuerySchema,
  liftingBiddersStatsQuerySchema,
  liftingEngagementBodySchema,
} from "../../lib/lifting-bidders/schemas.js";
import { ErrorBody, ValidationErrorBody } from "../common.js";
import { documentRouter } from "../define.js";
import {
  LiftingEngagementCreated,
  LiftingEngagementList,
  LiftingFilterOptions,
  LiftingLotList,
  LiftingLotResponse,
  LiftingNotFoundBody,
  LiftingStats,
} from "../responses/lifting.js";

// Docs for src/routes/lifting.ts — see docs/api/README.md.
const r = documentRouter("/lifting");

const LotIdParam = z.object({
  id: z
    .string()
    .openapi({
      param: { name: "id", in: "path" },
      description: "Lot id. A `prefix:` before the numeric id is tolerated (`abc:123` → 123).",
      example: "123",
    }),
});

const lotNotFound = { description: "Lot not found or not eligible for lifting.", schema: LiftingNotFoundBody };

r.get("/", {
  summary: "List open lifting lots (bidder side)",
  description:
    "Paginated lots whose lifting is still open, for following up with bidders. `clients` is a comma-separated " +
    "list of client names; `dateField` + `dateFrom`/`dateTo` (YYYY-MM-DD) filter on the chosen date column. " +
    "`sortBy` accepts auctionDate, lotConfirmation, liftingDue, approvedQty, liftedQtyBidder, liftedQtyClient, " +
    "balanceQty, nextFollowup, lastModified.",
  query: liftingBiddersListQuerySchema,
  responses: { 200: LiftingLotList, 400: { description: "Invalid query.", schema: ValidationErrorBody } },
});

r.get("/stats", {
  summary: "Lifting status counts",
  description: "Counts for the status cards. `todayDate` (YYYY-MM-DD) sets the day used for `todayFollowup`.",
  query: liftingBiddersStatsQuerySchema,
  responses: { 200: LiftingStats, 400: { description: "Invalid query.", schema: ValidationErrorBody } },
});

r.get("/filter-options", {
  summary: "Lifting filter options",
  description: "Active clients and bidders that have open lifting lots.",
  responses: { 200: LiftingFilterOptions },
});

r.get("/:id", {
  summary: "Get lifting lot",
  params: LotIdParam,
  responses: {
    200: LiftingLotResponse,
    400: { description: "Missing lot id.", schema: ValidationErrorBody },
    404: lotNotFound,
  },
});

r.get("/:id/engagements", {
  summary: "List bidder engagements for a lot",
  description: "Follow-up log entries recorded against the lot's bidder, newest first.",
  params: LotIdParam,
  responses: {
    200: LiftingEngagementList,
    400: { description: "Missing lot id.", schema: ValidationErrorBody },
    404: lotNotFound,
  },
});

r.post("/:id/engagements", {
  summary: "Log a bidder engagement",
  description:
    "Records a follow-up with the bidder and updates the lot's disposition. `dispositionStatus` must be an active " +
    "bidder disposition; depending on it, `nextFollowup` (a future date-time) and/or `liftedQtyBidder` (≥ 0) are " +
    "required. Field-level failures come back as `fieldErrors`.",
  params: LotIdParam,
  body: liftingEngagementBodySchema,
  responses: {
    201: { description: "Updated lot and the new engagement.", schema: LiftingEngagementCreated },
    400: {
      description: "Invalid input, unknown disposition, or missing/invalid follow-up date or lifted quantity.",
      schema: ValidationErrorBody,
    },
    401: { description: "No user on the session.", schema: ErrorBody },
    404: lotNotFound,
  },
});
