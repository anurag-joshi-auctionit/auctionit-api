import { SERVICE_FEE_TYPES } from "@auctionit/messages/clients";
import {
  SERVICE_INVOICE_STATUSES,
  SERVICE_INVOICE_TYPES,
  ServiceInvoicesValidationMessages as M,
} from "@auctionit/messages/service-invoices";
import { z } from "zod";

const requiredString = (message: string) =>
  z
    .string({
      required_error: message,
      invalid_type_error: message,
    })
    .trim()
    .min(1, message);

const nonNegNumber = (requiredMessage: string, invalidMessage: string) =>
  z.coerce
    .number({
      required_error: requiredMessage,
      invalid_type_error: requiredMessage,
    })
    .finite()
    .min(0, invalidMessage);

const requiredFeeValue = z.coerce
  .number({
    required_error: M.FEE_VALUE_REQUIRED,
    invalid_type_error: M.FEE_VALUE_REQUIRED,
  })
  .finite()
  .min(0, M.FEE_VALUE_POSITIVE);

const requiredGracePeriod = z.coerce
  .number({
    required_error: M.GRACE_PERIOD_REQUIRED,
    invalid_type_error: M.GRACE_PERIOD_REQUIRED,
  })
  .int({ message: M.GRACE_PERIOD_INVALID })
  .min(0, M.GRACE_PERIOD_INVALID);

/** Calendar YYYY-MM-DD only (rejects 2026-02-31 and non-date strings). */
export function isValidIsoDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/** Local business calendar day (Asia/Kolkata) as YYYY-MM-DD. */
export function istTodayDateOnly(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

const requiredIsoDate = (requiredMessage: string, invalidMessage: string) =>
  requiredString(requiredMessage).refine(isValidIsoDateOnly, invalidMessage);

/** Form selects often send `""`; treat as missing and always use a field message. */
function requiredStringEnum<const T extends readonly [string, ...string[]]>(
  values: T,
  message: string,
) {
  return z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    z.enum(values, {
      errorMap: () => ({ message }),
    }),
  );
}

function optionalStringEnum<const T extends readonly [string, ...string[]]>(
  values: T,
  message: string,
) {
  return z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    z
      .enum(values, {
        errorMap: () => ({ message }),
      })
      .optional(),
  );
}

export const SERVICE_INVOICE_SORT_FIELDS = [
  "id",
  "clientName",
  "fromDate",
  "toDate",
  "grandTotal",
  "status",
  "createdAt",
] as const;

export const serviceInvoicesListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().optional(),
  clientId: z.coerce.number().int().positive().optional(),
  status: z.enum(SERVICE_INVOICE_STATUSES).optional(),
  type: z.enum(SERVICE_INVOICE_TYPES).optional(),
  serviceFeeType: z.enum(SERVICE_FEE_TYPES).optional(),
  sortBy: z.enum(SERVICE_INVOICE_SORT_FIELDS).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
  dateField: z
    .enum([
      "period",
      "createdAt",
      "requestedAt",
      "generatedAt",
      "recheckedAt",
      "cancelledAt",
    ])
    .optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  excludeDraft: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .optional()
    .transform((v) => v === true || v === "true"),
  outstanding: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .optional()
    .transform((v) => v === true || v === "true"),
});

export type ServiceInvoicesListParams = z.infer<
  typeof serviceInvoicesListQuerySchema
>;

export const serviceInvoicesExportQuerySchema = serviceInvoicesListQuerySchema
  .omit({ page: true, pageSize: true })
  .extend({
    ids: z.string().optional(),
  });

export type ServiceInvoicesExportQuery = z.infer<
  typeof serviceInvoicesExportQuerySchema
>;

/** Parsed export params: filters + numeric ids (not the raw query-string `ids`). */
export type ServiceInvoicesExportParams = Omit<
  ServiceInvoicesExportQuery,
  "ids"
> & {
  ids?: number[];
};

/** Parse comma-separated invoice IDs; dedupe and cap at maxRows. */
export function parseServiceInvoiceExportIds(
  raw: string | undefined,
  maxRows: number,
): number[] {
  if (!raw?.trim()) return [];
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const part of raw.split(",")) {
    const n = Number(part.trim());
    if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    ids.push(n);
    if (ids.length >= maxRows) break;
  }
  return ids;
}

export const serviceInvoiceStatsQuerySchema = z.object({
  clientId: z.coerce.number().int().positive().optional(),
});

export type ServiceInvoiceStatsQuery = z.infer<
  typeof serviceInvoiceStatsQuerySchema
>;

