import { z } from "zod";
import { AuctionsValidationMessages } from "@auctionit/messages/auctions";
import { bidStepLabel } from "@auctionit/lib/bid-increment-vs-price";
import { parseTimeOfDayString } from "@auctionit/lib/time-of-day";
import {
  AUCTION_SCHEDULE_BUCKETS,
  AUCTION_STATUSES,
} from "../../db/schema/auctions.js";
import { lotTimeOfDayZod } from "../auction-lot-write-schema.js";

export const auctionStatusSchema = z.enum(AUCTION_STATUSES);

export const auctionListFilterSchema = z.enum([
  "all_active",
  ...AUCTION_STATUSES,
  ...AUCTION_SCHEDULE_BUCKETS,
]);

const noBidExtensionIntervalZod = z
  .number()
  .int(AuctionsValidationMessages.AUTO_INCREMENT_TIME_RANGE)
  .min(0, AuctionsValidationMessages.AUTO_INCREMENT_TIME_RANGE)
  .max(7200, AuctionsValidationMessages.AUTO_INCREMENT_TIME_RANGE);

const noBidExtensionCountMaxZod = z
  .number()
  .int(AuctionsValidationMessages.AUTO_INCREMENT_COUNT_RANGE)
  .min(0, AuctionsValidationMessages.AUTO_INCREMENT_COUNT_RANGE)
  .max(120, AuctionsValidationMessages.AUTO_INCREMENT_COUNT_RANGE);

/** Both 0 (off) or both > 0 (on). Null is treated as 0. */
function refineNoBidExtensionPair(
  data: {
    noBidExtensionCountMax?: number | null;
    noBidExtensionInterval?: number | null;
  },
  ctx: z.RefinementCtx,
) {
  if (
    data.noBidExtensionCountMax === undefined &&
    data.noBidExtensionInterval === undefined
  ) {
    return;
  }
  if (
    data.noBidExtensionCountMax === undefined ||
    data.noBidExtensionInterval === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["noBidExtensionCountMax"],
      message: AuctionsValidationMessages.AUTO_INCREMENT_PAIR,
    });
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["noBidExtensionInterval"],
      message: AuctionsValidationMessages.AUTO_INCREMENT_PAIR,
    });
    return;
  }

  const count = data.noBidExtensionCountMax ?? 0;
  const interval = data.noBidExtensionInterval ?? 0;
  if ((count === 0) !== (interval === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["noBidExtensionCountMax"],
      message: AuctionsValidationMessages.AUTO_INCREMENT_PAIR,
    });
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["noBidExtensionInterval"],
      message: AuctionsValidationMessages.AUTO_INCREMENT_PAIR,
    });
  }
}

/** Optional HH:mm[:ss] time-of-day, normalized to HH:mm:ss; "" → null. */
const sealedTimeZod = z.preprocess(
  (v) => {
    if (typeof v !== "string") return v;
    const t = v.trim();
    if (!t) return null;
    return parseTimeOfDayString(t) ?? t;
  },
  z
    .string()
    .regex(/^\d{2}:\d{2}:\d{2}$/, AuctionsValidationMessages.LOT_TIME_INVALID)
    .nullable(),
);

const sealedBidFields = {
  sealedBidDate: z.string().nullable().optional(),
  sealedBidStartTime: sealedTimeZod.optional(),
  sealedBidEndTime: sealedTimeZod.optional(),
};

/**
 * Sealed-bid on → date, start and end are all required and start < end. Runs
 * when `isSealedBid` is in the body; the service re-checks the merged row on
 * patch.
 */
function refineSealedBidWindow(
  data: {
    isSealedBid?: boolean;
    sealedBidDate?: string | null;
    sealedBidStartTime?: string | null;
    sealedBidEndTime?: string | null;
    auctionDate?: string;
  },
  ctx: z.RefinementCtx,
) {
  if (data.isSealedBid !== true) return;
  if (!data.sealedBidDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sealedBidDate"],
      message: AuctionsValidationMessages.SEALED_BID_DATE_REQUIRED,
    });
  }
  if (!data.sealedBidStartTime) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sealedBidStartTime"],
      message: AuctionsValidationMessages.SEALED_BID_START_TIME_REQUIRED,
    });
  }
  if (!data.sealedBidEndTime) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sealedBidEndTime"],
      message: AuctionsValidationMessages.SEALED_BID_END_TIME_REQUIRED,
    });
  }
  if (
    data.sealedBidStartTime &&
    data.sealedBidEndTime &&
    data.sealedBidEndTime <= data.sealedBidStartTime
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sealedBidEndTime"],
      message: AuctionsValidationMessages.SEALED_BID_END_BEFORE_START,
    });
  }
  if (
    data.sealedBidDate &&
    data.auctionDate &&
    data.sealedBidDate.slice(0, 10) > data.auctionDate.slice(0, 10)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sealedBidDate"],
      message: AuctionsValidationMessages.SEALED_BID_DATE_AFTER_AUCTION_DATE,
    });
  }
}

