import {
  LIFTING_CLIENTS_REMARKS_MAX_LENGTH,
  LiftingClientsValidationMessages,
} from "@auctionit/messages/lifting-clients";
import { z } from "zod";
import { parseAuctionIdsFromComma } from "../lifting-lot-id.js";

const V = LiftingClientsValidationMessages;

const dispositionStatusSchema = z.coerce
  .number({
    required_error: V.DISPOSITION_INVALID,
    invalid_type_error: V.DISPOSITION_INVALID,
  })
  .int(V.DISPOSITION_INVALID)
  .positive(V.DISPOSITION_INVALID);

/** Local business calendar day (Asia/Kolkata) as YYYY-MM-DD. */
function istTodayDateOnly(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function parseCommaInts(raw: string | undefined): number[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function parseScopeAuctionIds(
  auctionIdsRaw: string | undefined,
  auctionKeysRaw?: string | undefined,
): number[] {
  const fromAuctionIds = parseAuctionIdsFromComma(auctionIdsRaw);
  if (fromAuctionIds.length > 0) return fromAuctionIds;
  return parseAuctionIdsFromComma(auctionKeysRaw);
}

const liftedDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, V.LIFTED_DATE_MUST_BE_ISO)
  .refine((v) => v <= istTodayDateOnly(), V.LIFTED_DATE_FUTURE);

export const liftingClientLogBodySchema = z.object({
  liftedQty: z
    .number({
      required_error: V.LIFTED_QTY_REQUIRED,
      invalid_type_error: V.LIFTED_QTY_NOT_NUMBER,
    })
    .min(0, V.LIFTED_QTY_CANNOT_BE_NEGATIVE),
  liftedDate: liftedDateSchema,
  dispositionStatus: dispositionStatusSchema,
  remarks: z
    .string()
    .max(
      LIFTING_CLIENTS_REMARKS_MAX_LENGTH,
      V.REMARKS_MAX(LIFTING_CLIENTS_REMARKS_MAX_LENGTH),
    ),
});

export const liftingClientLogUpdateBodySchema = liftingClientLogBodySchema;

export type LiftingClientLogBody = z.infer<typeof liftingClientLogBodySchema>;
export type LiftingClientLogUpdateBody = z.infer<
  typeof liftingClientLogUpdateBodySchema
>;

export const liftingClientsListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(10),
    clientIds: z
      .string()
      .optional()
      .transform((raw) => parseCommaInts(raw)),
    auctionIds: z.string().optional(),
    auctionKeys: z.string().optional(),
    sortBy: z.string().trim().optional(),
    sortOrder: z.enum(["asc", "desc"]).optional(),
    dispositionStatus: dispositionStatusSchema.optional(),
    search: z.string().trim().optional(),
    allRecentAuctions: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => v === "true"),
  })
  .transform((data) => ({
    ...data,
    auctionIds: parseScopeAuctionIds(data.auctionIds, data.auctionKeys),
  }));

export const liftingClientsLogsListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().optional(),
  sortBy: z.enum(["liftedDate", "loggedAt", "liftedQty"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
  dispositionStatus: dispositionStatusSchema.optional(),
});

export const liftingClientsImportScopeQuerySchema = z
  .object({
    clientIds: z
      .string()
      .optional()
      .transform((raw) => parseCommaInts(raw))
      .refine((ids) => ids.length > 0, {
        message: V.CLIENT_IDS_REQUIRED,
      }),
    auctionIds: z.string().optional(),
    auctionKeys: z.string().optional(),
    dispositionStatus: dispositionStatusSchema.optional(),
  })
  .transform((data) => ({
    clientIds: data.clientIds,
    auctionIds: parseScopeAuctionIds(data.auctionIds, data.auctionKeys),
    dispositionStatus: data.dispositionStatus,
  }))
  .refine((data) => data.auctionIds.length > 0, {
    message: V.AUCTION_IDS_REQUIRED,
    path: ["auctionIds"],
  });

export const liftingClientsImportScopeBodySchema = z
  .object({
    clientIds: z
      .string()
      .transform((raw) => parseCommaInts(raw))
      .refine((ids) => ids.length > 0, {
        message: V.CLIENT_IDS_REQUIRED,
      }),
    auctionIds: z.string().optional(),
    auctionKeys: z.string().optional(),
  })
  .transform((data) => ({
    clientIds: data.clientIds,
    auctionIds: parseScopeAuctionIds(data.auctionIds, data.auctionKeys),
  }))
  .refine((data) => data.auctionIds.length > 0, {
    message: V.AUCTION_IDS_REQUIRED,
    path: ["auctionIds"],
  });

export { parseCommaInts, parseScopeAuctionIds };
