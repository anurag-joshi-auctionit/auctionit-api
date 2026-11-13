import { LiftingBidderValidationMessages } from "@auctionit/messages/lifting-bidders";
import { z } from "zod";

const V = LiftingBidderValidationMessages;

export const liftingEngagementBodySchema = z.object({
  dispositionStatus: z.coerce
    .number({
      required_error: V.DISPOSITION_REQUIRED,
      invalid_type_error: V.DISPOSITION_INVALID,
    })
    .int(V.DISPOSITION_INVALID)
    .positive(V.DISPOSITION_INVALID),
  notes: z.string().trim().min(1, V.NOTES_REQUIRED).max(4000, V.NOTES_MAX),
  nextFollowup: z.string().optional(),
  liftedQtyBidder: z.number().optional(),
});

export type LiftingEngagementBody = z.infer<typeof liftingEngagementBodySchema>;

export const liftingBiddersListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().optional(),
  sortBy: z.string().trim().optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
  clients: z
    .string()
    .optional()
    .transform((raw) => {
      if (!raw?.trim()) return undefined;
      const names = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return names.length > 0 ? names : undefined;
    }),
  bidderName: z.string().trim().optional(),
  dispositionStatus: z.coerce.number().int().positive().optional(),
  dateField: z
    .enum([
      "auctionDate",
      "lotConfirmation",
      "liftingDue",
      "nextFollowup",
      "lastModified",
    ])
    .optional(),
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const liftingBiddersStatsQuerySchema = z.object({
  todayDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
