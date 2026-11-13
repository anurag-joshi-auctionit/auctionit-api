import { SubscriptionsValidationMessages as M } from "@auctionit/messages/subscriptions";
import { z } from "zod";

/** Calendar YYYY-MM-DD only (rejects 2026-02-31 and non-date strings). */
function isValidIsoDateOnly(value: string): boolean {
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

const requiredPositiveInt = (message: string) =>
  z.coerce
    .number({
      required_error: message,
      invalid_type_error: message,
    })
    .int(message)
    .positive(message);

const requiredPositiveAmount = z.coerce
  .number({
    required_error: M.AMOUNT_REQUIRED,
    invalid_type_error: M.AMOUNT_REQUIRED,
  })
  .finite()
  .positive(M.AMOUNT_MUST_BE_POSITIVE);

const requiredIsoDate = (requiredMessage: string, invalidMessage: string) =>
  z
    .string({
      required_error: requiredMessage,
      invalid_type_error: requiredMessage,
    })
    .trim()
    .min(1, requiredMessage)
    .refine(isValidIsoDateOnly, invalidMessage);

/** Empty / missing → null; otherwise must be a real calendar date. */
const optionalIsoDate = (invalidMessage: string) =>
  z
    .union([z.string(), z.null(), z.undefined()])
    .transform((v) => {
      if (v == null) return null;
      const t = String(v).trim();
      return t === "" ? null : t;
    })
    .refine((v) => v === null || isValidIsoDateOnly(v), invalidMessage);

const optionalMaxString = (max: number, maxMessage: string) =>
  z
    .union([z.string(), z.null(), z.undefined()])
    .transform((v) => {
      if (v == null) return null;
      const t = String(v).trim();
      return t === "" ? null : t;
    })
    .refine((v) => v === null || v.length <= max, maxMessage);

const requiredMaxString = (
  max: number,
  requiredMessage: string,
  maxMessage: string,
) =>
  z
    .string({
      required_error: requiredMessage,
      invalid_type_error: requiredMessage,
    })
    .trim()
    .min(1, requiredMessage)
    .max(max, maxMessage);

export const SUBSCRIPTION_SORT_FIELDS = [
  "paymentDate",
  "createdAt",
  "amount",
  "fromDate",
  "toDate",
] as const;

export const SUBSCRIPTION_DATE_FIELDS = [
  "paymentDate",
  "fromDate",
  "toDate",
  "createdAt",
] as const;

export const subscriptionsListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().optional(),
  sortBy: z.enum(SUBSCRIPTION_SORT_FIELDS).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
  dateField: z.enum(SUBSCRIPTION_DATE_FIELDS).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  invoiceStatus: z
    .enum(["requested", "recheck", "generated", "cancelled"])
    .optional(),
  /** When true, return only the latest subscription row per bidder (by payment_date, then id). */
  latestPerBidder: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .optional()
    .transform((v) => v === true || v === "true"),
});

export type SubscriptionsListQuery = z.infer<typeof subscriptionsListQuerySchema>;

export const accountsSubscriptionInvoiceActionSchema = z.object({
  status: z.enum(["recheck", "cancelled"], {
    required_error: M.STATUS_REQUIRED,
    invalid_type_error: M.ACCOUNTS_STATUS_INVALID,
  }),
});

export type AccountsSubscriptionInvoiceAction = z.infer<
  typeof accountsSubscriptionInvoiceActionSchema
>;

export const adminSubscriptionInvoiceStatusSchema = z.object({
  status: z.enum(["requested"], {
    required_error: M.STATUS_REQUIRED,
    invalid_type_error: M.ADMIN_STATUS_INVALID,
  }),
});

export type AdminSubscriptionInvoiceStatusAction = z.infer<
  typeof adminSubscriptionInvoiceStatusSchema
>;

export const subscriptionsExportQuerySchema = subscriptionsListQuerySchema
  .omit({ page: true, pageSize: true })
  .extend({
    ids: z.string().optional(),
  });

export type SubscriptionsExportQuery = z.infer<
  typeof subscriptionsExportQuerySchema
>;

export type SubscriptionsExportParams = Omit<
  SubscriptionsExportQuery,
  "ids"
> & {
  ids?: number[];
};

