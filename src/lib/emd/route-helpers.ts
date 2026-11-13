import type { NextFunction, Response } from "express";
import type { z } from "zod";
import { EmdValidationMessages } from "@auctionit/messages/emd";
import { zodValidationErrorBody } from "../validation-error.js";
import { handleEmdError } from "./errors.js";

/** Parses a body or query; on failure writes a 400 with field errors and returns null. */
export function parseEmdInput<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
  res: Response,
): z.infer<S> | null {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    res.status(400).json(zodValidationErrorBody(parsed.error, EmdValidationMessages.VALIDATION_FAILED));
    return null;
  }
  return parsed.data;
}

/** Parses a path param; on failure writes a 400 with the schema's message. */
export function parseEmdParam<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
  res: Response,
): z.infer<S> | null {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? EmdValidationMessages.VALIDATION_FAILED });
    return null;
  }
  return parsed.data;
}

export function failEmd(e: unknown, res: Response, next: NextFunction): void {
  if (!handleEmdError(e, res)) next(e);
}