export const createAuctionSchema = z
  .object({
    clientId: z.number().int().positive(),
    auctionNumber: z.string().nullable(),
    auctionType: z.string(),
    emdAmount: z.number().nullable(),
    auctionDate: z.string(),
    publishedAt: z.string(),
    noBidExtensionInterval: noBidExtensionIntervalZod.nullable(),
    noBidExtensionCountMax: noBidExtensionCountMaxZod.nullable(),
    isNoBidExtension: z.boolean().nullable(),
    isStartBidPricePlusIncrement: z.boolean().nullable(),
    isSealedBid: z.boolean(),
    ...sealedBidFields,
    ipAddressRestrictionEnabled: z.boolean().nullable(),
    isRankBased: z.boolean(),
  })
  .superRefine((data, ctx) => {
    refineNoBidExtensionPair(data, ctx);
    refineSealedBidWindow(data, ctx);
  });

export type CreateAuctionBody = z.infer<typeof createAuctionSchema>;

export const patchAuctionSchema = z
  .object({
    /** Accepted only so we can reject it — client is immutable after create. */
    clientId: z.number().int().positive().optional(),
    auctionNumber: z.string().max(50).nullable().optional(),
    auctionType: z.enum(["forward", "reverse", "yankee"]).optional(),
    consolidatedEmdAmount: z.number().nonnegative().nullable().optional(),
    auctionDate: z.string().optional(),
    publishedAt: z.string().optional(),
    noBidExtensionInterval: noBidExtensionIntervalZod.nullable().optional(),
    noBidExtensionCountMax: noBidExtensionCountMaxZod.nullable().optional(),
    isNoBidExtension: z.boolean().nullable().optional(),
    isStartBidPricePlusIncrement: z.boolean().nullable().optional(),
    isSealedBid: z.boolean().optional(),
    ...sealedBidFields,
    ipAddressRestrictionEnabled: z.boolean().nullable().optional(),
    isRankBased: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.clientId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clientId"],
        message: AuctionsValidationMessages.CLIENT_CANNOT_CHANGE,
      });
    }
    refineNoBidExtensionPair(data, ctx);
    refineSealedBidWindow(data, ctx);
  });

export type PatchAuctionBody = z.infer<typeof patchAuctionSchema>;

const lotCorrectionTimeZod = lotTimeOfDayZod(
  AuctionsValidationMessages.LOT_END_TIME_REQUIRED,
);

export const lotCorrectionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("remove_all_bids") }),
  z.object({
    type: z.literal("remove_winning_bid"),
    bidderId: z
      .number({
        required_error:
          AuctionsValidationMessages.REMOVE_WINNING_BID_BIDDER_REQUIRED,
        invalid_type_error:
          AuctionsValidationMessages.REMOVE_WINNING_BID_BIDDER_REQUIRED,
      })
      .int()
      .positive(AuctionsValidationMessages.REMOVE_WINNING_BID_BIDDER_REQUIRED),
  }),
  z.object({
    type: z.literal("reopen_lot"),
    lotEndTime: lotCorrectionTimeZod,
  }),
  z.object({
    type: z.literal("update_lot"),
    winnerBidderId: z
      .number({
        invalid_type_error: AuctionsValidationMessages.WINNER_BIDDER_REQUIRED,
      })
      .int()
      .positive(AuctionsValidationMessages.WINNER_BIDDER_REQUIRED)
      .nullable()
      .optional(),
    // Allow 0 through so the service can return bid-floor messages
    // (manualBidAmountError) instead of a misleading "required".
    winningAmount: z
      .number({
        invalid_type_error: AuctionsValidationMessages.WINNING_AMOUNT_REQUIRED,
      })
      .nullable()
      .optional(),
    // Positivity is checked in the service so it is reported alongside
    // winning-price errors in a single response.
    quantity: z
      .number({
        invalid_type_error: AuctionsValidationMessages.CORRECTION_QUANTITY_REQUIRED,
      })
      .nullable()
      .optional(),
    // Requiredness/existence of these is checked in the service, same as
    // winningAmount/quantity above.
    uomCode: z
      .string({
        invalid_type_error: AuctionsValidationMessages.UOM_CODE_REQUIRED,
      })
      .nullable()
      .optional(),
    plantLocationId: z
      .number({
        invalid_type_error: AuctionsValidationMessages.PLANT_LOCATION_REQUIRED,
      })
      .nullable()
      .optional(),
    materialLocationId: z
      .number({
        invalid_type_error: AuctionsValidationMessages.MATERIAL_LOCATION_REQUIRED,
      })
      .nullable()
      .optional(),
    // Required only when the correction actually changes the winner; the
    // service enforces that once it knows the lot's current winner.
    isEmdWithClient: z.boolean().optional(),
  }),
]);

