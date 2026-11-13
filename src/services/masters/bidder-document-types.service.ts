import {
  MastersErrorMessages,
  MastersValidationMessages,
} from "@auctionit/messages/masters";
import { and, asc, eq, max, ne } from "drizzle-orm";
import type {
  BidderDocumentTypesListParams,
  CreateBidderDocumentTypeInput,
  PatchBidderDocumentTypeInput,
} from "../../lib/bidder-document-types/schemas.js";
import type { MasterListResult } from "../../lib/masters/list-query.js";
import { legacyBidderDocumentTypePrefix } from "../../lib/bidder-document-naming.js";
import { db } from "../../db/index.js";
import { bidderDocumentTypes } from "../../db/schema/bidder-document-types.js";
import { listPaginatedMaster } from "./list-paginated.js";
import { formatUtcNow } from "@auctionit/lib/date";

export type BidderDocumentTypeMasterDto = {
  id: number;
  name: string;
  fileNamePrefix: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string | null;
};

export class BidderDocumentTypeNotFoundError extends Error {
  constructor(id: number | string) {
    super(MastersErrorMessages.BIDDER_DOCUMENT_TYPE_NOT_FOUND(id));
    this.name = "BidderDocumentTypeNotFoundError";
  }
}

export class BidderDocumentTypeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BidderDocumentTypeValidationError";
  }
}

function toDto(row: typeof bidderDocumentTypes.$inferSelect): BidderDocumentTypeMasterDto {
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
    .select({ value: max(bidderDocumentTypes.id) })
    .from(bidderDocumentTypes);
  return (row?.value ?? 0) + 1;
}

async function assertUniqueName(
  name: string,
  excludeId?: number,
): Promise<void> {
  const conditions = excludeId
    ? and(eq(bidderDocumentTypes.name, name), ne(bidderDocumentTypes.id, excludeId))
    : eq(bidderDocumentTypes.name, name);

  const [existing] = await db
    .select({ id: bidderDocumentTypes.id })
    .from(bidderDocumentTypes)
    .where(conditions)
    .limit(1);

  if (existing) {
    throw new BidderDocumentTypeValidationError(
      MastersValidationMessages.DOCUMENT_TYPE_NAME_EXISTS,
    );
  }
}

export const bidderDocumentTypesMasterService = {
  async list(activeOnly = false): Promise<BidderDocumentTypeMasterDto[]> {
    const rows = await db
      .select()
      .from(bidderDocumentTypes)
      .where(activeOnly ? eq(bidderDocumentTypes.isActive, true) : undefined)
      .orderBy(asc(bidderDocumentTypes.id));

    return rows.map(toDto);
  },

  async listPaginated(
    params: BidderDocumentTypesListParams,
  ): Promise<MasterListResult<BidderDocumentTypeMasterDto>> {
    return listPaginatedMaster({
      table: bidderDocumentTypes,
      isActiveColumn: bidderDocumentTypes.isActive,
      searchColumns: [
        bidderDocumentTypes.name,
        bidderDocumentTypes.fileNamePrefix,
      ],
      searchIdColumn: bidderDocumentTypes.id,
      sortColumns: {
        id: bidderDocumentTypes.id,
        name: bidderDocumentTypes.name,
        fileNamePrefix: bidderDocumentTypes.fileNamePrefix,
        isActive: bidderDocumentTypes.isActive,
        createdAt: bidderDocumentTypes.createdAt,
        updatedAt: bidderDocumentTypes.updatedAt,
      },
      defaultOrderBy: [asc(bidderDocumentTypes.id)],
      params,
      toDto,
    });
  },

  async create(
    input: CreateBidderDocumentTypeInput,
    userId?: number,
  ): Promise<BidderDocumentTypeMasterDto> {
    await assertUniqueName(input.name);

    const now = formatUtcNow();
    const id = await nextDocumentTypeId();

    const [created] = await db
      .insert(bidderDocumentTypes)
      .values({
        id,
        name: input.name,
        fileNamePrefix: legacyBidderDocumentTypePrefix(id),
        isActive: input.isActive,
        createdAt: now,
        createdBy: userId ?? null,
        updatedAt: now,
        updatedBy: userId ?? null,
      })
      .returning();

    if (!created) {
      throw new BidderDocumentTypeValidationError(
        MastersErrorMessages.BIDDER_DOCUMENT_TYPE_CREATE_FAILED,
      );
    }

    return toDto(created);
  },

  async update(
    id: number,
    input: PatchBidderDocumentTypeInput,
    userId?: number,
  ): Promise<BidderDocumentTypeMasterDto> {
    const [existing] = await db
      .select()
      .from(bidderDocumentTypes)
      .where(eq(bidderDocumentTypes.id, id))
      .limit(1);

    if (!existing) {
      throw new BidderDocumentTypeNotFoundError(id);
    }

    if (input.name !== undefined) {
      await assertUniqueName(input.name, id);
    }

    const patch: Partial<typeof bidderDocumentTypes.$inferInsert> = {
      updatedAt: formatUtcNow(),
      updatedBy: userId ?? null,
    };
    if (input.name !== undefined) patch.name = input.name;
    if (input.isActive !== undefined) patch.isActive = input.isActive;

    const [updated] = await db
      .update(bidderDocumentTypes)
      .set(patch)
      .where(eq(bidderDocumentTypes.id, id))
      .returning();

    if (!updated) {
      throw new BidderDocumentTypeNotFoundError(id);
    }

    return toDto(updated);
  },
};
