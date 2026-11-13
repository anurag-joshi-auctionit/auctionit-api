import { z } from "../../zod.js";

// Mirrors PaymentTypeDto in services/masters/payment-types.service.ts.

export const MasterPaymentType = z
  .object({ id: z.number().int(), name: z.string(), isActive: z.boolean() })
  .openapi("MasterPaymentType");

export const MasterPaymentTypeList = z
  .object({ items: z.array(MasterPaymentType) })
  .openapi("MasterPaymentTypeList", { description: "All payment types (active and inactive), unpaginated." });

export const MasterPaymentTypeOptions = z.array(MasterPaymentType).openapi({ description: "Active rows only." });
