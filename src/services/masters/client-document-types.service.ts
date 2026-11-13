import {
  MastersErrorMessages,
  MastersValidationMessages,
} from "@auctionit/messages/masters";
import { and, asc, eq, max, ne } from "drizzle-orm";
import type {
  ClientDocumentTypesListParams,
  CreateClientDocumentTypeInput,
  PatchClientDocumentTypeInput,
} from "../../lib/client-document-types/schemas.js";
import type { MasterListResult } from "../../lib/masters/list-query.js";
import { legacyClientDocumentTypePrefix } from "../../lib/client-document-naming.js";
import { db } from "../../db/index.js";
import { clientDocumentTypes } from "../../db/schema/client-document-types.js";
import { listPaginatedMaster } from "./list-paginated.js";
import { formatUtcNow } from "@auctionit/lib/date";

export type ClientDocumentTypeMasterDto = {
  id: number;
  name: string;
  fileNamePrefix: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string | null;
};

export class ClientDocumentTypeNotFoundError extends Error {
  constructor(id: number | string) {
    super(MastersErrorMessages.CLIENT_DOCUMENT_TYPE_NOT_FOUND(id));
    this.name = "ClientDocumentTypeNotFoundError";
  }
}

export class ClientDocumentTypeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientDocumentTypeValidationError";
  }
}

function toDto(row: typeof clientDocumentTypes.$inferSelect): ClientDocumentTypeMasterDto {
  return {
    id: row.id,
    name: row.name,
    fileNamePrefix: row.fileNamePrefix,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? null,
  };
}

async function nextDocumentTypeId(): Promise<number> {
  const [row] = await db
    .select({ value: max(clientDocumentTypes.id) })
    .from(clientDocumentTypes);
  return (row?.value ?? 0) + 1;
}

async function assertUniqueName(
  name: string,
  excludeId?: number,
): Promise<void> {
  const conditions = excludeId
    ? and(eq(clientDocumentTypes.name, name), ne(clientDocumentTypes.id, excludeId))
    : eq(clientDocumentTypes.name, name);

  const [existing] = await db
    .select({ id: clientDocumentTypes.id })
    .from(clientDocumentTypes)
    .where(conditions)
    .limit(1);

  if (existing) {
    throw new ClientDocumentTypeValidationError(
      MastersValidationMessages.DOCUMENT_TYPE_NAME_EXISTS,
    );
  }
}

export const clientDocumentTypesMasterService = {
  async list(activeOnly = false): Promise<ClientDocumentTypeMasterDto[]> {
    const rows = await db
      .select()
      .from(clientDocumentTypes)
      .where(activeOnly ? eq(clientDocumentTypes.isActive, true) : undefined)
      .orderBy(asc(clientDocumentTypes.id));

    return rows.map(toDto);
  },

  async listPaginated(
    params: ClientDocumentTypesListParams,
  ): Promise<MasterListResult<ClientDocumentTypeMasterDto>> {
    return listPaginatedMaster({
      table: clientDocumentTypes,
      isActiveColumn: clientDocumentTypes.isActive,
      searchColumns: [
        clientDocumentTypes.name,
        clientDocumentTypes.fileNamePrefix,
      ],
      searchIdColumn: clientDocumentTypes.id,
      sortColumns: {
        id: clientDocumentTypes.id,
        name: clientDocumentTypes.name,
        fileNamePrefix: clientDocumentTypes.fileNamePrefix,
        isActive: clientDocumentTypes.isActive,
        createdAt: clientDocumentTypes.createdAt,
        updatedAt: clientDocumentTypes.updatedAt,
      },
      defaultOrderBy: [asc(clientDocumentTypes.id)],
      params,
      toDto,
    });
  },

  async create(
    input: CreateClientDocumentTypeInput,
    userId?: number,
  ): Promise<ClientDocumentTypeMasterDto> {
    await assertUniqueName(input.name);

    const now = formatUtcNow();
    const id = await nextDocumentTypeId();

    const [created] = await db
      .insert(clientDocumentTypes)
      .values({
        id,
        name: input.name,
        fileNamePrefix: legacyClientDocumentTypePrefix(id),
        isActive: input.isActive,
        createdAt: now,
        createdBy: userId ?? null,
        updatedAt: now,
        updatedBy: userId ?? null,
      })
      .returning();

    if (!created) {
      throw new ClientDocumentTypeValidationError(
        MastersErrorMessages.CLIENT_DOCUMENT_TYPE_CREATE_FAILED,
      );
    }

    return toDto(created);
  },

  async update(
    id: number,
    input: PatchClientDocumentTypeInput,
    userId?: number,
  ): Promise<ClientDocumentTypeMasterDto> {
    const [existing] = await db
      .select()
      .from(clientDocumentTypes)
      .where(eq(clientDocumentTypes.id, id))
      .limit(1);

    if (!existing) {
      throw new ClientDocumentTypeNotFoundError(id);
    }

    if (input.name !== undefined) {
      await assertUniqueName(input.name, id);
    }

    const patch: Partial<typeof clientDocumentTypes.$inferInsert> = {
      updatedAt: formatUtcNow(),
      updatedBy: userId ?? null,
    };
    if (input.name !== undefined) patch.name = input.name;
    if (input.isActive !== undefined) patch.isActive = input.isActive;

    const [updated] = await db
      .update(clientDocumentTypes)
      .set(patch)
      .where(eq(clientDocumentTypes.id, id))
      .returning();

    if (!updated) {
      throw new ClientDocumentTypeNotFoundError(id);
    }

    return toDto(updated);
  },
};
