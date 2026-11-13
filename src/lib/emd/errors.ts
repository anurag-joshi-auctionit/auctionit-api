import type { Response } from "express";
import { EmdErrorMessages } from "@auctionit/messages/emd";
import { fieldValidationErrorBody } from "../validation-error.js";

export type EmdErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "VALIDATION";

const STATUS_BY_CODE: Record<EmdErrorCode, number> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  CONFLICT: 409,
  VALIDATION: 400,
};

/** Domain error for the EMD module; the message is user-facing copy. */
export class EmdError extends Error {
  constructor(
    readonly code: EmdErrorCode,
    message: string,
    readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "EmdError";
  }

  static notFound(message: string) {
    return new EmdError("NOT_FOUND", message);
  }

  static conflict(message: string) {
    return new EmdError("CONFLICT", message);
  }

  static validation(message: string, field?: string) {
    return new EmdError(
      "VALIDATION",
      message,
      field ? { [field]: [message] } : undefined,
    );
  }

  static insufficientBalance(field = "amount") {
    return EmdError.validation(EmdErrorMessages.INSUFFICIENT_BALANCE, field);
  }
}

/** Writes the response for an EmdError; returns false for any other error. */
export function handleEmdError(e: unknown, res: Response): boolean {
  if (!(e instanceof EmdError)) return false;
  const status = STATUS_BY_CODE[e.code];
  if (e.fieldErrors) {
    res.status(status).json(fieldValidationErrorBody(e.fieldErrors, e.message));
  } else {
    res.status(status).json({ error: e.message });
  }
  return true;
}