export type LotCorrectionBody = z.infer<typeof lotCorrectionSchema>;

const reopenLotItemSchema = z.object({
  lotId: z.number().int().positive(),
  lotEndTime: lotCorrectionTimeZod,
  lotNumber: z
    .string()
    .trim()
    .min(1, AuctionsValidationMessages.LOT_NUMBER_REQUIRED),
  bidIncrement: z
    .number()
    .positive(
      AuctionsValidationMessages.BID_STEP_MUST_BE_POSITIVE(
        bidStepLabel(undefined),
      ),
    ),
  quantity: z
    .number()
    .nonnegative(AuctionsValidationMessages.QUANTITY_MUST_BE_NON_NEGATIVE),
  uomCode: z.string().trim().min(1, AuctionsValidationMessages.UOM_REQUIRED),
  startBidPrice: z
    .number()
    .positive(AuctionsValidationMessages.START_BID_PRICE_MUST_BE_POSITIVE)
    .nullable()
    .optional(),
});

/** Execution-phase correction: force lot staggering on/off for this one live auction. */
export const staggerCorrectionSchema = z.object({
  isStaggered: z.boolean(),
});

export type StaggerCorrectionBody = z.infer<typeof staggerCorrectionSchema>;

// Reopened lots run on their own end time — outside lot staggering and with no
// no-bid / last-bid extensions — so the body carries no stagger or no-bid settings.
export const reopenLotsCorrectionSchema = z.object({
  lots: z
    .array(reopenLotItemSchema)
    .min(1, AuctionsValidationMessages.REOPEN_LOTS_REQUIRED),
});

export type ReopenLotsCorrectionBody = z.infer<
  typeof reopenLotsCorrectionSchema
>;

export const auctionDocumentsListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().optional(),
  sortBy: z
    .enum(["documentTypeName", "fileName", "createDatetime", "uploadedByName"])
    .optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

export type AuctionDocumentsListParams = z.infer<
  typeof auctionDocumentsListQuerySchema
>;

export const CATALOGUE_NOTIFICATION_TYPES = ["new", "revised"] as const;

export const sendCatalogueNotificationSchema = z
  .object({
    catalogueType: z.enum(CATALOGUE_NOTIFICATION_TYPES, {
      required_error: AuctionsValidationMessages.CATALOGUE_TYPE_REQUIRED,
      invalid_type_error: AuctionsValidationMessages.CATALOGUE_TYPE_REQUIRED,
    }),
    materialsSummary: z
      .string()
      .trim()
      .min(1, AuctionsValidationMessages.MATERIALS_SUMMARY_REQUIRED)
      .max(300, AuctionsValidationMessages.MATERIALS_SUMMARY_TOO_LONG),
    additionalInfo: z.string().trim().max(4000).optional().nullable(),
    reasonForRevision: z.string().trim().max(4000).optional().nullable(),
    kamContact: z.string().trim().max(200).optional().nullable(),
    /** When omitted or empty, send to all eligible bidders. */
    bidderIds: z.array(z.number().int().positive()).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.catalogueType === "revised") {
      const reason = data.reasonForRevision?.trim() ?? "";
      if (!reason) {
        ctx.addIssue({
          code: "custom",
          path: ["reasonForRevision"],
          message: AuctionsValidationMessages.REASON_FOR_REVISION_REQUIRED,
        });
      }
    }
  });

export type SendCatalogueNotificationBody = z.infer<
  typeof sendCatalogueNotificationSchema
>;
