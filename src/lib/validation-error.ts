import { ClientsValidationMessages } from "@auctionit/messages/clients";
import type { z } from "zod";

export type ValidationErrorBody = {
  error: string;
  fieldErrors: Record<string, string[]>;
};

export function zodValidationErrorBody(
  error: z.ZodError,
  errorMessage: string = ClientsValidationMessages.VALIDATION_FAILED,
): ValidationErrorBody {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    if (issue.path.length === 0) continue;
    const key = issue.path.map(String).join(".");
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return {
    error: errorMessage,
    fieldErrors,
  };
}

export function fieldValidationErrorBody(
  fieldErrors: Record<string, string[]>,
  error: string = ClientsValidationMessages.VALIDATION_FAILED,
): ValidationErrorBody {
  return { error, fieldErrors };
}
