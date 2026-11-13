import { paginated } from "../common.js";
import { z } from "../zod.js";

// Mirrors FileListItem / FilesListResult in services/files.service.ts.

export const FileItem = z
  .object({
    id: z.number().int(),
    filename: z.string(),
    s3Key: z.string().openapi({ description: "Object key in storage." }),
    url: z
      .string()
      .optional()
      .openapi({ description: "Signed download URL. Set on upload; omitted in list rows." }),
    createdAt: z.string(),
  })
  .openapi("FileItem");

export const FileList = paginated(FileItem).openapi("FileList");

export const FileAllowedExtensions = z
  .object({
    extensions: z.array(z.string()).openapi({
      description: "Accepted extensions, lowercase without the dot.",
      example: ["pdf", "docx", "xlsx", "png", "zip"],
    }),
  })
  .openapi("FileAllowedExtensions");

export const FileSignedUrl = z
  .object({ url: z.string().openapi({ description: "Short-lived signed download URL." }) })
  .openapi("FileSignedUrl");

export const FileUploadResult = z.object({ file: FileItem }).openapi("FileUploadResult");
