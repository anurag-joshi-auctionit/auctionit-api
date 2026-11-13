import type { NextFunction, Request, RequestHandler, Response } from "express";
import multer from "multer";
import { fieldValidationErrorBody } from "../validation-error.js";

export function createMemoryUpload(options: { maxBytes: number }) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: options.maxBytes },
  });
}

/**
 * Wraps `upload.single(field)` so Multer `LIMIT_FILE_SIZE` returns 400 with a
 * domain message instead of falling through to the generic 500 handler.
 */
export function singleMemoryUpload(
  upload: multer.Multer,
  fieldName: string,
  tooLargeMessage: string,
): RequestHandler {
  const middleware = upload.single(fieldName);
  return (req: Request, res: Response, next: NextFunction) => {
    middleware(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res
          .status(400)
          .json(
            fieldValidationErrorBody(
              { [fieldName]: [tooLargeMessage] },
              tooLargeMessage,
            ),
          );
        return;
      }
      next(err);
    });
  };
}
