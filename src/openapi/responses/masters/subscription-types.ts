import { z } from "../../zod.js";

// Mirrors SubscriptionTypeDto in services/masters/subscription-types.service.ts.

export const MasterSubscriptionType = z
  .object({
    id: z.number().int().openapi({ description: "Id 0 is a placeholder row that cannot be edited." }),
    name: z.string(),
    amount: z.number().openapi({ description: "Price excluding GST." }),
    gstPercent: z.number(),
    months: z.number().int().nullable().openapi({ description: "Subscription duration in months." }),
    isActive: z.boolean(),
  })
  .openapi("MasterSubscriptionType");

export const MasterSubscriptionTypeArray = z.array(MasterSubscriptionType).openapi("MasterSubscriptionTypeArray");
