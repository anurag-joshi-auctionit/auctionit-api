import { AuctionsValidationMessages } from "@auctionit/messages/auctions";
import { z } from "zod";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, AuctionsValidationMessages.DATE_RANGE_INVALID);

export const closedDateRangeQuerySchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .superRefine((data, ctx) => {
    const hasFrom = data.from != null;
    const hasTo = data.to != null;
    if (hasFrom !== hasTo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: AuctionsValidationMessages.DATE_RANGE_INVALID,
        path: [hasFrom ? "to" : "from"],
      });
      return;
    }
    if (data.from && data.to && data.from > data.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: AuctionsValidationMessages.DATE_RANGE_ORDER,
        path: ["to"],
      });
    }
  });

export type ClosedAuctionDateRange = { from: string; to: string };
