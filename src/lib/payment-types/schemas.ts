import { z } from "zod";

export const createPaymentTypeSchema = z.object({
  name: z.string().trim().min(1).max(50),
  isActive: z.boolean().optional().default(true),
});

export const patchPaymentTypeSchema = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  isActive: z.boolean().optional(),
});

export type CreatePaymentTypeInput = z.infer<typeof createPaymentTypeSchema>;
export type PatchPaymentTypeInput = z.infer<typeof patchPaymentTypeSchema>;
