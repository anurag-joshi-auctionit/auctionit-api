import { closedDateRangeQuerySchema } from "../../lib/closed-auction-date-range.js";
import { ErrorBody } from "../common.js";
import { documentRouter } from "../define.js";
import {
  AdminDashboardAuctions,
  AdminDashboardBidders,
  AdminDashboardClients,
  AdminDashboardLifting,
  AdminDashboardMaterials,
  AdminDashboardServiceInvoices,
  AdminDashboardSubscriptions,
} from "../responses/admin-dashboard.js";

// Docs for src/routes/admin-dashboard.ts — see docs/api/README.md.
const r = documentRouter("/admin/dashboard");

const RANGE_NOTE =
  "`from` and `to` (`YYYY-MM-DD`, inclusive, by auction/event date) are both required even though the schema marks them optional; " +
  "`from` must not be after `to`.";

const range400 = {
  description:
    "Invalid query (`ValidationErrorBody` with `fieldErrors`), or `from`/`to` missing (plain `{ error }`).",
  schema: ErrorBody,
};

r.get("/auctions", {
  summary: "Auctions dashboard",
  description: `Auction count, auctioned / lifted value, average bidders per lot and total revenue for the range, plus a time series. ${RANGE_NOTE}`,
  query: closedDateRangeQuerySchema,
  responses: { 200: AdminDashboardAuctions, 400: range400 },
});

r.get("/clients", {
  summary: "Clients dashboard",
  description: `New / active / with-auctions / dormant client counts and the top 5 clients by sale value. ${RANGE_NOTE}`,
  query: closedDateRangeQuerySchema,
  responses: { 200: AdminDashboardClients, 400: range400 },
});

r.get("/bidders", {
  summary: "Bidders dashboard",
  description: `New, pending-verification, bank-update-pending and participating bidder counts, a new-bidder series and the top 5 bidders by win value. ${RANGE_NOTE}`,
  query: closedDateRangeQuerySchema,
  responses: { 200: AdminDashboardBidders, 400: range400 },
});

r.get("/materials", {
  summary: "Top materials",
  description: `Top 5 materials by quantity sold (lots with a winner) in auctions within the range. ${RANGE_NOTE}`,
  query: closedDateRangeQuerySchema,
  responses: { 200: AdminDashboardMaterials, 400: range400 },
});

r.get("/lifting", {
  summary: "Lifting dashboard",
  description: `Auctioned, bid, approved and lifted values for the range, plus a time series. ${RANGE_NOTE}`,
  query: closedDateRangeQuerySchema,
  responses: { 200: AdminDashboardLifting, 400: range400 },
});

r.get("/service-invoices", {
  summary: "Service invoices dashboard",
  description: `Invoices generated, invoiced and collected amounts in range, outstanding as of today, an invoiced/collected series and the top 5 clients by unpaid amount. ${RANGE_NOTE}`,
  query: closedDateRangeQuerySchema,
  responses: { 200: AdminDashboardServiceInvoices, 400: range400 },
});

r.get("/subscriptions", {
  summary: "Subscriptions dashboard",
  description: `New subscriptions and amount in range, active today, expiring within 30 days, plus a series. ${RANGE_NOTE}`,
  query: closedDateRangeQuerySchema,
  responses: { 200: AdminDashboardSubscriptions, 400: range400 },
});
