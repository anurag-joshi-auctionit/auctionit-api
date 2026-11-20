import { QuestionTemplatesValidationMessages } from "@auctionit/messages/question-templates";
import { z } from "zod";
import {
  FILE_UPLOAD_TYPES,
  QUESTION_ANSWER_TYPES,
} from "../../db/schema/question-templates.js";

/** Matches the admin frontend's `QuestionTemplateStageId` (1 = RFI, 2 = RFP, 3 = RFQ). */
const stageIdSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

const questionOptionSchema = z.object({
  value: z.string().trim().min(1),
});

const fileUploadConfigSchema = z.object({
  allowedFileTypes: z.array(z.enum(FILE_UPLOAD_TYPES)).default([]),
  maxFileSizeMb: z.number().int().positive().nullable().default(null),
});

export const questionInputSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1, QuestionTemplatesValidationMessages.QUESTION_TEXT_REQUIRED),
  answerType: z.enum(QUESTION_ANSWER_TYPES),
  weight: z.number().int().min(1).default(1),
  required: z.boolean().default(true),
  options: z.array(questionOptionSchema).default([]),
  fileUpload: fileUploadConfigSchema.default({
    allowedFileTypes: [],
    maxFileSizeMb: null,
  }),
});

export const questionTemplateInputSchema = z.object({
  name: z.string().trim().min(1, QuestionTemplatesValidationMessages.NAME_REQUIRED),
  description: z.string().trim().max(1000).default(""),
  /** Empty array = applicable to every stage. */
  stageIds: z.array(stageIdSchema).default([]),
  /** Empty array = applicable to every client. */
  clientIds: z.array(z.number().int().positive()).default([]),
  isActive: z.boolean().default(true),
  questions: z
    .array(questionInputSchema)
    .min(1, QuestionTemplatesValidationMessages.AT_LEAST_ONE_QUESTION_REQUIRED),
});

export type QuestionTemplateInput = z.infer<typeof questionTemplateInputSchema>;
export type QuestionInput = z.infer<typeof questionInputSchema>;

const activeOnlyQuery = z
  .union([z.literal("true"), z.literal("false"), z.boolean()])
  .optional()
  .transform((v) => v === true || v === "true");

export const QUESTION_TEMPLATE_SORT_FIELDS = [
  "id",
  "name",
  "isActive",
  "createdAt",
  "updatedAt",
] as const;

export const questionTemplatesListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().optional(),
  activeOnly: activeOnlyQuery,
  clientId: z.coerce.number().int().positive().optional(),
  stageId: z.coerce.number().pipe(stageIdSchema).optional(),
  sortBy: z.enum(QUESTION_TEMPLATE_SORT_FIELDS).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

export type QuestionTemplatesListParams = z.infer<
  typeof questionTemplatesListQuerySchema
>;