export function parseSubscriptionExportIds(
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

export const subscriptionInvoiceUploadFieldsSchema = z.object({
  invoiceNumber: z
    .string({
      required_error: M.INVOICE_NUMBER_REQUIRED,
      invalid_type_error: M.INVOICE_NUMBER_REQUIRED,
    })
    .trim()
    .min(1, M.INVOICE_NUMBER_REQUIRED)
    .max(30, M.INVOICE_NUMBER_MAX)
    .regex(/^[A-Za-z0-9][A-Za-z0-9\s\-/#.]*$/, M.INVOICE_NUMBER_INVALID),
  invoiceDate: requiredIsoDate(
    M.INVOICE_DATE_REQUIRED,
    M.INVOICE_DATE_INVALID,
  ).refine((v) => v <= istTodayDateOnly(), M.INVOICE_DATE_FUTURE),
});

export type SubscriptionInvoiceUploadFields = z.infer<
  typeof subscriptionInvoiceUploadFieldsSchema
>;

export const subscriptionBiddersListQuerySchema = z.object({
  cohort: z.enum(["subscribed", "unsubscribed"]),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().optional(),
  sortBy: z.enum(["companyName", "bidderId"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

export type SubscriptionBiddersListQuery = z.infer<
  typeof subscriptionBiddersListQuerySchema
>;

/** Admin POST /admin/subscriptions/bidders/:bidderId/send-payment-link */
export const sendSubscriptionPaymentLinkBodySchema = z.object({
  subscriptionTypeId: z.coerce.number().int().positive(),
});

export type SendSubscriptionPaymentLinkBody = z.infer<
  typeof sendSubscriptionPaymentLinkBodySchema
>;

export const subscriptionStatsQuerySchema = z.object({
  dateField: z.enum(SUBSCRIPTION_DATE_FIELDS).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

export type SubscriptionStatsQuery = z.infer<typeof subscriptionStatsQuerySchema>;

/**
 * Shared payment fields (admin + bidder-scoped create).
 * `amount` is accepted for client compatibility; the service always persists
 * the subscription type plan amount. `toDate` is accepted for form
 * compatibility; the service derives toDate from fromDate + plan months.
 */
const subscriptionPaymentFieldsObjectSchema = z.object({
  subscriptionTypeId: requiredPositiveInt(M.SUBSCRIPTION_TYPE_REQUIRED),
  amount: requiredPositiveAmount,
  paymentMode: requiredPositiveInt(M.PAYMENT_MODE_REQUIRED),
  transactionId: requiredMaxString(
    100,
    M.TRANSACTION_ID_REQUIRED,
    M.TRANSACTION_ID_MAX,
  ),
  paymentDate: requiredIsoDate(
    M.PAYMENT_DATE_REQUIRED,
    M.PAYMENT_DATE_INVALID,
  ).refine((v) => v <= istTodayDateOnly(), M.PAYMENT_DATE_FUTURE),
  fromDate: requiredIsoDate(M.FROM_DATE_REQUIRED, M.FROM_DATE_INVALID),
  toDate: requiredIsoDate(M.TO_DATE_REQUIRED, M.TO_DATE_INVALID),
  remarks: optionalMaxString(2000, M.REMARKS_MAX),
});

function refinePeriodOnOrAfterPaymentMonth<
  T extends { fromDate: string; paymentDate: string },
>(data: T, ctx: z.RefinementCtx) {
  const fromMonth = data.fromDate.slice(0, 7);
  const paymentMonth = data.paymentDate.slice(0, 7);
  if (fromMonth < paymentMonth) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["fromDate"],
      message: M.FROM_DATE_BEFORE_PAYMENT_MONTH,
    });
  }
}

export const subscriptionPaymentFieldsSchema =
  subscriptionPaymentFieldsObjectSchema.superRefine(
    refinePeriodOnOrAfterPaymentMonth,
  );

/** Admin POST /admin/subscriptions — includes bidderId. */
export const createSubscriptionBodySchema =
  subscriptionPaymentFieldsObjectSchema
    .extend({
      bidderId: requiredPositiveInt(M.BIDDER_REQUIRED),
    })
    .superRefine(refinePeriodOnOrAfterPaymentMonth);

export type CreateSubscriptionBody = z.infer<typeof createSubscriptionBodySchema>;

/**
 * Admin PATCH /admin/subscriptions/:id — payment fields only (bidder locked).
 * Saving a recheck invoice returns it to requested.
 */
export const updateSubscriptionBodySchema =
  subscriptionPaymentFieldsObjectSchema
    .extend({
      status: z.enum(["requested"]).optional(),
    })
    .superRefine(refinePeriodOnOrAfterPaymentMonth);

export type UpdateSubscriptionBody = z.infer<typeof updateSubscriptionBodySchema>;

/** Bidder-scoped POST /bidders/:id/subscriptions — bidderId from URL. */
export const bidderSubscriptionBodySchema = subscriptionPaymentFieldsSchema;

export type BidderSubscriptionBody = z.infer<typeof bidderSubscriptionBodySchema>;
