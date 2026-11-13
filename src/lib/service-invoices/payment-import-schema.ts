import { z } from "zod";
import { ServiceInvoicesValidationMessages as M } from "@auctionit/messages/service-invoices";
import { istTodayDateOnly } from "./schemas.js";

export const serviceInvoicePaymentImportRowSchema = z.object({
  invoiceId: z
    .number({
      required_error: M.PAYMENT_IMPORT_INVOICE_ID_REQUIRED,
      invalid_type_error: M.PAYMENT_IMPORT_INVOICE_ID_INVALID,
    })
    .int(M.PAYMENT_IMPORT_INVOICE_ID_INVALID)
    .positive(M.PAYMENT_IMPORT_INVOICE_ID_INVALID),
  invoiceNo: z
    .string({
      required_error: M.PAYMENT_IMPORT_INVOICE_NO_REQUIRED,
      invalid_type_error: M.PAYMENT_IMPORT_INVOICE_NO_REQUIRED,
    })
    .trim()
    .min(1, M.PAYMENT_IMPORT_INVOICE_NO_REQUIRED),
  paidAmount: z
    .number({
      required_error: M.PAID_AMOUNT_REQUIRED,
      invalid_type_error: M.PAID_AMOUNT_INVALID,
    })
    .finite()
    .positive(M.PAID_AMOUNT_POSITIVE),
  paidAt: z
    .string({
      required_error: M.PAID_AT_REQUIRED,
      invalid_type_error: M.PAID_AT_REQUIRED,
    })
    .regex(/^\d{4}-\d{2}-\d{2}$/, M.PAID_AT_INVALID)
    .refine((v) => v <= istTodayDateOnly(), M.PAID_AT_FUTURE),
});

export type ServiceInvoicePaymentImportRowInput = z.infer<
  typeof serviceInvoicePaymentImportRowSchema
>;
