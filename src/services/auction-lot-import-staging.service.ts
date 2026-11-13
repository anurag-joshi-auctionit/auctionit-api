import {
  AuctionsErrorMessages,
  AuctionsValidationMessages,
} from "@auctionit/messages/auctions";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import {
  LOADING_SCOPE_LABELS,
  isLoadingScope,
} from "@auctionit/lib/loading-scope";
import { db } from "../db/index.js";
import { auctionLotImportStagingSessions } from "../db/schema/index.js";
import type {
  AuctionLotImportStagingPayload,
  AuctionLotImportStagingRow,
  AuctionLotImportStagingSessionView,
} from "../lib/auction-lot-import-types.js";
import {
  pgLoadActiveBenchmarkOptions,
  pgListLotEditorOptions,
} from "./auctions-pg.service.js";
import { pgLoadClientActiveItems } from "./auction-lot-item-match.service.js";
import type { AuctionLotExportRowData } from "./auction-lot-export.js";

/** Session TTL — must match the interval used in createLotImportStagingSession. */
const STAGING_TTL_INTERVAL = sql`now() + interval '2 hours'`;

export class AuctionLotImportStagingError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "AuctionLotImportStagingError";
  }
}

export async function createLotImportStagingSession(params: {
  auctionId: number;
  clientId: number;
  createdBy: number;
  rows: AuctionLotImportStagingRow[];
}): Promise<string> {
  const payload: AuctionLotImportStagingPayload = { rows: params.rows };
  const [row] = await db
    .insert(auctionLotImportStagingSessions)
    .values({
      auctionId: params.auctionId,
      clientId: params.clientId,
      createdBy: params.createdBy,
      payload,
      // Session TZ is Asia/Kolkata — use DB now() so tz-naive timestamps stay consistent.
      expiresAt: STAGING_TTL_INTERVAL,
      createdAt: sql`now()`,
    })
    .returning({ id: auctionLotImportStagingSessions.id });

  if (!row) {
    throw new AuctionLotImportStagingError(
      AuctionsErrorMessages.FAILED_TO_CREATE_LOT_IMPORT_STAGING,
      500,
    );
  }
  return row.id;
}

async function loadSessionRow(stagingId: string, auctionId: number, userId: number) {
  const [session] = await db
    .select()
    .from(auctionLotImportStagingSessions)
    .where(
      and(
        eq(auctionLotImportStagingSessions.id, stagingId),
        eq(auctionLotImportStagingSessions.auctionId, auctionId),
        eq(auctionLotImportStagingSessions.createdBy, userId),
        gt(auctionLotImportStagingSessions.expiresAt, sql`now()`),
      ),
    )
    .limit(1);

  if (session) {
    return session;
  }

  // Distinguish not-found vs expired for clearer client messaging.
  const [any] = await db
    .select({
      id: auctionLotImportStagingSessions.id,
      expiresAt: auctionLotImportStagingSessions.expiresAt,
    })
    .from(auctionLotImportStagingSessions)
    .where(
      and(
        eq(auctionLotImportStagingSessions.id, stagingId),
        eq(auctionLotImportStagingSessions.auctionId, auctionId),
        eq(auctionLotImportStagingSessions.createdBy, userId),
      ),
    )
    .limit(1);

  if (!any) {
    throw new AuctionLotImportStagingError(
      AuctionsValidationMessages.LOT_IMPORT_STAGING_NOT_FOUND,
      404,
    );
  }

  await db
    .delete(auctionLotImportStagingSessions)
    .where(eq(auctionLotImportStagingSessions.id, stagingId));
  throw new AuctionLotImportStagingError(
    AuctionsValidationMessages.LOT_IMPORT_STAGING_EXPIRED,
    410,
  );
}

export async function getLotImportStagingSession(
  auctionId: number,
  stagingId: string,
  userId: number,
): Promise<AuctionLotImportStagingSessionView> {
  const session = await loadSessionRow(stagingId, auctionId, userId);
  const payload = session.payload as AuctionLotImportStagingPayload;
  const [items, benchmarks] = await Promise.all([
    pgLoadClientActiveItems(session.clientId),
    pgLoadActiveBenchmarkOptions(),
  ]);

  return {
    stagingId: session.id,
    auctionId: session.auctionId,
    expiresAt: session.expiresAt,
    items,
    benchmarks,
    rows: payload.rows
      .slice()
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map((row) => {
      const base = {
        rowNumber: row.rowNumber,
        lotNumber: row.lotNumber,
        displayOrder: row.displayOrder,
        materialName: row.materialName,
        startBidPrice: row.startBidPrice,
        bidIncrement: row.bidIncrement,
        bidLimit: row.bidLimit,
        benchmarkMaterial: row.benchmarkMaterial,
        benchmarkMaterialLocationId: row.benchmarkMaterialLocationId,
        quantity: row.quantity,
        uom: row.uomCode,
        lotStartTime: row.lotStartTime,
        lotEndTime: row.lotEndTime,
      };
      if (row.itemId != null) {
        return {
          ...base,
          fuzzyCandidate: 0 as const,
          score: 100,
          suggestedItemIds: [row.itemId],
          selectedItemId: row.itemId,
        };
      }
      const match = row.match;
      return {
        ...base,
        fuzzyCandidate: match?.fuzzyCandidate ?? 2,
        score: match?.score ?? 0,
        suggestedItemIds: match?.suggestedItemIds ?? [],
        selectedItemId: match?.selectedItemId ?? null,
      };
    }),
  };
}

