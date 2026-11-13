import { z } from "zod";
import { istDateOnly } from "@auctionit/lib/date";
import {
  EMD_FORFEITURE_VIEWS,
  EMD_REFUND_VIEWS,
  EMD_TRANSFER_VIEWS,
  EmdErrorMessages,
  EmdValidationMessages,
} from "@auctionit/messages/emd";
import { EMD_SETTLEMENT_JOB_STATUSES } from "../../db/schema/index.js";
import { EMD_LIST_DEFAULT_PAGE_SIZE } from "./constants.js";

const id = (message: string) => z.coerce.number({ invalid_type_error: message, required_error: message }).int(message).positive(message);

const amount = z.coerce
  .number({
    invalid_type_error: EmdValidationMessages.AMOUNT_REQUIRED,
    required_error: EmdValidationMessages.AMOUNT_REQUIRED,
  })
  .positive(EmdValidationMessages.AMOUNT_REQUIRED)
  .multipleOf(0.01, EmdValidationMessages.AMOUNT_REQUIRED);

const optionalRemarks = z
  .string()
  .trim()
  .max(500, EmdValidationMessages.REMARKS_MAX)
  .nullish()
  .transform((v) => v || null);

const requiredRemarks = z
  .string({ required_error: EmdValidationMessages.REMARKS_REQUIRED, invalid_type_error: EmdValidationMessages.REMARKS_REQUIRED })
  .trim()
  .min(1, EmdValidationMessages.REMARKS_REQUIRED)
  .max(500, EmdValidationMessages.REMARKS_MAX);

/** Same shape as `requiredRemarks`, for fields the UI labels "Reason". */
const requiredReason = z
  .string({ required_error: EmdValidationMessages.REASON_REQUIRED, invalid_type_error: EmdValidationMessages.REASON_REQUIRED })
  .trim()
  .min(1, EmdValidationMessages.REASON_REQUIRED)
  .max(500, EmdValidationMessages.REASON_MAX);

/** Comma-separated (or repeated) query values narrowed to `values`. */
function csvEnum<T extends string>(values: readonly T[]) {
  return z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((raw) => {
      if (raw == null) return undefined;
      const parts = (Array.isArray(raw) ? raw : raw.split(","))
        .map((s) => s.trim())
        .filter(Boolean);
      const allowed = parts.filter((p): p is T => (values as readonly string[]).includes(p));
      return allowed.length ? allowed : undefined;
    });
}

/** Comma-separated (or repeated) positive ids. */
function csvIds(message: string) {
  return z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((raw, ctx) => {
      if (raw == null) return undefined;
      const parts = (Array.isArray(raw) ? raw : raw.split(","))
        .map((s) => s.trim())
        .filter(Boolean);
      const ids = parts.map(Number);
      if (ids.some((n) => !Number.isInteger(n) || n <= 0)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message });
        return z.NEVER;
      }
      return ids.length ? [...new Set(ids)] : undefined;
    });
}

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, EmdValidationMessages.DATE_INVALID)
  .optional();

const optionalId = (message: string) => id(message).optional();

/** Date range on the list's main date column (`from`/`to` are inclusive yyyy-MM-dd). */
const dateRange = { from: isoDate, to: isoDate };

export const emdBidderIdParamSchema = id(EmdValidationMessages.BIDDER_ID_INVALID);
export const emdAuctionIdParamSchema = id(EmdValidationMessages.AUCTION_ID_INVALID);
export const emdRefundIdParamSchema = id(EmdValidationMessages.REQUEST_ID_INVALID);
export const emdTransactionIdParamSchema = id(EmdValidationMessages.TRANSACTION_ID_INVALID);
export const emdSettlementJobIdParamSchema = id(EmdValidationMessages.SETTLEMENT_JOB_ID_INVALID);

export const emdPageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(EMD_LIST_DEFAULT_PAGE_SIZE),
});

export const emdPassbookQuerySchema = emdPageQuerySchema.extend({
  bidderId: id(EmdValidationMessages.BIDDER_ID_INVALID),
});

export const emdPassbookExportSchema = z.object({
  bidderId: id(EmdValidationMessages.BIDDER_ID_INVALID),
});

/** Filters of the EMD report: they drive the cards, the list and the export. */
export const emdBidderReportFilterSchema = z.object({
  q: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => v || undefined),
});

export const emdBidderReportQuerySchema = emdPageQuerySchema.merge(emdBidderReportFilterSchema);

