import {
  EMAIL_REGEX,
  INDIAN_MOBILE_REGEX,
  normalizeEmailInput,
  normalizeIndianMobileInput,
} from "@auctionit/lib/validation";
import { z } from "zod";

function emptyToNull<T extends string | null | undefined>(
  v: T,
): string | null | undefined {
  return v === "" ? null : v;
}

/** Normalize then regex-check; empty/nullish → null. */
export function nullableNormalized(
  normalize: (value: string) => string,
  regex: RegExp,
  invalidMessage: string,
) {
  return z
    .union([
      z
        .string()
        .trim()
        .transform(normalize)
        .refine((v) => regex.test(v), { message: invalidMessage }),
      z.literal(""),
    ])
    .nullish()
    .transform(emptyToNull);
}

export function requiredString(message: string) {
  return z
    .string({
      required_error: message,
      invalid_type_error: message,
    })
    .trim()
    .min(1, message);
}

export function requiredNormalized(
  normalize: (value: string) => string,
  requiredMessage: string,
  regex: RegExp,
  invalidMessage: string,
) {
  return requiredString(requiredMessage)
    .transform(normalize)
    .refine((v) => regex.test(v), { message: invalidMessage });
}

export function requiredIndianPhoneSchema(
  requiredMessage: string,
  invalidMessage: string,
) {
  return requiredNormalized(
    normalizeIndianMobileInput,
    requiredMessage,
    INDIAN_MOBILE_REGEX,
    invalidMessage,
  );
}

export function nullableIndianPhoneSchema(invalidMessage: string) {
  return nullableNormalized(
    normalizeIndianMobileInput,
    INDIAN_MOBILE_REGEX,
    invalidMessage,
  );
}

export function requiredEmailSchema(
  requiredMessage: string,
  invalidMessage: string,
  max = 100,
) {
  return requiredString(requiredMessage)
    .email(invalidMessage)
    .max(max)
    .transform(normalizeEmailInput);
}

/** Optional email: empty/nullish → null; otherwise trim + email check + lowercase. */
export function nullableEmailSchema(invalidMessage: string, max = 100) {
  return z
    .union([
      z
        .string()
        .trim()
        .email(invalidMessage)
        .max(max)
        .transform(normalizeEmailInput),
      z.literal(""),
    ])
    .nullish()
    .transform(emptyToNull);
}

export {
  EMAIL_REGEX,
  INDIAN_MOBILE_REGEX,
  normalizeEmailInput,
  normalizeIndianMobileInput,
};
