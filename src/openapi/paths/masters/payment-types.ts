import { createPaymentTypeSchema, patchPaymentTypeSchema } from "../../../lib/payment-types/schemas.js";
import { ErrorBody, IdParam, ValidationErrorBody } from "../../common.js";
import { documentRouter } from "../../define.js";
import {
  MasterPaymentType,
  MasterPaymentTypeList,
  MasterPaymentTypeOptions,
} from "../../responses/masters/payment-types.js";

// Docs for src/routes/masters/payment-types.ts — see docs/api/README.md.
const r = documentRouter("/masters/payment-types");

r.get("/", {
  summary: "List payment types",
  description: "All payment types including inactive ones, wrapped in `{ items }` (not paginated).",
  responses: { 200: MasterPaymentTypeList },
});

r.get("/options", {
  summary: "Active payment types",
  description: "Bare array of active payment types for select inputs.",
  responses: { 200: MasterPaymentTypeOptions },
});

r.post("/", {
  summary: "Create payment type",
  body: createPaymentTypeSchema,
  responses: {
    201: { description: "Created payment type.", schema: MasterPaymentType },
    400: { description: "Invalid input, or a payment type with this name already exists.", schema: ValidationErrorBody },
  },
});

r.patch("/:id", {
  summary: "Update payment type",
  params: IdParam,
  body: patchPaymentTypeSchema,
  responses: {
    200: MasterPaymentType,
    400: { description: "Invalid id or input, or another payment type already has this name.", schema: ValidationErrorBody },
    404: { description: "Payment type not found.", schema: ErrorBody },
  },
});
