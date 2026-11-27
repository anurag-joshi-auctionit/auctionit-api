import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { getSignedDownloadUrl, putObject } from "../lib/r2.js";

export class FileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileValidationError";
  }
}

/** Image extensions that may be run through compression. */
const COMPRESSIBLE_IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "bmp",
  "tiff",
]);

export type CompressOptions = {
  format: "webp" | "jpeg";
  /** 1–100. Defaults to 80. */
  quality?: number;
  resize?: {
    width?: number;
    height?: number;
    /** Defaults to "cover". */
    fit?: "cover" | "contain" | "fill";
  };
};

export type FileUploadConfig = {
  /** R2 folder prefix, e.g. "bidders" or "ra-stages/123/rfi/42". */
  folder: string;
  /**
   * Returns the filename only (no folder). Receives the original filename and
   * the final extension after any compression (e.g. "webp" when compress.format
   * is "webp"). Defaults to "<uuid>.<finalExt>".
   */
  buildFileName?: (originalFilename: string, finalExt: string) => string;
  /** Allowed extensions (lowercase, no dot). Empty / omitted = any extension accepted. */
  allowedExtensions?: string[];
  /** Minimum size in bytes. Throws FileValidationError for empty or too-small files. */
  minSizeBytes?: number;
  /** Hard size cap in bytes applied to the original buffer. Throws FileValidationError if exceeded. */
  maxSizeBytes?: number;
  /** Convert image files before storing. Non-image files are stored as-is. */
  compress?: CompressOptions;
  /**
   * Optional custom validator called after size/extension checks but before upload.
   * Throw any error to abort. Used for magic-byte sniffing, business rules, etc.
   */
  validate?: (buffer: Buffer, originalFilename: string) => void | Promise<void>;
};

export type FileUploadInput = {
  buffer: Buffer;
  originalFilename: string;
  mimeType?: string;
};

export type FileUploadResult = {
  s3Key: string;
  /** Filename only (last segment of s3Key). */
  fileName: string;
  /** 1-hour presigned GET URL. */
  signedUrl: string;
};

function extractExt(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx < 0 || idx === filename.length - 1) return "";
  return filename.slice(idx + 1).toLowerCase();
}

export class FileUploadService {
  async upload(input: FileUploadInput, config: FileUploadConfig): Promise<FileUploadResult> {
    const { buffer, originalFilename, mimeType } = input;
    const originalExt = extractExt(originalFilename);

    // 1. Size checks (against original buffer before compression)
    if (config.minSizeBytes != null && buffer.length < config.minSizeBytes) {
      throw new FileValidationError("File is empty or too small.");
    }
    if (config.maxSizeBytes != null && buffer.length > config.maxSizeBytes) {
      throw new FileValidationError("File exceeds the maximum allowed size.");
    }

    // 2. Extension check
    if (config.allowedExtensions?.length && !config.allowedExtensions.includes(originalExt)) {
      throw new FileValidationError(`File type ".${originalExt}" is not allowed.`);
    }

    // 3. Custom validation (magic-byte sniff, business rules, etc.)
    if (config.validate) {
      await config.validate(buffer, originalFilename);
    }

    // 4. Compression (only applied to recognised image types)
    let processedBuffer = buffer;
    let finalExt = originalExt;
    let finalMimeType = mimeType;

    if (config.compress && COMPRESSIBLE_IMAGE_EXTENSIONS.has(originalExt)) {
      const { format, quality = 80, resize } = config.compress;
      let pipeline = sharp(buffer);
      if (resize) {
        pipeline = pipeline.resize(resize.width, resize.height, {
          fit: resize.fit ?? "cover",
        });
      }
      if (format === "jpeg") {
        processedBuffer = await pipeline.jpeg({ quality }).toBuffer();
        finalExt = "jpeg";
        finalMimeType = "image/jpeg";
      } else {
        processedBuffer = await pipeline.webp({ quality }).toBuffer();
        finalExt = "webp";
        finalMimeType = "image/webp";
      }
    }

    // 5. Build key

    const fileName = config.buildFileName
      ? config.buildFileName(originalFilename, finalExt)
      : `${randomUUID()}${finalExt ? `.${finalExt}` : ""}`;
    const s3Key = `${config.folder}/${fileName}`;

    // 6. Upload to R2
    await putObject({ key: s3Key, body: processedBuffer, contentType: finalMimeType });

    // 7. Generate presigned download URL
    const signedUrl = await getSignedDownloadUrl(s3Key);

    return { s3Key, fileName, signedUrl };
  }

  uploadMany(
    inputs: FileUploadInput[],
    config: FileUploadConfig,
  ): Promise<FileUploadResult[]> {
    return Promise.all(inputs.map((input) => this.upload(input, config)));
  }
}

export const fileUploadService = new FileUploadService();
