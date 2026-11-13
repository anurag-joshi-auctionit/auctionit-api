import { z } from "zod";
import { ErrorBody } from "../common.js";
import { documentRouter } from "../define.js";
import { EmailQueued } from "../responses/email.js";

// Docs for src/routes/email.ts — see docs/api/README.md.
const r = documentRouter("/email");

// Recreated from `sendSchema` in src/routes/email.ts (defined inline there).
const emailRecipients = z
  .union([z.string(), z.array(z.string())])
  .describe("One address, a comma-separated list, or an array of addresses.");

const emailSendSchema = z.object({
  to: emailRecipients,
  subject: z.string().trim().min(1).max(300),
  html: z.string().min(1).max(100_000).describe("HTML email body."),
  cc: emailRecipients.optional(),
  bcc: emailRecipients.optional(),
  notificationId: z.coerce.number().int().positive().describe("Notification type the email is logged under."),
  auctionId: z.coerce.number().int().positive().nullable().optional(),
});

r.post("/send", {
  summary: "Queue an email",
  description:
    "Validates the recipients and adds the email to the outgoing queue; delivery happens asynchronously " +
    "via the email dispatcher.",
  body: emailSendSchema,
  responses: {
    202: { description: "Email queued.", schema: EmailQueued },
    400: {
      description: "Invalid input, no `to` recipient, or one or more invalid email addresses (listed in `error`).",
      schema: ErrorBody,
    },
  },
});
