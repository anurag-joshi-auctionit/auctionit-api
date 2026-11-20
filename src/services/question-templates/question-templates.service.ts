import { QuestionTemplatesErrorMessages } from "@auctionit/messages/question-templates";
import { formatUtcNow } from "@auctionit/lib/date";
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/index.js";
import { clients } from "../../db/schema/clients.js";
import type { AuctionRaStageKey } from "../../db/schema/question-templates.js";
import {
  questionTemplateQuestions,
  questionTemplates,
} from "../../db/schema/question-templates.js";
import { users } from "../../db/schema/users.js";
import type { QuestionTemplatesListParams } from "../../lib/question-templates/schemas.js";
import type { QuestionTemplateInput } from "../../lib/question-templates/schemas.js";

type QuestionTemplateStageId = 1 | 2 | 3;

const STAGE_KEY_TO_ID: Record<AuctionRaStageKey, QuestionTemplateStageId> = {
  rfi: 1,
  rfp: 2,
  rfq: 3,
};
const STAGE_ID_TO_KEY: Record<QuestionTemplateStageId, AuctionRaStageKey> = {
  1: "rfi",
  2: "rfp",
  3: "rfq",
};

export type QuestionTemplateQuestionDto = {
  id: string;
  question: string;
  answerType: string;
  weight: number;
  required: boolean;
  options: { value: string }[];
  fileUpload: { allowedFileTypes: string[]; maxFileSizeMb: number | null };
};

export type QuestionTemplateDto = {
  id: number;
  name: string;
  description: string;
  stageIds: QuestionTemplateStageId[];
  clientIds: number[];
  clientNames: string[];
  isActive: boolean;
  questions: QuestionTemplateQuestionDto[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
};

export type QuestionTemplatesListResult = {
  items: QuestionTemplateDto[];
  total: number;
  page: number;
  pageSize: number;
};

export class QuestionTemplateNotFoundError extends Error {
  constructor(id: number | string) {
    super(QuestionTemplatesErrorMessages.TEMPLATE_NOT_FOUND);
    this.name = "QuestionTemplateNotFoundError";
    void id;
  }
}

function questionToDto(
  row: typeof questionTemplateQuestions.$inferSelect,
): QuestionTemplateQuestionDto {
  return {
    id: String(row.id),
    question: row.questionText,
    answerType: row.answerType,
    weight: row.weight,
    required: row.required,
    options: row.options.map((value) => ({ value })),
    fileUpload: {
      allowedFileTypes: row.fileUploadAllowedTypes,
      maxFileSizeMb: row.fileUploadMaxFileSizeMb ?? null,
    },
  };
}

async function resolveNames(
  rows: (typeof questionTemplates.$inferSelect)[],
): Promise<{ clientNameById: Map<number, string>; userNameById: Map<number, string> }> {
  const clientIds = [...new Set(rows.flatMap((r) => r.clientIds))];
  const userIds = [
    ...new Set(rows.flatMap((r) => [r.createdBy, r.updatedBy].filter((v): v is number => v != null))),
  ];

  const [clientRows, userRows] = await Promise.all([
    clientIds.length
      ? db
          .select({ id: clients.id, name: clients.companyName })
          .from(clients)
          .where(inArray(clients.id, clientIds))
      : Promise.resolve([]),
    userIds.length
      ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds))
      : Promise.resolve([]),
  ]);

  return {
    clientNameById: new Map(clientRows.map((c) => [c.id, c.name])),
    userNameById: new Map(userRows.map((u) => [u.id, u.name])),
  };
}

async function toDto(
  row: typeof questionTemplates.$inferSelect,
  questionRows: (typeof questionTemplateQuestions.$inferSelect)[],
  clientNameById: Map<number, string>,
  userNameById: Map<number, string>,
): Promise<QuestionTemplateDto> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    stageIds: row.stageKeys.map((key) => STAGE_KEY_TO_ID[key]),
    clientIds: row.clientIds,
    clientNames: row.clientIds.map((id) => clientNameById.get(id) ?? `#${id}`),
    isActive: row.isActive,
    questions: questionRows
      .filter((q) => q.templateId === row.id)
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map(questionToDto),
    createdAt: row.createdAt,
    createdBy: row.createdBy != null ? userNameById.get(row.createdBy) ?? "" : "",
    updatedAt: row.updatedAt ?? row.createdAt,
    updatedBy:
      row.updatedBy != null
        ? userNameById.get(row.updatedBy) ?? ""
        : row.createdBy != null
          ? userNameById.get(row.createdBy) ?? ""
          : "",
  };
}

function buildSearchCondition(search: string | undefined): SQL | undefined {
  const term = search?.trim();
  if (!term) return undefined;
  const pattern = `%${term}%`;
  return or(ilike(questionTemplates.name, pattern), ilike(questionTemplates.description, pattern));
}

function clientFilterCondition(clientId: number): SQL {
  return sql`(${questionTemplates.clientIds} = '{}' OR ${questionTemplates.clientIds} @> ARRAY[${clientId}]::integer[])`;
}

function stageFilterCondition(stageKey: AuctionRaStageKey): SQL {
  return sql`(${questionTemplates.stageKeys} = '{}' OR ${questionTemplates.stageKeys} @> ARRAY[${stageKey}]::auction_ra_stage_key[])`;
}

