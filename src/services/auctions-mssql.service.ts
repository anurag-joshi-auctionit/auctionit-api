import type mssql from "mssql";
import { getMssqlPool } from "../lib/mssql-pool.js";

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

export type MssqlLotRow = {
  lotId: number;
  lotNumber: string | null;
  totalQuantity: number | null;
  uom: string | null;
  startBidPrice: number | null;
  displayOrder: number | null;
  status: number | null;
  winnerUserId: number | null;
  winingAmount: number | null;
  lotEndTime: string | null;
  bidIncrement: number | null;
  bidLimit: number | null;
  isApproved: boolean | null;
  winnerCompId: number | null;
  clientId: number;
  auctionId: number;
};

export async function mssqlListLots(auctionId: number): Promise<MssqlLotRow[]> {
  const pool = await getMssqlPool();
  if (!pool) return [];

  const result = await pool
    .request()
    .input("auctionId", auctionId)
    .query(`
      SELECT
        LotId AS lotId,
        LotNumber AS lotNumber,
        TotalQuantity AS totalQuantity,
        UOM AS uom,
        StartPrice AS startBidPrice,
        DisplayOrder AS displayOrder,
        Status AS status,
        WinnerUserId AS winnerUserId,
        WiningAmount AS winingAmount,
        CONVERT(varchar(33), LotEndTime, 126) AS lotEndTime,
        BidIncrement AS bidIncrement,
        MaxBidLimit AS bidLimit,
        IsApproved AS isApproved,
        WinnerCompId AS winnerCompId,
        ClientId AS clientId,
        AuctionId AS auctionId
      FROM tbl_Data_AuctionLot
      WHERE AuctionId = @auctionId AND IsActive = 1
      ORDER BY DisplayOrder, LotId
    `);

  return result.recordset.map((r) => ({
    lotId: Number(r.lotId),
    lotNumber: toStr(r.lotNumber),
    totalQuantity: toNum(r.totalQuantity),
    uom: toStr(r.uom),
    startBidPrice: toNum(r.startBidPrice),
    displayOrder: toNum(r.displayOrder),
    status: toNum(r.status),
    winnerUserId: toNum(r.winnerUserId),
    winingAmount: toNum(r.winingAmount),
    lotEndTime: toStr(r.lotEndTime),
    bidIncrement: toNum(r.bidIncrement),
    bidLimit: toNum(r.bidLimit),
    isApproved: r.isApproved == null ? null : Boolean(r.isApproved),
    winnerCompId: toNum(r.winnerCompId),
    clientId: Number(r.clientId),
    auctionId: Number(r.auctionId),
  }));
}

export async function mssqlGetLot(
  auctionId: number,
  lotId: number,
): Promise<MssqlLotRow | null> {
  const lots = await mssqlListLots(auctionId);
  return lots.find((l) => l.lotId === lotId) ?? null;
}

export async function mssqlLotBidderSummary(
  auctionId: number,
): Promise<Array<{ lotId: number; lotNumber: string | null; bidderCount: number }>> {
  const pool = await getMssqlPool();
  if (!pool) return [];

  const result = await pool.request().input("auctionId", auctionId).query(`
    SELECT
      al.LotId AS lotId,
      al.LotNumber AS lotNumber,
      COUNT(DISTINCT m.BidderCompId) AS bidderCount
    FROM tbl_Data_AuctionLot al
    LEFT JOIN tbl_Data_Auction_BidderComp_Map m
      ON m.AuctionId = al.AuctionId
      AND m.LotId = al.LotId
      AND m.IsActive = 1
    WHERE al.AuctionId = @auctionId AND al.IsActive = 1
    GROUP BY al.LotId, al.LotNumber
    ORDER BY al.DisplayOrder, al.LotId
  `);

  return result.recordset.map((r) => ({
    lotId: Number(r.lotId),
    lotNumber: toStr(r.lotNumber),
    bidderCount: Number(r.bidderCount ?? 0),
  }));
}

