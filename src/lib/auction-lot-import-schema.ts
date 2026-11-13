import { gstRateZod } from "@auctionit/lib/gst-rates";
import { bidLimitVsStartPriceError } from "@auctionit/lib/bid-limit-vs-start";
import {
  bidIncrementVsPriceError,
  bidStepLabel,
} from "@auctionit/lib/bid-increment-vs-price";
import { lotEndTimeVsStartError } from "@auctionit/lib/lot-schedule";
import { AuctionsValidationMessages } from "@auctionit/messages/auctions";
import { z } from "zod";
import {
  loadingScopeZod,
  lotTimeOfDayZod,
} from "./auction-lot-write-schema.js";

export const auctionLotImportRowSchema = z
  .object({
    lotNumber: z
      .string()
      .min(1, AuctionsValidationMessages.LOT_NUMBER_REQUIRED),
    materialLiftingDays: z
      .number()
      .int(AuctionsValidationMessages.MATERIAL_LIFTING_DAYS_MUST_BE_INTEGER)
      .nonnegative(
        AuctionsValidationMessages.MATERIAL_LIFTING_DAYS_MUST_BE_NON_NEGATIVE,
      )
      .nullable()
      .optional(),
    plantLocation: z
      .string()
      .min(1, AuctionsValidationMessages.PLANT_LOCATION_REQUIRED),
    materialLocation: z
      .string()
      .trim()
      .nullable()
      .optional()
      .transform((v) => (v == null || v === "" ? null : v)),
    gstPercentage: gstRateZod,
    tcsPercentage: z
      .number()
      .nonnegative(AuctionsValidationMessages.TCS_PERCENTAGE_MUST_BE_NON_NEGATIVE),
    startBidPrice: z
      .number()
      .positive(AuctionsValidationMessages.START_BID_PRICE_MUST_BE_POSITIVE),
    bidLimit: z
      .number()
      .positive(AuctionsValidationMessages.BID_LIMIT_MUST_BE_POSITIVE),
    bidIncrement: z
      .number()
      .positive(
        AuctionsValidationMessages.BID_STEP_MUST_BE_POSITIVE(
          bidStepLabel(undefined),
        ),
      ),
    lotStartTime: lotTimeOfDayZod(
      AuctionsValidationMessages.LOT_START_TIME_REQUIRED,
    ),
    lotEndTime: lotTimeOfDayZod(
      AuctionsValidationMessages.LOT_END_TIME_REQUIRED,
    ),
    loadingScope: loadingScopeZod,
    displayOrder: z
      .number()
      .positive(AuctionsValidationMessages.DISPLAY_ORDER_MUST_BE_POSITIVE),
    remark: z.string().trim().max(200),
    itemId: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .transform((v) => (v == null ? null : v)),
    quantity: z
      .number()
      .nonnegative(AuctionsValidationMessages.QUANTITY_MUST_BE_NON_NEGATIVE),
    uom: z.string().min(1, AuctionsValidationMessages.UOM_CODE_REQUIRED),
    benchmarkMaterial: z
      .string()
      .trim()
      .nullable()
      .optional()
      .transform((v) => (v == null || v === "" ? null : v)),
    materialName: z
      .string()
      .min(1, AuctionsValidationMessages.MATERIAL_NAME_REQUIRED)
      .max(500),
    materialDescription: z
      .string()
      .max(1000)
      .nullable()
      .optional()
      .transform((v) => (v == null || v === "" ? null : v)),
  })
  .superRefine((row, ctx) => {
    const endVsStart = lotEndTimeVsStartError(
      row.lotEndTime,
      row.lotStartTime,
    );
    if (endVsStart) {
      ctx.addIssue({
        code: "custom",
        path: ["lotEndTime"],
        message: endVsStart,
      });
    }
  });

export type AuctionLotImportRowInput = z.infer<typeof auctionLotImportRowSchema>;

/** Direction-aware bid_limit vs SBP check for import / lot write. */
export function refineBidLimitVsStartPrice(
  row: Pick<AuctionLotImportRowInput, "bidLimit" | "startBidPrice">,
  auctionType: string | null | undefined,
): string | null {
  return bidLimitVsStartPriceError(
    auctionType,
    row.bidLimit,
    row.startBidPrice,
  );
}

/** Bid step vs standing price for import rows (direction-aware copy). */
export function refineBidIncrementVsPrice(
  row: Pick<AuctionLotImportRowInput, "bidIncrement" | "startBidPrice">,
  auctionType?: string | null,
): string | null {
  return bidIncrementVsPriceError(row.bidIncrement, row.startBidPrice, {
    auctionType,
  });
}