const SORT_COLUMNS = {
  id: questionTemplates.id,
  name: questionTemplates.name,
  isActive: questionTemplates.isActive,
  createdAt: questionTemplates.createdAt,
  updatedAt: questionTemplates.updatedAt,
} as const;

async function fetchDtosFor(
  rows: (typeof questionTemplates.$inferSelect)[],
): Promise<QuestionTemplateDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [questionRows, { clientNameById, userNameById }] = await Promise.all([
    db
      .select()
      .from(questionTemplateQuestions)
      .where(inArray(questionTemplateQuestions.templateId, ids)),
    resolveNames(rows),
  ]);
  return Promise.all(rows.map((row) => toDto(row, questionRows, clientNameById, userNameById)));
}

export const questionTemplatesService = {
  async listPaginated(
    params: QuestionTemplatesListParams,
  ): Promise<QuestionTemplatesListResult> {
    const page = Math.max(1, params.page);
    const pageSize = Math.max(1, Math.min(100, params.pageSize));
    const offset = (page - 1) * pageSize;

    const conditions: (SQL | undefined)[] = [
      params.activeOnly ? eq(questionTemplates.isActive, true) : undefined,
      buildSearchCondition(params.search),
      params.clientId != null ? clientFilterCondition(params.clientId) : undefined,
      params.stageId != null ? stageFilterCondition(STAGE_ID_TO_KEY[params.stageId as QuestionTemplateStageId]) : undefined,
    ];
    const where = and(...conditions.filter((c): c is SQL => c != null));

    const sortColumn = params.sortBy ? SORT_COLUMNS[params.sortBy] : undefined;
    const orderBy = sortColumn
      ? [params.sortOrder === "desc" ? desc(sortColumn) : asc(sortColumn)]
      : [asc(questionTemplates.id)];

    const [countRow] = await db
      .select({ total: sql<number>`count(*)` })
      .from(questionTemplates)
      .where(where);

    const rows = await db
      .select()
      .from(questionTemplates)
      .where(where)
      .orderBy(...orderBy)
      .limit(pageSize)
      .offset(offset);

    return {
      items: await fetchDtosFor(rows),
      total: Number(countRow?.total ?? 0),
      page,
      pageSize,
    };
  },

  async getById(id: number): Promise<QuestionTemplateDto> {
    const [row] = await db.select().from(questionTemplates).where(eq(questionTemplates.id, id)).limit(1);
    if (!row) throw new QuestionTemplateNotFoundError(id);
    const [dto] = await fetchDtosFor([row]);
    return dto!;
  },

  async create(input: QuestionTemplateInput, userId: number): Promise<QuestionTemplateDto> {
    const now = formatUtcNow();
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(questionTemplates)
        .values({
          name: input.name,
          description: input.description,
          stageKeys: input.stageIds.map((id) => STAGE_ID_TO_KEY[id as QuestionTemplateStageId]),
          clientIds: input.clientIds,
          isActive: input.isActive,
          createdAt: now,
          createdBy: userId,
          updatedAt: now,
          updatedBy: userId,
        })
        .returning();
      if (!row) throw new Error("Failed to create question template");

      if (input.questions.length > 0) {
        await tx.insert(questionTemplateQuestions).values(
          input.questions.map((q, index) => ({
            templateId: row.id,
            displayOrder: index,
            questionText: q.question,
            answerType: q.answerType,
            weight: q.weight,
            required: q.required,
            options: q.options.map((o) => o.value),
            fileUploadAllowedTypes: q.fileUpload.allowedFileTypes,
            fileUploadMaxFileSizeMb: q.fileUpload.maxFileSizeMb,
          })),
        );
      }
      return row;
    });

    return questionTemplatesService.getById(created.id);
  },

  async update(
    id: number,
    input: QuestionTemplateInput,
    userId: number,
  ): Promise<QuestionTemplateDto> {
    const now = formatUtcNow();
    await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: questionTemplates.id })
        .from(questionTemplates)
        .where(eq(questionTemplates.id, id))
        .limit(1);
      if (!existing) throw new QuestionTemplateNotFoundError(id);

      await tx
        .update(questionTemplates)
        .set({
          name: input.name,
          description: input.description,
          stageKeys: input.stageIds.map((sid) => STAGE_ID_TO_KEY[sid as QuestionTemplateStageId]),
          clientIds: input.clientIds,
          isActive: input.isActive,
          updatedAt: now,
          updatedBy: userId,
        })
        .where(eq(questionTemplates.id, id));

      await tx.delete(questionTemplateQuestions).where(eq(questionTemplateQuestions.templateId, id));
      if (input.questions.length > 0) {
        await tx.insert(questionTemplateQuestions).values(
          input.questions.map((q, index) => ({
            templateId: id,
            displayOrder: index,
            questionText: q.question,
            answerType: q.answerType,
            weight: q.weight,
            required: q.required,
            options: q.options.map((o) => o.value),
            fileUploadAllowedTypes: q.fileUpload.allowedFileTypes,
            fileUploadMaxFileSizeMb: q.fileUpload.maxFileSizeMb,
          })),
        );
      }
    });

    return questionTemplatesService.getById(id);
  },
};
