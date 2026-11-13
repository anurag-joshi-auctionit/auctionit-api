import { z } from "zod";
import {
  liftingClientLogBodySchema,
  liftingClientLogUpdateBodySchema,
  liftingClientsImportScopeQuerySchema,
  liftingClientsListQuerySchema,
  liftingClientsLogsListQuerySchema,
} from "../../lib/lifting-clients/schemas.js";
import { BinaryFile, ErrorBody, ValidationErrorBody } from "../common.js";
import { documentRouter } from "../define.js";
import { LiftingNotFoundBody } from "../responses/lifting.js";
import {
  LiftingClientFilterAuctions,
  LiftingClientFilterClients,
  LiftingClientLogList,
  LiftingClientLogUpdated,
  LiftingClientLot,
  LiftingClientLotList,
  LiftingClientLotResponse,
} from "../responses/lifting-clients.js";

// Docs for src/routes/lifting-clients.ts — see docs/api/README.md.
const r = documentRouter("/lifting/clients");

const lotId = z.string().openapi({
  param: { name: "id", in: "path" },
  description: "Lot id. A `prefix:` before the numeric id is tolerated (`abc:123` → 123).",
  example: "123",
});
const LotIdParam = z.object({ id: lotId });

const lotNotFound = { description: "Lot not found or not eligible for lifting.", schema: LiftingNotFoundBody };

r.get("/filter-options/clients", {
  summary: "Clients with lifting lots",
  responses: { 200: LiftingClientFilterClients },
});

r.get("/filter-options/auctions", {
  summary: "Auctions for the selected clients",
  description: "Auctions of the given clients that have lifting lots. Empty when `clientIds` is empty.",
  query: z.object({
    clientIds: z.string().optional().describe("Comma-separated client ids, e.g. `12,15`."),
  }),
  responses: { 200: LiftingClientFilterAuctions },
});

r.get("/import/template", {
  summary: "Download lifting import template",
  description:
    "Excel workbook pre-filled with the lots in scope (clients × auctions, optional disposition), ready to fill in " +
    "lifted quantities and re-upload via POST /lifting/clients/import. `auctionIds` (or legacy `auctionKeys`) is a " +
    "comma-separated list; at least one client and one auction are required.",
  query: liftingClientsImportScopeQuerySchema,
  responses: {
    200: {
      description: "XLSX template.",
      schema: BinaryFile,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    400: { description: "Missing or invalid client/auction scope.", schema: ValidationErrorBody },
  },
});

r.post("/import", {
  summary: "Import lifting logs from Excel (SSE)",
  description:
    "Uploads a filled template (max 20 MB, .xlsx only) and streams progress as Server-Sent Events. The response is " +
    "always `200 text/event-stream`; validation problems (missing scope, missing/invalid file, too large) arrive as an " +
    "`error` event rather than an HTTP error status.\n\n" +
    "Events:\n" +
    "- `progress` — `LiftingImportProgress` `{ phase: \"parse\"|\"import\", processed, total, percent, label }`, repeated.\n" +
    "- `complete` — `LiftingImportResult` `{ imported, failed, skipped, issues[], issuesTruncated? }`; stream ends.\n" +
    "- `error` — `LiftingImportError` `{ message, code? }` (`code: \"invalid_scope\"` for a bad scope); stream ends.",
  body: z.object({
    file: BinaryFile.openapi({ description: "Filled lifting import template (.xlsx)." }),
    clientIds: z.string().describe("Comma-separated client ids (required)."),
    auctionIds: z.string().optional().describe("Comma-separated auction ids; required unless `auctionKeys` is sent."),
    auctionKeys: z.string().optional().describe("Legacy alternative to `auctionIds` (`prefix:id` values)."),
  }),
  responses: {
    200: {
      description: "SSE stream of `progress`, then `complete` or `error` events (see description).",
      schema: z.string(),
      contentType: "text/event-stream",
    },
  },
});

r.get("/", {
  summary: "List lifting lots (client side)",
  description:
    "Paginated lots for the selected clients and auctions. Returns an empty page unless `clientIds` is set and " +
    "either `auctionIds`/`auctionKeys` or `allRecentAuctions=true` is given. `clientIds` and `auctionIds` are " +
    "comma-separated. `sortBy` accepts auctionDate, approvedQty, totalLiftedQty, balanceQty, lastLiftedDate.",
  query: liftingClientsListQuerySchema,
  responses: { 200: LiftingClientLotList, 400: { description: "Invalid query.", schema: ValidationErrorBody } },
});

r.get("/:id", {
  summary: "Get lifting lot (client side)",
  params: LotIdParam,
  responses: {
    200: LiftingClientLotResponse,
    400: { description: "Missing lot id.", schema: ValidationErrorBody },
    404: lotNotFound,
  },
});

r.get("/:id/logs", {
  summary: "List lifting logs for a lot",
  params: LotIdParam,
  query: liftingClientsLogsListQuerySchema,
  responses: {
    200: LiftingClientLogList,
    400: { description: "Missing lot id or invalid query.", schema: ValidationErrorBody },
    404: lotNotFound,
  },
});

r.post("/:id/logs", {
  summary: "Add a lifting log",
  description:
    "Records a lifted quantity reported by the client. `liftedDate` is YYYY-MM-DD and cannot be in the future " +
    "(IST); `dispositionStatus` must be an active client disposition.",
  params: LotIdParam,
  body: liftingClientLogBodySchema,
  responses: {
    201: { description: "Updated lot.", schema: z.object({ lot: LiftingClientLot }) },
    400: { description: "Invalid input or disposition (as `fieldErrors`).", schema: ValidationErrorBody },
    401: { description: "No user on the session.", schema: ErrorBody },
    404: lotNotFound,
  },
});

r.patch("/:id/logs/:logId", {
  summary: "Update a lifting log",
  description: "Replaces the log's values (all fields required, same rules as creating one).",
  params: z.object({
    id: lotId,
    logId: z.string().openapi({ param: { name: "logId", in: "path" }, example: "456" }),
  }),
  body: liftingClientLogUpdateBodySchema,
  responses: {
    200: { description: "Updated lot and log.", schema: LiftingClientLogUpdated },
    400: { description: "Missing ids, invalid input or disposition.", schema: ValidationErrorBody },
    401: { description: "No user on the session.", schema: ErrorBody },
    404: {
      description: "Lot not found (`lot_not_found`) or log not found (`log_not_found`).",
      schema: LiftingNotFoundBody,
    },
  },
});
