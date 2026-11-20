export const QuestionTemplatesValidationMessages = {
  NAME_REQUIRED: "Name is required.",
  AT_LEAST_ONE_QUESTION_REQUIRED: "Add at least one question.",
  QUESTION_TEXT_REQUIRED: "Question text is required.",
  OPTIONS_REQUIRED: "Add at least one option.",
} as const;

export const QuestionTemplatesErrorMessages = {
  TEMPLATE_NOT_FOUND: "Question template not found.",
} as const;
