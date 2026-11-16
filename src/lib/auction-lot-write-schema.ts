import { parseTimeOfDayString } from "@auctionit/lib/time-of-day";
import { gstRateZod } from "@auctionit/lib/gst-rates";
import {
  bidIncrementVsPriceError,
  bidStepLabel,
} from "@auctionit/lib/bid-increment-vs-price";
import { bidLimitVsStartPriceError } from "@auctionit/lib/bid-limit-vs-start";
import { collectLotWriteScheduleErrors, lotEndTimeVsStartError } from "@auctionit/lib/lot-schedule";
import {
  LOADING_SCOPE_VALUES,
  parseLoadingScope,
  type LoadingScope,
} from "@auctionit/lib/loading-scope";
import { AuctionsValidationMessages } from "@auctionit/messages/auctions";
import { z } from "zod";

export { gstRateZod };

function preprocessLoadingScope(v: unknown): unknown {
  if (v === "" || v == null) return null;
  if (typeof v === "string" || typeof v === "number") {
    return parseLoadingScope(v) ?? v;
  }
  return v;
}

const loadingScopeEnumZod = z.enum(LOADING_SCOPE_VALUES, {
  errorMap: () => ({
    message: AuctionsValidationMessages.LOADING_SCOPE_INVALID,
  }),
});

/** Empty string → null. Accepts `null` or `buyer` | `seller`. */
export const loadingScopeZod = z.preprocess(
  preprocessLoadingScope,
  loadingScopeEnumZod.nullable(),
);

/**
 * Normalize to `HH:mm:ss` for Postgres `time` columns.
 * Same rules for lotStartTime and lotEndTime (24h primary; AM/PM defensive).
 */
export function normalizeLotTimeOfDay(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const fromClock = parseTimeOfDayString(trimmed);
  if (fromClock) return fromClock;

  // ISO / datetime strings: use UTC clock parts (API contract).
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    const d = new Date(parsed);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }

  return null;
}

/**
 * Required lot time-of-day. Empty / null → requiredMessage; unparseable →
 * LOT_TIME_INVALID (not Zod's "Expected string, received null").
 */
export function lotTimeOfDayZod(requiredMessage: string) {
  return z.preprocess(
    (v) => {
      if (v == null) return "";
      if (typeof v !== "string") return v;
      const trimmed = v.trim();
      if (!trimmed) return "";
      return normalizeLotTimeOfDay(trimmed) ?? trimmed;
    },
    z
      .string({
        required_error: requiredMessage,
        invalid_type_error: requiredMessage,
      })
      .superRefine((val, ctx) => {
        if (!val) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: requiredMessage,
          });
          return;
        }
        if (!/^\d{2}:\d{2}:\d{2}$/.test(val)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: AuctionsValidationMessages.LOT_TIME_INVALID,
          });
        }
      }),
  );
}

