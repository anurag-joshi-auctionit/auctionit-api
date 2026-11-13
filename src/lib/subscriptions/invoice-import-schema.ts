import { z } from "zod";
import { SubscriptionsValidationMessages as M } from "@auctionit/messages/subscriptions";
import { subscriptionInvoiceUploadFieldsSchema } from "./schemas.js";

export const subscriptionInvoiceImportRowSchema = z
  .object({
    invoiceId: z
      .number({
        required_error: M.INVOICE_IMPORT_INVOICE_ID_REQUIRED,
        invalid_type_error: M.INVOICE_IMPORT_INVOICE_ID_INVALID,
      })
      .int(M.INVOICE_IMPORT_INVOICE_ID_INVALID)
      .positive(M.INVOICE_IMPORT_INVOICE_ID_INVALID),
    bidderId: z
      .number({
        required_error: M.INVOICE_IMPORT_BIDDER_ID_REQUIRED,
        invalid_type_error: M.INVOICE_IMPORT_BIDDER_ID_INVALID,
      })
      .int(M.INVOICE_IMPORT_BIDDER_ID_INVALID)
      .positive(M.INVOICE_IMPORT_BIDDER_ID_INVALID),
    invoiceNo: subscriptionInvoiceUploadFieldsSchema.shape.invoiceNumber,
    invoiceDate: subscriptionInvoiceUploadFieldsSchema.shape.invoiceDate,
    invoicePdfFilename: z
      .string({
        required_error: M.INVOICE_IMPORT_PDF_FILENAME_REQUIRED,
        invalid_type_error: M.INVOICE_IMPORT_PDF_FILENAME_REQUIRED,
      })
      .trim()
      .min(1, M.INVOICE_IMPORT_PDF_FILENAME_REQUIRED),
  });

export type SubscriptionInvoiceImportRowInput = z.infer<
  typeof subscriptionInvoiceImportRowSchema
>;
