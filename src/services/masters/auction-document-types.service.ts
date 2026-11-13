import {
  MastersErrorMessages,
  MastersValidationMessages,
} from "@auctionit/messages/masters";
import { and, asc, eq, max, ne } from "drizzle-orm";
import type {
  AuctionDocumentTypesListParams,
  CreateAuctionDocumentTypeInput,
  PatchAuctionDocumentTypeInput,
} from "../../lib/auction-document-types/schemas.js";
import type { MasterListResult } from "../../lib/masters/list-query.js";
import { legacyAuctionDocumentTypePrefix } from "../../lib/auction-document-naming.js";
import { db } from "../../db/index.js";
import { auctionDocumentTypes } from "../../db/schema/auction-document-types.js";
import { listPaginatedMaster } from "./list-paginated.js";
import { formatUtcNow } from "@auctionit/lib/date";

export type AuctionDocumentTypeMasterDto = {
  id: number;
  name: string;
  fileNamePrefix: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string | null;
};

export class AuctionDocumentTypeNotFoundError extends Error {
  constructor(id: number | string) {
    super(MastersErrorMessages.AUCTION_DOCUMENT_TYPE_NOT_FOUND(id));
    this.name = "AuctionDocumentTypeNotFoundError";
  }
}

export class AuctionDocumentTypeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuctionDocumentTypeValidationError";
  }
}

function toDto(
  row: typeof auctionDocumentTypes.$inferSelect,
): AuctionDocumentTypeMasterDto {
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
    .select({ value: max(auctionDocumentTypes.id) })
    .from(auctionDocumentTypes);
  return (row?.value ?? 0) + 1;
}

async function assertUniqueName(
  name: string,
  excludeId?: number,
): Promise<void> {
  const conditions = excludeId
    ? and(
        eq(auctionDocumentTypes.name, name),
        ne(auctionDocumentTypes.id, excludeId),
      )
    : eq(auctionDocumentTypes.name, name);

  const [existing] = await db
    .select({ id: auctionDocumentTypes.id })
    .from(auctionDocumentTypes)
    .where(conditions)
    .limit(1);

  if (existing) {
    throw new AuctionDocumentTypeValidationError(
      MastersValidationMessages.DOCUMENT_TYPE_NAME_EXISTS,
    );
  }
}

export const auctionDocumentTypesMasterService = {
  async list(activeOnly = false): Promise<AuctionDocumentTypeMasterDto[]> {
    const rows = await db
      .select()
      .from(auctionDocumentTypes)
      .where(activeOnly ? eq(auctionDocumentTypes.isActive, true) : undefined)
      .orderBy(asc(auctionDocumentTypes.id));

    return rows.map(toDto);
  },

  async listPaginated(
    params: AuctionDocumentTypesListParams,
  ): Promise<MasterListResult<AuctionDocumentTypeMasterDto>> {
    return listPaginatedMaster({
      table: auctionDocumentTypes,
      isActiveColumn: auctionDocumentTypes.isActive,
      searchColumns: [
        auctionDocumentTypes.name,
        auctionDocumentTypes.fileNamePrefix,
      ],
      searchIdColumn: auctionDocumentTypes.id,
      sortColumns: {
        id: auctionDocumentTypes.id,
        name: auctionDocumentTypes.name,
        fileNamePrefix: auctionDocumentTypes.fileNamePrefix,
        isActive: auctionDocumentTypes.isActive,
        createdAt: auctionDocumentTypes.createdAt,
        updatedAt: auctionDocumentTypes.updatedAt,
      },
      defaultOrderBy: [asc(auctionDocumentTypes.id)],
      params,
      toDto,
    });
  },

  async create(
    input: CreateAuctionDocumentTypeInput,
    userId?: number,
  ): Promise<AuctionDocumentTypeMasterDto> {
    await assertUniqueName(input.name);

    const now = formatUtcNow();
    const id = await nextDocumentTypeId();

    const [created] = await db
      .insert(auctionDocumentTypes)
      .values({
        id,
        name: input.name,
        fileNamePrefix: legacyAuctionDocumentTypePrefix(id),
        isActive: input.isActive,
        createdAt: now,
        createdBy: userId ?? null,
        updatedAt: now,
        updatedBy: userId ?? null,
      })
      .returning();

    if (!created) {
      throw new AuctionDocumentTypeValidationError(
        MastersErrorMessages.AUCTION_DOCUMENT_TYPE_CREATE_FAILED,
      );
    }

    return toDto(created);
  },

  async update(
    id: number,
    input: PatchAuctionDocumentTypeInput,
    userId?: number,
  ): Promise<AuctionDocumentTypeMasterDto> {
    const [existing] = await db
      .select()
      .from(auctionDocumentTypes)
      .where(eq(auctionDocumentTypes.id, id))
      .limit(1);

    if (!existing) {
      throw new AuctionDocumentTypeNotFoundError(id);
    }

    if (input.name !== undefined) {
      await assertUniqueName(input.name, id);
    }

    const patch: Partial<typeof auctionDocumentTypes.$inferInsert> = {
      updatedAt: formatUtcNow(),
      updatedBy: userId ?? null,
    };
    if (input.name !== undefined) patch.name = input.name;
    if (input.isActive !== undefined) patch.isActive = input.isActive;

    const [updated] = await db
      .update(auctionDocumentTypes)
      .set(patch)
      .where(eq(auctionDocumentTypes.id, id))
      .returning();

    if (!updated) {
      throw new AuctionDocumentTypeNotFoundError(id);
    }

    return toDto(updated);
  },
};