/** Full lot editor / create / patch payload. Pass auctionType for direction-aware copy. */
export function createAuctionLotWriteSchema(
  auctionType?: string | null,
  auctionDate?: string | null,
  publishedAt?: string | null,
) {
  const label = bidStepLabel(auctionType);
  return z
    .object({
      lotNumber: z.string().trim().min(1, AuctionsValidationMessages.LOT_NUMBER_REQUIRED),
      materialLiftingDays: z
        .number()
        .int(AuctionsValidationMessages.MATERIAL_LIFTING_DAYS_MUST_BE_INTEGER)
        .nonnegative(
          AuctionsValidationMessages.MATERIAL_LIFTING_DAYS_MUST_BE_NON_NEGATIVE,
        )
        .nullable()
        .optional(),
      plantLocationId: z
        .number()
        .int()
        .positive(AuctionsValidationMessages.PLANT_LOCATION_REQUIRED),
      materialLocationId: z
        .number()
        .int()
        .positive(AuctionsValidationMessages.MATERIAL_LOCATION_REQUIRED)
        .nullable()
        .optional(),
      gstPercentage: gstRateZod,
      tcsPercentage: z
        .number({
          required_error: AuctionsValidationMessages.TCS_PERCENTAGE_REQUIRED,
          invalid_type_error: AuctionsValidationMessages.TCS_PERCENTAGE_REQUIRED,
        })
        .nonnegative(
          AuctionsValidationMessages.TCS_PERCENTAGE_MUST_BE_NON_NEGATIVE,
        ),
      startBidPrice: z
        .number({
          required_error: AuctionsValidationMessages.START_BID_PRICE_REQUIRED,
          invalid_type_error: AuctionsValidationMessages.START_BID_PRICE_REQUIRED,
        })
        .positive(AuctionsValidationMessages.START_BID_PRICE_MUST_BE_POSITIVE),
      bidLimit: z
        .number({
          required_error: AuctionsValidationMessages.BID_LIMIT_REQUIRED,
          invalid_type_error: AuctionsValidationMessages.BID_LIMIT_REQUIRED,
        })
        .positive(AuctionsValidationMessages.BID_LIMIT_MUST_BE_POSITIVE),
      bidIncrement: z
        .number({
          required_error: AuctionsValidationMessages.BID_STEP_MUST_BE_POSITIVE(label),
          invalid_type_error:
            AuctionsValidationMessages.BID_STEP_MUST_BE_POSITIVE(label),
        })
        .positive(AuctionsValidationMessages.BID_STEP_MUST_BE_POSITIVE(label)),
      lotStartTime: lotTimeOfDayZod(
        AuctionsValidationMessages.LOT_START_TIME_REQUIRED,
      ),
      lotEndTime: lotTimeOfDayZod(
        AuctionsValidationMessages.LOT_END_TIME_REQUIRED,
      ),
      loadingScope: loadingScopeZod,
      displayOrder: z
        .number({
          required_error: AuctionsValidationMessages.DISPLAY_ORDER_REQUIRED,
          invalid_type_error: AuctionsValidationMessages.DISPLAY_ORDER_REQUIRED,
        })
        .positive(AuctionsValidationMessages.DISPLAY_ORDER_MUST_BE_POSITIVE),
      remark: z.string().trim().max(200),
      itemId: z
        .number()
        .int()
        .positive(AuctionsValidationMessages.ITEM_REQUIRED),
      quantity: z
        .number({
          required_error: AuctionsValidationMessages.QUANTITY_REQUIRED,
          invalid_type_error: AuctionsValidationMessages.QUANTITY_REQUIRED,
        })
        .nonnegative(AuctionsValidationMessages.QUANTITY_MUST_BE_NON_NEGATIVE),
      uomCode: z
        .string()
        .trim()
        .min(1, AuctionsValidationMessages.UOM_CODE_REQUIRED),
      benchmarkMaterialLocationId: z
        .number()
        .int()
        .positive(AuctionsValidationMessages.BENCHMARK_MATERIAL_LOCATION_REQUIRED)
        .nullable()
        .optional(),
      materialName: z
        .string()
        .trim()
        .min(1, AuctionsValidationMessages.MATERIAL_NAME_REQUIRED)
        .max(500),
      materialDescription: z
        .string()
        .trim()
        .max(1000)
        .nullable()
        .optional()
        .transform((v) => (v == null || v === "" ? null : v)),
    })
    .superRefine((row, ctx) => {
      if (auctionDate) {
        const scheduleErrors = collectLotWriteScheduleErrors(
          row.lotStartTime,
          row.lotEndTime,
          auctionDate,
          undefined,
          publishedAt,
        );
        if (scheduleErrors) {
          for (const [field, messages] of Object.entries(scheduleErrors)) {
            for (const message of messages) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [field],
                message,
              });
            }
          }
        }
      } else {
        const endVsStart = lotEndTimeVsStartError(
          row.lotEndTime,
          row.lotStartTime,
        );
        if (endVsStart) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["lotEndTime"],
            message: endVsStart,
          });
        }
      }

      const bidLimitErr = bidLimitVsStartPriceError(
        auctionType,
        row.bidLimit,
        row.startBidPrice,
      );
      if (bidLimitErr) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["bidLimit"],
          message: bidLimitErr,
        });
      }

      if (row.bidIncrement <= 0) return;
      const err = bidIncrementVsPriceError(row.bidIncrement, row.startBidPrice, {
        auctionType,
      });
      if (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["bidIncrement"],
          message: err,
        });
      }
    });
}

/** Default schema (forward / Increment wording) when auction type is unknown. */
export const auctionLotWriteSchema = createAuctionLotWriteSchema();

export type AuctionLotWriteBody = z.infer<typeof auctionLotWriteSchema> & {
  loadingScope: LoadingScope | null;
};
