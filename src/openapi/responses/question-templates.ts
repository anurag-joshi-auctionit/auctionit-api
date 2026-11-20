import { paginated } from "../common.js";
import { z } from "../zod.js";

// Mirrors QuestionTemplateDto / QuestionTemplatesListResult in
// services/question-templates/question-templates.service.ts.

const QuestionOption = z.object({ value: z.string() });

const QuestionFileUpload = z.object({
  allowedFileTypes: z.array(z.string()),
  maxFileSizeMb: z.number().int().nullable(),
});

const QuestionTemplateQuestion = z
  .object({
    id: z.string(),
    question: z.string(),
    answerType: z.string(),
    weight: z.number().int(),
    required: z.boolean(),
    options: z.array(QuestionOption),
    fileUpload: QuestionFileUpload,
  })
  .openapi("QuestionTemplateQuestion");

export const QuestionTemplate = z
  .object({
    id: z.number().int(),
    name: z.string(),
    description: z.string(),
    stageIds: z
      .array(z.union([z.literal(1), z.literal(2), z.literal(3)]))
      .openapi({ description: "1 = RFI, 2 = RFP, 3 = RFQ. Empty = every stage." }),
    clientIds: z.array(z.number().int()).openapi({ description: "Empty = every client." }),
    clientNames: z.array(z.string()),
    isActive: z.boolean(),
    questions: z.array(QuestionTemplateQuestion),
    createdAt: z.string(),
    createdBy: z.string(),
    updatedAt: z.string(),
    updatedBy: z.string(),
  })
  .openapi("QuestionTemplate");

export const QuestionTemplateList = paginated(QuestionTemplate).openapi("QuestionTemplateList");
