import { z } from "zod";
import { ITEMS_EXPORT_MAX_ROWS } from "../../lib/items/export-constants.js";
import {
  createItemSchema,
  itemsExportQuerySchema,
  itemsListQuerySchema,
  itemsStatsQuerySchema,
  patchItemSchema,
} from "../../lib/items/schemas.js";
import { entityOptionIdsQuerySchema, entityOptionsQuerySchema } from "../../lib/options-query.js";
import { BinaryFile, ErrorBody, IdParam, OptionIdsResult, ValidationErrorBody } from "../common.js";
import { documentRouter } from "../define.js";
import { Item, ItemCounts, ItemList, ItemOptions } from "../responses/items.js";

const r = documentRouter("/items");

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const clientScoped = { clientId: z.coerce.number().int().positive() };

r.get("/stats", {
  summary: "Item counts",
  description: "Total / active / inactive item counts, optionally for one client.",
  query: itemsStatsQuerySchema,
  responses: { 200: ItemCounts },
});

r.get("/options", {
  summary: "Item options for a picker",
  description:
    "Active items of one client for select inputs. Empty `q` returns up to `limit` (max 100); " +
    "a search returns all matches. Ids in `ids` are always included.",
  query: entityOptionsQuerySchema.extend(clientScoped),
  responses: { 200: ItemOptions },
});

r.get("/options/ids", {
  summary: "Item ids matching a search (select all)",
  query: entityOptionIdsQuerySchema.extend(clientScoped),
  responses: { 200: OptionIdsResult },
});

r.get("/", {
  summary: "List items",
  description: "Paginated, filterable item list with counts for the status tabs.",
  query: itemsListQuerySchema,
  responses: { 200: ItemList },
});

r.get("/export", {
  summary: "Export filtered items",
  description: `All items matching the list filters, as \`items-export-<yyyy-MM-dd>.xlsx\`. Same filters as the list endpoint, minus pagination; capped at ${ITEMS_EXPORT_MAX_ROWS.toLocaleString()} rows.`,
  query: itemsExportQuerySchema,
  responses: {
    200: { description: "Items workbook.", schema: BinaryFile, contentType: XLSX },
  },
});

r.get("/:id", {
  summary: "Get item",
  params: IdParam,
  responses: {
    200: Item,
    404: { description: "Item not found.", schema: ErrorBody },
  },
});

r.post("/", {
  summary: "Create item",
  body: createItemSchema,
  responses: {
    201: { description: "Created item.", schema: Item },
    400: { description: "Invalid input, or the client/material/benchmark material does not exist.", schema: ValidationErrorBody },
  },
});

r.patch("/:id", {
  summary: "Update item",
  description: "Partial update; at least one field is required.",
  params: IdParam,
  body: patchItemSchema,
  responses: {
    200: Item,
    400: { description: "Invalid input, or the material/benchmark material does not exist.", schema: ValidationErrorBody },
    404: { description: "Item not found.", schema: ErrorBody },
  },
});