/**
 * Release history is a dated list of release requests, unlike `/release/bidders`
 * (a live balance snapshot with nothing to date-filter), so only this one adds
 * the date range, on the request date.
 */
export const emdReleaseHistoryQuerySchema = emdBidderReportQuerySchema.extend({
  ...dateRange,
});

export const emdCreditSchema = z.object({
  bidderId: id(EmdValidationMessages.BIDDER_REQUIRED),
  amount,
  paymentTypeId: id(EmdValidationMessages.PAYMENT_MODE_REQUIRED),
  valueDate: z
    .string({ required_error: EmdValidationMessages.TRANSACTION_DATE_REQUIRED, invalid_type_error: EmdValidationMessages.TRANSACTION_DATE_REQUIRED })
    .trim()
    .min(1, EmdValidationMessages.TRANSACTION_DATE_REQUIRED)
    .refine((v) => {
      const d = new Date(v);
      return Number.isNaN(d.getTime()) || istDateOnly(d) <= istDateOnly();
    }, EmdValidationMessages.TRANSACTION_DATE_IN_FUTURE),
  txnRefNo: z
    .string({ required_error: EmdValidationMessages.TXN_REF_NO_REQUIRED, invalid_type_error: EmdValidationMessages.TXN_REF_NO_REQUIRED })
    .trim()
    .min(1, EmdValidationMessages.TXN_REF_NO_REQUIRED)
    .max(100, EmdValidationMessages.TXN_REF_NO_MAX),
  remarks: optionalRemarks,
});

/** Filters of the deposits page: they drive both the cards and the list. */
export const emdDepositsSummaryQuerySchema = z.object({
  ...dateRange,
  bidderIds: csvIds(EmdValidationMessages.BIDDER_ID_INVALID),
});

export const emdDepositsQuerySchema = emdPageQuerySchema.merge(emdDepositsSummaryQuerySchema);

export const emdDepositUpdateSchema = emdCreditSchema;

/** EMD Release dialog: won lots to release, each with its own remark. */
/**
 * Each row is checked on its own in the service (required, 500-char cap, lot
 * state), so a row's remark is unbounded here beyond a generous abuse guard —
 * a tight schema limit would 400 the whole request instead of reporting that
 * one row's result.
 */
export const emdReleaseLotsSchema = z.object({
  lots: z
    .array(
      z.object({
        lotId: id(EmdValidationMessages.LOT_ID_INVALID),
        remarks: z.string().trim().max(2000, EmdValidationMessages.REMARKS_MAX),
      }),
      {
        required_error: EmdErrorMessages.RELEASE_LOTS_REQUIRED,
        invalid_type_error: EmdErrorMessages.RELEASE_LOTS_REQUIRED,
      },
    )
    .min(1, EmdErrorMessages.RELEASE_LOTS_REQUIRED)
    .max(500),
});

export const emdRefundRaiseSchema = z.object({
  amount,
  remarks: requiredRemarks,
});

/** Date range applies to every view, on the request date. */
export const emdRefundSummaryQuerySchema = z.object({
  ...dateRange,
  bidderId: optionalId(EmdValidationMessages.BIDDER_ID_INVALID),
  bidderIds: csvIds(EmdValidationMessages.BIDDER_ID_INVALID),
});

export const emdRefundListQuerySchema = emdPageQuerySchema.merge(emdRefundSummaryQuerySchema).extend({
  view: z.enum(EMD_REFUND_VIEWS).optional(),
});

/** Admin review / accounts verify; remarks are required to reject. */
export const emdRefundDecisionSchema = z.object({
  approve: z.boolean(),
  remarks: requiredRemarks,
});

export const emdRefundPaySchema = z.object({
  txnRefNo: z
    .string({
      required_error: EmdValidationMessages.TXN_REF_NO_REQUIRED,
      invalid_type_error: EmdValidationMessages.TXN_REF_NO_REQUIRED,
    })
    .trim()
    .min(1, EmdValidationMessages.TXN_REF_NO_REQUIRED)
    .max(100, EmdValidationMessages.TXN_REF_NO_MAX),
  paymentDate: z
    .string({
      required_error: EmdValidationMessages.PAYMENT_DATE_REQUIRED,
      invalid_type_error: EmdValidationMessages.PAYMENT_DATE_REQUIRED,
    })
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, EmdValidationMessages.PAYMENT_DATE_REQUIRED),
  remarks: requiredRemarks,
});

