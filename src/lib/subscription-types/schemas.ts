import { gstRateCoerceZod } from "@auctionit/lib/gst-rates";
import { SubscriptionsValidationMessages as M } from "@auctionit/messages/subscriptions";
import { z } from "zod";

export const createSubscriptionTypeSchema = z.object({
  name: z.string().trim().min(1, M.NAME_REQUIRED).max(50),
  amount: z.coerce.number().gt(0, M.AMOUNT_MUST_BE_POSITIVE),
  gstPercent: gstRateCoerceZod,
  months: z.coerce
    .number()
    .int(M.MONTHS_MUST_BE_POSITIVE_INTEGER)
    .min(1, M.MONTHS_MUST_BE_POSITIVE_INTEGER)
    .max(12000),
  isActive: z.boolean().optional().default(true),
});

export const patchSubscriptionTypeSchema = z.object({
  name: z.string().trim().min(1, M.NAME_REQUIRED).max(50).optional(),
  amount: z.coerce.number().gt(0, M.AMOUNT_MUST_BE_POSITIVE).optional(),
  gstPercent: gstRateCoerceZod.optional(),
  months: z.coerce
    .number()
    .int(M.MONTHS_MUST_BE_POSITIVE_INTEGER)
    .min(1, M.MONTHS_MUST_BE_POSITIVE_INTEGER)
    .max(12000)
    .optional(),
  isActive: z.boolean().optional(),
});

export type CreateSubscriptionTypeInput = z.infer<
  typeof createSubscriptionTypeSchema
>;
export type PatchSubscriptionTypeInput = z.infer<
  typeof patchSubscriptionTypeSchema
>;
