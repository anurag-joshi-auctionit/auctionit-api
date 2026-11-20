import {
  questionTemplateInputSchema,
  questionTemplatesListQuerySchema,
} from "../../lib/question-templates/schemas.js";
import { ErrorBody, IdParam, ValidationErrorBody } from "../common.js";
import { documentRouter } from "../define.js";
import { QuestionTemplate, QuestionTemplateList } from "../responses/question-templates.js";

// Docs for src/routes/question-templates.ts — see docs/api/README.md.
const r = documentRouter("/question-templates");

r.get("/", {
  summary: "List question templates",
  description:
    "Paginated list of RA Stages due-diligence question templates. `search` matches name/description; `clientId`/`stageId` filter by scope (a template with an empty scope array matches every client/stage).",
  query: questionTemplatesListQuerySchema,
  responses: { 200: QuestionTemplateList },
});

r.get("/:id", {
  summary: "Get a question template",
  params: IdParam,
  responses: {
    200: QuestionTemplate,
    404: { description: "Template not found.", schema: ErrorBody },
  },
});

r.post("/", {
  summary: "Create a question template",
  body: questionTemplateInputSchema,
  responses: {
    201: QuestionTemplate,
    400: { description: "Invalid input.", schema: ValidationErrorBody },
  },
});

r.patch("/:id", {
  summary: "Replace a question template",
  description: "Full replace — the entire question set is overwritten, not merged.",
  params: IdParam,
  body: questionTemplateInputSchema,
  responses: {
    200: QuestionTemplate,
    400: { description: "Invalid input.", schema: ValidationErrorBody },
    404: { description: "Template not found.", schema: ErrorBody },
  },
});
