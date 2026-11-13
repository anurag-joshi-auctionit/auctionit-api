import { Router } from "express";
import { z } from "zod";
import { EmailValidationMessages } from "@auctionit/messages/email";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { zodValidationErrorBody } from "../lib/validation-error.js";
import { emailService } from "../services/email.service.js";

const router = Router();
router.use(requireAuth);
router.use(requirePermission("email.send"));

const recipients = z.union([z.string(), z.array(z.string())]);

const sendSchema = z.object({
  to: recipients,
  subject: z.string().trim().min(1).max(300),
  html: z.string().min(1).max(100_000),
  cc: recipients.optional(),
  bcc: recipients.optional(),
  notificationId: z.coerce.number().int().positive(),
  auctionId: z.coerce.number().int().positive().nullable().optional(),
});

router.post("/send", async (req, res, next) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const result = await emailService.enqueue(parsed.data);
    res.status(202).json({ ok: true, id: result.id, status: "queued" });
  } catch (e) {
    if (e instanceof Error) {
      if (e.message === "NO_RECIPIENT") {
        res
          .status(400)
          .json({ error: EmailValidationMessages.RECIPIENT_REQUIRED });
        return;
      }
      if (e.message === "INVALID_RECIPIENT") {
        const invalid = (e as Error & { invalid?: string[] }).invalid ?? [];
        res.status(400).json({
          error: EmailValidationMessages.INVALID_RECIPIENT(invalid.join(", ")),
        });
        return;
      }
    }
    next(e);
  }
});

export default router;
