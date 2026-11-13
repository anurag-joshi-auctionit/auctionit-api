import { z } from "zod";
import {
  createSubscriptionTypeSchema,
  patchSubscriptionTypeSchema,
} from "../../../lib/subscription-types/schemas.js";
import { ErrorBody, IdParam, ValidationErrorBody } from "../../common.js";
import { documentRouter } from "../../define.js";
import { MasterSubscriptionType, MasterSubscriptionTypeArray } from "../../responses/masters/subscription-types.js";

// Docs for src/routes/masters/subscription-types.ts — see docs/api/README.md.
const r = documentRouter("/masters/subscription-types");

r.get("/", {
  summary: "List subscription types",
  description: "All subscription plans (not paginated). Only the literal string `activeOnly=true` filters to active rows.",
  // Read ad hoc in the handler: `req.query.activeOnly === "true"`.
  query: z.object({ activeOnly: z.enum(["true", "false"]).optional() }),
  responses: { 200: MasterSubscriptionTypeArray },
});

r.get("/options", {
  summary: "Active subscription types",
  responses: { 200: MasterSubscriptionTypeArray },
});

r.post("/", {
  summary: "Create subscription type",
  description: "Amount and GST percent are stored with 2 decimals.",
  body: createSubscriptionTypeSchema,
  responses: {
    201: { description: "Created subscription type.", schema: MasterSubscriptionType },
    400: {
      description: "Invalid input, or a subscription type with this name already exists.",
      schema: ValidationErrorBody,
    },
  },
});

r.patch("/:id", {
  summary: "Update subscription type",
  description: "Partial update. The placeholder type with id 0 cannot be edited.",
  params: IdParam,
  body: patchSubscriptionTypeSchema,
  responses: {
    200: MasterSubscriptionType,
    400: {
      description: "Invalid id or input, duplicate name, or an attempt to edit the id-0 placeholder.",
      schema: ValidationErrorBody,
    },
    404: { description: "Subscription type not found.", schema: ErrorBody },
  },
});
