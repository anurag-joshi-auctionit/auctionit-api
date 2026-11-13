import { SmsValidationMessages } from "@auctionit/messages/sms";
import { z } from "zod";
import { ErrorBody } from "../common.js";
import { documentRouter } from "../define.js";
import { SmsSendResult, SmsTemplateList } from "../responses/sms.js";

// Docs for src/routes/sms.ts — see docs/api/README.md.
const r = documentRouter("/sms");

// Recreated from `sendSchema` in src/routes/sms.ts (defined inline there).
const smsSendSchema = z.object({
  templateId: z.number().int().positive().describe("SMS template row id (`id` from GET /sms/templates)."),
  mobile: z
    .string()
    .trim()
    .regex(/^[0-9]{10,15}$/, SmsValidationMessages.MOBILE_INVALID),
  variables: z
    .record(z.string())
    .default({})
    .describe("Values for the template's `{placeholder}` variables, keyed by name."),
});

r.get("/templates", {
  summary: "List SMS templates",
  description: "All SMS templates with their message format and the variable names each one needs.",
  responses: { 200: SmsTemplateList },
});

r.post("/send", {
  summary: "Send an SMS",
  description:
    "Renders the template with `variables` and sends it synchronously through the SMS gateway. " +
    "Every placeholder in the template must have a value.",
  body: smsSendSchema,
  responses: {
    201: { description: "Sent; includes the rendered message and the gateway's reply.", schema: SmsSendResult },
    400: {
      description: "Invalid input, or values missing for some template variables (`Missing values for: …`).",
      schema: ErrorBody,
    },
    404: { description: "Template not found.", schema: ErrorBody },
    502: { description: "The SMS gateway rejected the request.", schema: ErrorBody },
  },
});
