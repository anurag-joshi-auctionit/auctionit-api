import { z } from "zod";
import {
  LIFTING_CLIENTS_REMARKS_MAX_LENGTH,
  LiftingClientsValidationMessages,
} from "@auctionit/messages/lifting-clients";
import {
  DEFAULT_LIFTING_CLIENT_DISPOSITION_ID,
  LIFTING_CLIENT_DISPOSITION,
  LIFTING_CLIENT_DISPOSITION_LABELS,
  type LiftingClientDispositionId,
} from "./lifting-client-status.js";
import { LIFTING_CLIENTS_IMPORT_BATCH_SIZE } from "./lifting-clients-import-constants.js";

const V = LiftingClientsValidationMessages;

/** Local business calendar day (Asia/Kolkata) as YYYY-MM-DD. */
function istTodayDateOnly(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

const labelToId = new Map<string, number>(
  Object.entries(LIFTING_CLIENT_DISPOSITION_LABELS).map(([id, label]) => [
    label.trim().toLowerCase(),
    Number(id),
  ]),
);

const validDispositionIds = new Set<number>(
  Object.values(LIFTING_CLIENT_DISPOSITION),
);

export function normalizeDispositionInput(
  raw: string | number | undefined | null,
): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") {
    return Number.isInteger(raw) && validDispositionIds.has(raw) ? raw : null;
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const asNumber = Number(trimmed);
  if (Number.isInteger(asNumber) && validDispositionIds.has(asNumber)) {
    return asNumber;
  }
  return labelToId.get(trimmed.toLowerCase()) ?? null;
}

/** Batch payload is pre-normalized by the admin import parser (ISO dates, etc.). */
export const liftingClientsImportRowSchema = z.object({
  lotId: z.string().trim().min(1, V.LOT_ID_REQUIRED),
  auctionName: z.string().trim().min(1, V.AUCTION_NAME_REQUIRED),
  lotNumber: z.string().trim().min(1, V.LOT_NUMBER_REQUIRED),
  liftedQty: z
    .number({
      required_error: V.LIFTED_QTY_REQUIRED,
      invalid_type_error: V.LIFTED_QTY_NOT_NUMBER,
    })
    .min(0, V.LIFTED_QTY_CANNOT_BE_NEGATIVE),
  liftedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, V.LIFTED_DATE_MUST_BE_ISO)
    .refine((v) => v <= istTodayDateOnly(), V.LIFTED_DATE_FUTURE),
  dispositionStatus: z.coerce
    .number({
      required_error: V.DISPOSITION_INVALID,
      invalid_type_error: V.DISPOSITION_INVALID,
    })
    .int(V.DISPOSITION_INVALID)
    .positive(V.DISPOSITION_INVALID)
    .optional(),
  remarks: z
    .string()
    .max(
      LIFTING_CLIENTS_REMARKS_MAX_LENGTH,
      V.REMARKS_MAX(LIFTING_CLIENTS_REMARKS_MAX_LENGTH),
    )
    .optional()
    .default(""),
});

export type LiftingClientsImportRowInput = z.infer<
  typeof liftingClientsImportRowSchema
>;

export const liftingClientsImportBatchSchema = z.object({
  clientIds: z
    .array(z.number().int().positive())
    .min(1, V.CLIENT_IDS_REQUIRED),
  auctionIds: z
    .array(z.number().int().positive())
    .min(1, V.AUCTION_IDS_REQUIRED),
  rows: z
    .array(
      z.object({
        rowNumber: z.number().int().min(2),
        data: liftingClientsImportRowSchema,
      }),
    )
    .min(1, V.NO_DATA_ROWS)
    .max(LIFTING_CLIENTS_IMPORT_BATCH_SIZE),
});

export type LiftingClientsImportBatchInput = z.infer<
  typeof liftingClientsImportBatchSchema
>;

export { DEFAULT_LIFTING_CLIENT_DISPOSITION_ID };
export type { LiftingClientDispositionId };