export async function mssqlBidderPool(auctionId: number) {
  const pool = await getMssqlPool();
  if (!pool) return [];

  const result = await pool.request().input("auctionId", auctionId).query(`
    SELECT
      m.Id AS id,
      m.BidderCompId AS bidderCompId,
      bc.CompanyName AS bidderName,
      m.LotId AS lotId,
      m.IsActive AS isActive
    FROM tbl_Data_Auction_BidderComp_Map m
    LEFT JOIN tbl_Config_BidderCompanyMst bc ON bc.BidderCompId = m.BidderCompId
    WHERE m.AuctionId = @auctionId AND m.IsActive = 1
    ORDER BY m.Id
  `);

  return result.recordset.map((r) => ({
    id: Number(r.id),
    bidderCompId: Number(r.bidderCompId),
    bidderName: toStr(r.bidderName),
    lotId: r.lotId == null ? null : Number(r.lotId),
    isActive: Boolean(r.isActive),
  }));
}

export async function mssqlLotMappedBidders(
  auctionId: number,
  lotId: number,
): Promise<Array<{ bidderCompId: number; bidderName: string | null }>> {
  const pool = await getMssqlPool();
  if (!pool) return [];

  const result = await pool
    .request()
    .input("auctionId", auctionId)
    .input("lotId", lotId)
    .query(`
      SELECT
        m.BidderCompId AS bidderCompId,
        bc.CompanyName AS bidderName
      FROM tbl_Data_Auction_BidderComp_Map m
      LEFT JOIN tbl_Config_BidderCompanyMst bc ON bc.BidderCompId = m.BidderCompId
      WHERE m.AuctionId = @auctionId AND m.LotId = @lotId AND m.IsActive = 1
    `);

  return result.recordset.map((r) => ({
    bidderCompId: Number(r.bidderCompId),
    bidderName: toStr(r.bidderName),
  }));
}

export async function mssqlLotItems(
  clientId: number,
  auctionId: number,
  lotId: number,
): Promise<Array<{ itemId: number; itemName: string | null; quantity: number | null; uom: string | null }>> {
  const pool = await getMssqlPool();
  if (!pool) return [];

  const result = await pool
    .request()
    .input("clientId", clientId)
    .input("auctionId", auctionId)
    .input("lotId", lotId)
    .query(`
      SELECT
        ItemId AS itemId,
        ItemName AS itemName,
        Quantity AS quantity,
        UOM AS uom
      FROM tbl_Data_Auction_Lot_Items
      WHERE ClientId = @clientId
        AND AuctionId = @auctionId
        AND LotId = @lotId
        AND IsActive = 1
      ORDER BY ItemId
    `);

  return result.recordset.map((r) => ({
    itemId: Number(r.itemId),
    itemName: toStr(r.itemName),
    quantity: toNum(r.quantity),
    uom: toStr(r.uom),
  }));
}

export async function mssqlEmdRanges(auctionId: number) {
  const pool = await getMssqlPool();
  if (!pool) return [];

  const result = await pool.request().input("auctionId", auctionId).query(`
    SELECT
      LotEMDId AS lotEmdId,
      DisplayOrderFrom AS displayOrderFrom,
      DisplayOrderTo AS displayOrderTo,
      EMD AS emd,
      LotEMDDisplayOrder AS lotEmdDisplayOrder
    FROM tbl_Config_AuctionLotEMD
    WHERE AuctionId = @auctionId
    ORDER BY LotEMDDisplayOrder, LotEMDId
  `);

  return result.recordset.map((r) => ({
    lotEmdId: Number(r.lotEmdId),
    displayOrderFrom: Number(r.displayOrderFrom),
    displayOrderTo: Number(r.displayOrderTo),
    emd: Number(r.emd),
    lotEmdDisplayOrder:
      r.lotEmdDisplayOrder == null ? null : Number(r.lotEmdDisplayOrder),
  }));
}