export const serviceInvoicePaymentLogBodySchema = z.object({
  paidAmount: z.coerce
    .number({
      required_error: M.PAID_AMOUNT_REQUIRED,
      invalid_type_error: M.PAID_AMOUNT_INVALID,
    })
    .finite()
    .positive(M.PAID_AMOUNT_POSITIVE),
  paidAt: requiredString(M.PAID_AT_REQUIRED)
    .refine((v) => {
      if (isValidIsoDateOnly(v)) return true;
      const d = new Date(v);
      return !Number.isNaN(d.getTime());
    }, M.PAID_AT_INVALID)
    .refine((v) => {
      const dateOnly = isValidIsoDateOnly(v) ? v : v.slice(0, 10);
      if (!isValidIsoDateOnly(dateOnly)) return true;
      return dateOnly <= istTodayDateOnly();
    }, M.PAID_AT_FUTURE),
});

export type ServiceInvoicePaymentLogBody = z.infer<
  typeof serviceInvoicePaymentLogBodySchema
>;

const feeFields = {
  serviceFeeType: requiredStringEnum(SERVICE_FEE_TYPES, M.FEE_TYPE_REQUIRED),
  serviceFeeValue: requiredFeeValue,
  totalQuantity: nonNegNumber(
    M.TOTAL_QUANTITY_REQUIRED,
    M.TOTAL_QUANTITY_INVALID,
  ),
  totalAmount: nonNegNumber(M.TOTAL_AMOUNT_REQUIRED, M.TOTAL_AMOUNT_INVALID),
  gstPercent: nonNegNumber(M.GST_PERCENT_REQUIRED, M.GST_PERCENT_INVALID),
};

export const annexureAutoQuerySchema = z.object({
  clientId: z.coerce.number().int().positive(M.CLIENT_REQUIRED),
  plantLocationId: z.coerce.number().int().positive(M.PLANT_REQUIRED),
  fromDate: requiredIsoDate(M.FROM_DATE_REQUIRED, M.FROM_DATE_INVALID),
  toDate: requiredIsoDate(M.TO_DATE_REQUIRED, M.TO_DATE_INVALID),
});

export const createServiceInvoiceSchema = z
  .object({
    clientId: z
      .number({
        required_error: M.CLIENT_REQUIRED,
        invalid_type_error: M.CLIENT_REQUIRED,
      })
      .int()
      .positive(M.CLIENT_REQUIRED),
    plantLocationId: z
      .number({
        required_error: M.PLANT_REQUIRED,
        invalid_type_error: M.PLANT_REQUIRED,
      })
      .int()
      .positive(M.PLANT_REQUIRED),
    fromDate: requiredIsoDate(M.FROM_DATE_REQUIRED, M.FROM_DATE_INVALID),
    toDate: requiredIsoDate(M.TO_DATE_REQUIRED, M.TO_DATE_INVALID),
    type: requiredStringEnum(SERVICE_INVOICE_TYPES, M.TYPE_REQUIRED),
    orderNumber: z.string().trim().max(100).nullable().optional(),
    orderDate: z.string().trim().nullable().optional(),
    gracePeriod: requiredGracePeriod,
    serviceChargeDescription: requiredString(M.DESCRIPTION_REQUIRED).max(
      3000,
      M.DESCRIPTION_MAX,
    ),
    /** Manual: raw xlsx as base64; persisted to R2 only on create with invoice id. */
    annexureFileBase64: z.string().trim().min(1).optional(),
    status: z.enum(["draft", "requested"], {
      required_error: M.STATUS_REQUIRED,
      invalid_type_error: M.STATUS_INVALID,
    }),
    ...feeFields,
  })
  .refine((d) => new Date(d.toDate) >= new Date(d.fromDate), {
    message: M.DATE_RANGE_INVALID,
    path: ["toDate"],
  })
  .superRefine((d, ctx) => {
    if (d.type === "manual" && !d.annexureFileBase64) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: M.ANNEXURE_REQUIRED,
        path: ["annexureFileBase64"],
      });
    }
  });