export async function loadStagingPayloadForConfirm(
  auctionId: number,
  stagingId: string,
  userId: number,
): Promise<{
  clientId: number;
  rows: AuctionLotImportStagingRow[];
}> {
  const session = await loadSessionRow(stagingId, auctionId, userId);
  const payload = session.payload as AuctionLotImportStagingPayload;
  return { clientId: session.clientId, rows: payload.rows };
}

/**
 * Current review state (the given, possibly partial, selections overlaid onto
 * the authoritative staged rows) for the "Export" action in the review panel.
 */
export async function buildLotImportStagingExportRows(
  auctionId: number,
  stagingId: string,
  userId: number,
  selections: {
    rowNumber: number;
    itemId?: number | null;
    benchmarkMaterialLocationId?: number | null;
  }[],
): Promise<AuctionLotExportRowData[]> {
  const session = await loadSessionRow(stagingId, auctionId, userId);
  const payload = session.payload as AuctionLotImportStagingPayload;
  const options = await pgListLotEditorOptions(session.clientId);

  const itemNameById = new Map(options.items.map((i) => [i.id, i.name] as const));
  const benchmarkLabelById = new Map(
    options.benchmarks.map((b) => [b.id, b.label] as const),
  );
  const plantLocationNameById = new Map(
    options.plantLocations.map((p) => [p.id, p.name] as const),
  );
  const materialLocationNameById = new Map(
    options.materialLocations.map((m) => [m.id, m.name] as const),
  );
  const overlayByRow = new Map(selections.map((s) => [s.rowNumber, s] as const));

  return payload.rows
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .map((row): AuctionLotExportRowData => {
      const overlay = overlayByRow.get(row.rowNumber);
      const itemId = overlay ? overlay.itemId ?? null : row.itemId;
      const benchmarkId = overlay
        ? overlay.benchmarkMaterialLocationId ?? null
        : row.benchmarkMaterialLocationId;
      return {
        displayOrder: row.displayOrder,
        lotNumber: row.lotNumber,
        materialLiftingDays: row.materialLiftingDays,
        plantLocation:
          row.plantLocationId != null
            ? plantLocationNameById.get(row.plantLocationId) ?? null
            : null,
        materialLocation:
          row.materialLocationId != null
            ? materialLocationNameById.get(row.materialLocationId) ?? null
            : null,
        startBidPrice: row.startBidPrice,
        bidIncrement: row.bidIncrement,
        bidLimit: row.bidLimit,
        quantity: row.quantity,
        uom: row.uomCode,
        lotStartTime: row.lotStartTime,
        lotEndTime: row.lotEndTime,
        itemLabel:
          itemId != null ? `${itemNameById.get(itemId) ?? ""}@@${itemId}` : null,
        materialDescription: row.materialDescription,
        materialName: row.materialName,
        benchmarkMaterial:
          benchmarkId != null
            ? benchmarkLabelById.get(benchmarkId) ?? row.benchmarkMaterial
            : row.benchmarkMaterial,
        gstPercentage: row.gstPercentage,
        tcsPercentage: row.tcsPercentage,
        loadingScope: isLoadingScope(row.loadingScope)
          ? LOADING_SCOPE_LABELS[row.loadingScope]
          : null,
        remark: row.remark,
      };
    });
}

export async function deleteLotImportStagingSession(
  stagingId: string,
): Promise<void> {
  await db
    .delete(auctionLotImportStagingSessions)
    .where(eq(auctionLotImportStagingSessions.id, stagingId));
}

/** Best-effort cleanup of expired sessions. */
export async function purgeExpiredLotImportStagingSessions(): Promise<void> {
  await db
    .delete(auctionLotImportStagingSessions)
    .where(lt(auctionLotImportStagingSessions.expiresAt, sql`now()`));
}