export async function mssqlInsertEmdRange(
  auctionId: number,
  body: { displayOrderFrom: number; displayOrderTo: number; emd: number },
  userId: number,
) {
  const pool = await getMssqlPool();
  if (!pool) throw new Error("MSSQL not configured");

  await pool
    .request()
    .input("auctionId", auctionId)
    .input("from", body.displayOrderFrom)
    .input("to", body.displayOrderTo)
    .input("emd", body.emd)
    .input("userId", userId)
    .query(`
      INSERT INTO tbl_Config_AuctionLotEMD (
        AuctionId, DisplayOrderFrom, DisplayOrderTo, EMD, CreatedBy, CreatedOn
      ) VALUES (@auctionId, @from, @to, @emd, @userId, GETDATE())
    `);
}

export async function mssqlDeleteEmdRange(auctionId: number, lotEmdId: number) {
  const pool = await getMssqlPool();
  if (!pool) throw new Error("MSSQL not configured");

  await pool
    .request()
    .input("auctionId", auctionId)
    .input("lotEmdId", lotEmdId)
    .query(`
      DELETE FROM tbl_Config_AuctionLotEMD
      WHERE AuctionId = @auctionId AND LotEMDId = @lotEmdId
    `);
}

export async function mssqlCatalogues(auctionId: number) {
  const pool = await getMssqlPool();
  if (!pool) return [];

  const result = await pool.request().input("auctionId", auctionId).query(`
    SELECT
      CatalogId AS catalogId,
      VersionNumber AS versionNumber,
      CatalogFileName AS catalogFileName,
      ChangesIncorporated AS changesIncorporated,
      DATALENGTH(Catalog) AS fileSize,
      IsActive AS isActive,
      CONVERT(varchar(33), CreateDatetime, 126) AS createDatetime
    FROM tbl_Data_AuctionCatalog
    WHERE AuctionId = @auctionId
    ORDER BY VersionNumber DESC
  `);

  return result.recordset.map((r) => ({
    catalogId: Number(r.catalogId),
    versionNumber: Number(r.versionNumber),
    catalogFileName: String(r.catalogFileName),
    changesIncorporated: toStr(r.changesIncorporated),
    fileSize: toNum(r.fileSize),
    isActive: Boolean(r.isActive),
    createDatetime: String(r.createDatetime),
  }));
}

export async function mssqlApproveLots(
  auctionId: number,
  lotIds: number[] | "all",
) {
  const pool = await getMssqlPool();
  if (!pool) throw new Error("MSSQL not configured");

  const request = pool.request().input("auctionId", auctionId);
  if (lotIds === "all") {
    await request.query(`
      UPDATE tbl_Data_AuctionLot
      SET IsApproved = 1, ApprovalDate = CAST(GETDATE() AS date)
      WHERE AuctionId = @auctionId AND IsActive = 1 AND (IsApproved IS NULL OR IsApproved = 0)
    `);
    return;
  }

  for (const lotId of lotIds) {
    await pool
      .request()
      .input("auctionId", auctionId)
      .input("lotId", lotId)
      .query(`
        UPDATE tbl_Data_AuctionLot
        SET IsApproved = 1, ApprovalDate = CAST(GETDATE() AS date)
        WHERE AuctionId = @auctionId AND LotId = @lotId
      `);
  }
}

export async function mssqlRejectLots(auctionId: number, lotIds: number[]) {
  const pool = await getMssqlPool();
  if (!pool) throw new Error("MSSQL not configured");

  for (const lotId of lotIds) {
    await pool
      .request()
      .input("auctionId", auctionId)
      .input("lotId", lotId)
      .query(`
        UPDATE tbl_Data_AuctionLot
        SET IsApproved = 0
        WHERE AuctionId = @auctionId AND LotId = @lotId
      `);
  }
}