export const patchServiceInvoiceSchema = z
  .object({
    plantLocationId: z
      .number({
        required_error: M.PLANT_REQUIRED,
        invalid_type_error: M.PLANT_REQUIRED,
      })
      .int()
      .positive(M.PLANT_REQUIRED)
      .optional(),
    fromDate: requiredIsoDate(M.FROM_DATE_REQUIRED, M.FROM_DATE_INVALID).optional(),
    toDate: requiredIsoDate(M.TO_DATE_REQUIRED, M.TO_DATE_INVALID).optional(),
    type: optionalStringEnum(SERVICE_INVOICE_TYPES, M.TYPE_REQUIRED),
    orderNumber: z.string().trim().max(100).nullable().optional(),
    orderDate: z.string().trim().nullable().optional(),
    gracePeriod: requiredGracePeriod.optional(),
    serviceChargeDescription: requiredString(M.DESCRIPTION_REQUIRED)
      .max(3000, M.DESCRIPTION_MAX)
      .optional(),
    serviceFeeType: optionalStringEnum(
      SERVICE_FEE_TYPES,
      M.FEE_TYPE_REQUIRED,
    ),
    serviceFeeValue: requiredFeeValue.optional(),
    totalQuantity: nonNegNumber(
      M.TOTAL_QUANTITY_REQUIRED,
      M.TOTAL_QUANTITY_INVALID,
    ).optional(),
    totalAmount: nonNegNumber(
      M.TOTAL_AMOUNT_REQUIRED,
      M.TOTAL_AMOUNT_INVALID,
    ).optional(),
    gstPercent: nonNegNumber(
      M.GST_PERCENT_REQUIRED,
      M.GST_PERCENT_INVALID,
    ).optional(),
    status: z
      .enum(["draft", "requested"], {
        required_error: M.STATUS_REQUIRED,
        invalid_type_error: M.STATUS_INVALID,
      })
      .optional(),
    annexureFileBase64: z.string().trim().min(1).optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: M.PATCH_EMPTY,
  })
  .superRefine((d, ctx) => {
    if (
      d.fromDate != null &&
      d.toDate != null &&
      new Date(d.toDate) < new Date(d.fromDate)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: M.DATE_RANGE_INVALID,
        path: ["toDate"],
      });
    }
  });

const accountsInvoiceNumberSchema = z
  .string({
    required_error: M.INVOICE_NUMBER_REQUIRED,
    invalid_type_error: M.INVOICE_NUMBER_REQUIRED,
  })
  .trim()
  .min(1, M.INVOICE_NUMBER_REQUIRED)
  .max(30, M.INVOICE_NUMBER_MAX)
  .regex(/^[A-Za-z0-9][A-Za-z0-9\s\-/#.]*$/, M.INVOICE_NUMBER_INVALID);

const accountsInvoiceDateSchema = z
  .string({
    required_error: M.INVOICE_DATE_REQUIRED,
    invalid_type_error: M.INVOICE_DATE_REQUIRED,
  })
  .trim()
  .min(1, M.INVOICE_DATE_REQUIRED)
  .regex(/^\d{4}-\d{2}-\d{2}$/, M.INVOICE_DATE_INVALID)
  .refine(isValidIsoDateOnly, M.INVOICE_DATE_INVALID)
  .refine((v) => v <= istTodayDateOnly(), M.INVOICE_DATE_FUTURE);

const accountsPaymentDueDateSchema = z
  .string({
    required_error: M.PAYMENT_DUE_DATE_REQUIRED,
    invalid_type_error: M.PAYMENT_DUE_DATE_REQUIRED,
  })
  .trim()
  .min(1, M.PAYMENT_DUE_DATE_REQUIRED)
  .regex(/^\d{4}-\d{2}-\d{2}$/, M.PAYMENT_DUE_DATE_INVALID)
  .refine(isValidIsoDateOnly, M.PAYMENT_DUE_DATE_INVALID);

export const accountsServiceInvoiceActionSchema = z
  .object({
    invoiceNumber: accountsInvoiceNumberSchema.optional(),
    invoiceDate: accountsInvoiceDateSchema.optional(),
    paymentDueDate: accountsPaymentDueDateSchema.optional(),
    status: z
      .enum(["generated", "recheck", "cancelled"], {
        invalid_type_error: M.ACCOUNTS_STATUS_INVALID,
      })
      .optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: M.ACCOUNTS_ACTION_EMPTY,
  })
  .superRefine((d, ctx) => {
    const hasNumber = d.invoiceNumber !== undefined;
    const hasDate = d.invoiceDate !== undefined;
    const hasDue = d.paymentDueDate !== undefined;
    const allOrNone = hasNumber === hasDate && hasDate === hasDue;
    if (!allOrNone) {
      if (!hasNumber) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: M.INVOICE_DETAILS_BOTH_REQUIRED,
          path: ["invoiceNumber"],
        });
      }
      if (!hasDate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: M.INVOICE_DETAILS_BOTH_REQUIRED,
          path: ["invoiceDate"],
        });
      }
      if (!hasDue) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: M.INVOICE_DETAILS_BOTH_REQUIRED,
          path: ["paymentDueDate"],
        });
      }
    }
    if (
      d.invoiceDate &&
      d.paymentDueDate &&
      d.paymentDueDate < d.invoiceDate
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: M.PAYMENT_DUE_DATE_BEFORE_INVOICE_DATE,
        path: ["paymentDueDate"],
      });
    }
  });

export type CreateServiceInvoiceInput = z.infer<
  typeof createServiceInvoiceSchema
>;
export type PatchServiceInvoiceInput = z.infer<
  typeof patchServiceInvoiceSchema
>;
export type AccountsServiceInvoiceActionInput = z.infer<
  typeof accountsServiceInvoiceActionSchema
>;
export type AnnexureAutoQuery = z.infer<typeof annexureAutoQuerySchema>;
