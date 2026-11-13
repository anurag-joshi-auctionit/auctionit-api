import { randomInt } from "node:crypto";
import { z } from "zod";
import { AuthValidationMessages } from "@auctionit/messages/auth";

/** Upper + lower + special, length 8–50. */
export const PASSWORD_COMPLEXITY_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*[^A-Za-z0-9]).{8,50}$/;

export const passwordComplexitySchema = z
  .string()
  .trim()
  .min(1, AuthValidationMessages.NEW_PASSWORD_REQUIRED)
  .min(8, AuthValidationMessages.PASSWORD_MIN_LENGTH)
  .max(50, AuthValidationMessages.PASSWORD_MAX_LENGTH)
  .regex(
    PASSWORD_COMPLEXITY_REGEX,
    AuthValidationMessages.PASSWORD_COMPLEXITY,
  );

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const DIGIT = "23456789";
const SPECIAL = "!@#$%&*";

function pick(charset: string): string {
  return charset[randomInt(charset.length)]!;
}

/** Generates an 12-char temp password that always satisfies complexity rules. */
export function generateTemporaryPassword(): string {
  const required = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SPECIAL)];
  const all = UPPER + LOWER + DIGIT + SPECIAL;
  while (required.length < 12) {
    required.push(pick(all));
  }
  // Fisher–Yates shuffle
  for (let i = required.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [required[i], required[j]] = [required[j]!, required[i]!];
  }
  return required.join("");
}