export async function mssqlPatchLot(
  auctionId: number,
  lotId: number,
  body: { startBidPrice?: number; displayOrder?: number },
) {
  const pool = await getMssqlPool();
  if (!pool) throw new Error("MSSQL not configured");

  const sets: string[] = [];
  const request = pool
    .request()
    .input("auctionId", auctionId)
    .input("lotId", lotId);

  if (body.startBidPrice !== undefined) {
    sets.push("StartPrice = @startBidPrice");
    request.input("startBidPrice", body.startBidPrice);
  }
  if (body.displayOrder !== undefined) {
    sets.push("DisplayOrder = @displayOrder");
    request.input("displayOrder", body.displayOrder);
  }
  if (sets.length === 0) return;

  await request.query(`
    UPDATE tbl_Data_AuctionLot
    SET ${sets.join(", ")}, UpdateDatetime = GETDATE()
    WHERE AuctionId = @auctionId AND LotId = @lotId
  `);
}

export async function mssqlWinnerName(
  winnerCompId: number | null,
): Promise<string | null> {
  if (winnerCompId == null) return null;
  const pool = await getMssqlPool();
  if (!pool) return null;

  const result = await pool
    .request()
    .input("id", winnerCompId)
    .query(
      `SELECT CompanyName AS name FROM tbl_Config_BidderCompanyMst WHERE BidderCompId = @id`,
    );
  return toStr(result.recordset[0]?.name);
}

export async function mssqlAuctionStats(auctionId: number) {
  const lots = await mssqlListLots(auctionId);
  const lotsWithBidders = await mssqlLotBidderSummary(auctionId);
  const mappedCount = lotsWithBidders.filter((l) => l.bidderCount > 0).length;
  const catalogues = await mssqlCatalogues(auctionId);
  const emdRanges = await mssqlEmdRanges(auctionId);
  const pool = await mssqlBidderPool(auctionId);

  const totalQty = lots.reduce((s, l) => s + (l.totalQuantity ?? 0), 0);
  const soldQty = lots.reduce((s, l) => s + (l.winingAmount != null ? (l.totalQuantity ?? 0) : 0), 0);

  return {
    lotsTotal: lots.length,
    lotsPreview: lots.slice(0, 10),
    lotsWithBidders: mappedCount,
    catalogueUploaded: catalogues.length > 0,
    currentCatalogue:
      catalogues.length > 0
        ? {
            name: catalogues[0]!.catalogFileName,
            uploadedAt: catalogues[0]!.createDatetime,
          }
        : null,
    lotEmdSet: emdRanges.length > 0,
    lotEmdCount: emdRanges.length,
    biddersMapped: mappedCount > 0,
    bidderCount: new Set(pool.map((p) => p.bidderCompId)).size,
    totalQty: totalQty || null,
    soldQty: soldQty || null,
    uom: lots[0]?.uom ?? null,
  };
}

export async function mssqlRemoveBidderPoolEntry(
  auctionId: number,
  mapId: number,
) {
  const pool = await getMssqlPool();
  if (!pool) throw new Error("MSSQL not configured");

  await pool
    .request()
    .input("auctionId", auctionId)
    .input("mapId", mapId)
    .query(`
      UPDATE tbl_Data_Auction_BidderComp_Map
      SET IsActive = 0, UpdateDatetime = GETDATE()
      WHERE AuctionId = @auctionId AND Id = @mapId
    `);
}

export async function mssqlApplyLotCorrection(
  auctionId: number,
  lotId: number,
  type: string,
) {
  const pool = await getMssqlPool();
  if (!pool) throw new Error("MSSQL not configured");

  if (type === "reopen_lot") {
    // Keep Winner* / WiningAmount — current-leader snapshot from bids.
    await pool
      .request()
      .input("auctionId", auctionId)
      .input("lotId", lotId)
      .query(`
        UPDATE tbl_Data_AuctionLot
        SET Status = 1
        WHERE AuctionId = @auctionId AND LotId = @lotId
      `);
    return;
  }

  if (type === "remove_h1") {
    await pool
      .request()
      .input("auctionId", auctionId)
      .input("lotId", lotId)
      .query(`
        UPDATE tbl_Data_AuctionLot
        SET WinnerUserId = NULL, WiningAmount = NULL, WinnerCompId = NULL
        WHERE AuctionId = @auctionId AND LotId = @lotId
      `);
  }
}
