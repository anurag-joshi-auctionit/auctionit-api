import type { ZodTypeAny } from "zod";
import { z } from "./zod.js";

/** `{ error }` — generic failure body used across all routers. */
export const ErrorBody = z
  .object({ error: z.string().openapi({ example: "Not found" }) })
  .openapi("ErrorBody");

/** `zodValidationErrorBody()` / `fieldValidationErrorBody()` in lib/validation-error.ts. */
export const ValidationErrorBody = z
  .object({
    error: z.string().openapi({ example: "Please fix the highlighted fields." }),
    fieldErrors: z
      .record(z.array(z.string()))
      .openapi({
        description: "Field path (dot-joined) → messages.",
        example: { pageSize: ["Number must be less than or equal to 100"] },
      }),
  })
  .openapi("ValidationErrorBody");

/** 401/403 bodies from auth/middleware.ts. `session_invalid` triggers frontend auto-logout. */
export const AuthErrorBody = z
  .object({
    error: z.string(),
    code: z
      .enum(["session_invalid", "permission_denied"])
      .optional()
      .openapi({
        description:
          "`session_invalid` = missing/expired session (401). `permission_denied` = logged in but not allowed (403). Absent for legacy admin-only gates.",
      }),
  })
  .openapi("AuthErrorBody");

/** Numeric `:id` path param — routes parse it with `parseId()` and 400/404 on junk. */
export const IdParam = z.object({
  id: z.coerce.number().int().positive().openapi({ param: { name: "id", in: "path" }, example: 1 }),
});

export const IdBody = z.object({ id: z.number().int().positive() });

export const OkBody = z.object({ ok: z.literal(true) }).openapi("OkBody");

/** `{ items, total, page, pageSize }` list envelope used by most list endpoints. */
export function paginated<T extends ZodTypeAny>(item: T, extra?: Record<string, ZodTypeAny>) {
  return z.object({
    items: z.array(item),
    total: z.number().int().openapi({ description: "Total rows matching the filters (all pages)." }),
    page: z.number().int(),
    pageSize: z.number().int(),
    ...extra,
  });
}

/** `toOptionIdsResult()` in lib/options-query.ts — `/options/ids` "Select all" responses. */
export const OptionIdsResult = z
  .object({
    ids: z.array(z.number().int()).openapi({ description: "Matching ids, capped at 2000." }),
    total: z.number().int(),
    truncated: z.boolean().openapi({ description: "True when `total` exceeded the 2000-id cap." }),
  })
  .openapi("OptionIdsResult");

export const BinaryFile = z.string().openapi({ type: "string", format: "binary" });

/** ISO-8601 timestamp as serialised by `res.json` from a Date. */
export const IsoDateTime = z.string().openapi({ format: "date-time", example: "2026-10-21T09:30:00.000Z" });