export const emdSettlementJobsQuerySchema = emdPageQuerySchema.extend({
  status: csvEnum(EMD_SETTLEMENT_JOB_STATUSES),
  auctionId: id(EmdValidationMessages.AUCTION_ID_INVALID).optional(),
});

export const emdSettlementResumeSchema = z.object({
  jobIds: z.array(z.coerce.number().int().positive()).max(5000).nullish(),
});

// ---- Forfeitures ----

export const emdForfeitureSummaryQuerySchema = z.object({
  ...dateRange,
  bidderId: optionalId(EmdValidationMessages.BIDDER_ID_INVALID),
  clientIds: csvIds(EmdValidationMessages.CLIENT_ID_INVALID),
  auctionIds: csvIds(EmdValidationMessages.AUCTION_ID_INVALID),
});

export const emdForfeitureListQuerySchema = emdPageQuerySchema.merge(emdForfeitureSummaryQuerySchema).extend({
  view: z.enum(EMD_FORFEITURE_VIEWS).optional(),
});

export const emdForfeitureAuctionOptionsQuerySchema = z.object({
  ...dateRange,
  clientIds: csvIds(EmdValidationMessages.CLIENT_ID_INVALID).refine((v) => v != null, {
    message: EmdValidationMessages.CLIENT_ID_INVALID,
  }),
});

export const emdForfeitureCandidateAuctionsQuerySchema = z.object({
  ...dateRange,
  clientId: id(EmdValidationMessages.CLIENT_ID_INVALID),
});

export const emdForfeitureCandidatesQuerySchema = z.object({
  auctionId: id(EmdValidationMessages.AUCTION_ID_INVALID),
});

export const emdForfeitureRequestSchema = z.object({
  auctionId: id(EmdValidationMessages.AUCTION_ID_INVALID),
  items: z
    .array(
      z.object({
        bidderId: id(EmdValidationMessages.BIDDER_REQUIRED),
        emdRangeId: id(EmdValidationMessages.RANGE_ID_INVALID)
          .nullish()
          .transform((v) => v ?? null),
        dispositionId: id(EmdValidationMessages.FORFEITURE_DISPOSITION_REQUIRED),
        requestedRemarks: requiredReason,
      }),
    )
    .min(1, EmdValidationMessages.FORFEITURE_ROWS_REQUIRED)
    .max(500),
});

const forfeitureIds = z
  .array(id(EmdValidationMessages.FORFEITURE_ID_INVALID))
  .min(1, EmdValidationMessages.FORFEITURE_ID_INVALID)
  .max(500);

export const emdForfeitureReviewSchema = z.object({
  ids: forfeitureIds,
  approve: z.boolean(),
  remarks: requiredRemarks,
});

export const emdForfeiturePayClientSchema = z.object({
  ids: forfeitureIds,
  txnRefNo: z
    .string({ required_error: EmdValidationMessages.UTR_REQUIRED, invalid_type_error: EmdValidationMessages.UTR_REQUIRED })
    .trim()
    .min(1, EmdValidationMessages.UTR_REQUIRED)
    .max(100, EmdValidationMessages.UTR_MAX),
});


// ---- Transfers ----

export const emdTransferIdParamSchema = id(EmdValidationMessages.TRANSFER_ID_INVALID);

export const emdTransferRequestSchema = z
  .object({
    fromBidderId: id(EmdValidationMessages.BIDDER_REQUIRED),
    toBidderId: id(EmdValidationMessages.BIDDER_REQUIRED),
    amount,
    requestedRemarks: requiredReason,
  })
  .refine((v) => v.fromBidderId !== v.toBidderId, {
    message: EmdValidationMessages.TRANSFER_SAME_BIDDER,
    path: ["toBidderId"],
  });

const transferIds = z
  .array(id(EmdValidationMessages.TRANSFER_ID_INVALID))
  .min(1, EmdValidationMessages.TRANSFER_ID_INVALID)
  .max(500);

export const emdTransferReviewSchema = z.object({
  ids: transferIds,
  approve: z.boolean(),
  remarks: requiredRemarks,
});

export const emdTransferSummaryQuerySchema = z.object({
  ...dateRange,
  bidderId: optionalId(EmdValidationMessages.BIDDER_ID_INVALID),
});

export const emdTransferListQuerySchema = emdPageQuerySchema
  .merge(emdTransferSummaryQuerySchema)
  .extend({ view: z.enum(EMD_TRANSFER_VIEWS).optional() });
