import {
  SmsErrorMessages,
  SmsValidationMessages,
} from "@auctionit/messages/sms";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { zodValidationErrorBody } from "../lib/validation-error.js";
import { smsService } from "../services/sms.service.js";

const router = Router();
router.use(requireAuth);

router.get("/templates", async (_req, res, next) => {
  try {
    const items = await smsService.listTemplates();
    res.json({ items });
  } catch (e) {
    next(e);
  }
});

const sendSchema = z.object({
  templateId: z.number().int().positive(),
  mobile: z
    .string()
    .trim()
    .regex(/^[0-9]{10,15}$/, SmsValidationMessages.MOBILE_INVALID),
  variables: z.record(z.string()).default({}),
});

router.post("/send", async (req, res, next) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error));
    return;
  }
  try {
    const outcome = await smsService.send(parsed.data);
    res.status(201).json({ ok: true, ...outcome });
  } catch (e) {
    if (e instanceof Error) {
      if (e.message === "TEMPLATE_NOT_FOUND") {
        res.status(404).json({ error: SmsErrorMessages.TEMPLATE_NOT_FOUND });
        return;
      }
      if (e.message === "MISSING_VARIABLES") {
        const missing = (e as Error & { missing?: string[] }).missing ?? [];
        res
          .status(400)
          .json({ error: SmsValidationMessages.MISSING_VALUES(missing.join(", ")) });
        return;
      }
      if (e.message === "GATEWAY_ERROR") {
        const detail = (e as Error & { gatewayResponse?: string })
          .gatewayResponse;
        res.status(502).json({
          error: detail
            ? SmsErrorMessages.GATEWAY_REJECTED_DETAIL(detail.slice(0, 200))
            : SmsErrorMessages.GATEWAY_REJECTED,
        });
        return;
      }
    }
    next(e);
  }
});

export default router;
