import { LiftingClientsValidationMessages } from "@auctionit/messages/lifting-clients";
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../db/index.js";
import {
  auctionLotItems,
  auctionLots,
  auctions,
  bidders,
  clients,
  liftingClientLogs,
  plantLocations,
  users,
} from "../db/schema/index.js";

const bidderContactUser = alias(users, "bidder_contact_user");
import { syncLatestLiftedForLotSql } from "../lib/lifting-latest-lifted-sync.js";
import { LIFTING_CLIENT_DISPOSITION_LABELS } from "../lib/lifting-client-status.js";
import {
  assertActiveClientDisposition,
  resolveClientDispositionByStatus,
} from "./masters/resolve-disposition.js";
import {
  LIFTING_CLIENT_AUCTION_LOOKBACK_DAYS,
  LIFTING_EXCLUDED_CLIENT_IDS,
} from "../lib/lifting-scope.js";
import { liftingEligibleLotCondition } from "../lib/lifting-lot-eligibility.js";
import {
  formatLotId,
  LiftingClientLogNotFoundError,
  LiftingClientValidationError,
  LiftingLotNotFoundError,
  parseLotId,
} from "../lib/lifting-lot-id.js";
import { parseQty, roundQtySql, roundQtyToTwoDecimals } from "../lib/qty.js";
import { clampPagination } from "./list-query.js";
import { datetimeLocalToIso, dateInputToIso, formatIstWallNow, formatUtcNow } from "@auctionit/lib/date";

export type LiftingClientLotRow = {
  id: string;
  clientId: number;
  auctionId: number;
  auctionDate: string;
  auctionName: string;
  clientName: string;
  plantName: string;
  lotNumber: string;
  bidderName: string;
  contactPhone: string;
  auctionType: string | null;
  approvedQty: number;
  totalLiftedQty: number;
  balanceQty: number;
  lastLiftedDate: string | null;
  dispositionStatus: number;
  dispositionStatusLabel: string;
  remarks: string;
};

export type LiftingClientListParams = {
  page: number;
  pageSize: number;
  clientIds: number[];
  auctionIds: number[];
  allRecentAuctions?: boolean;
  dispositionStatus?: number;
  search?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
};

export type LiftingClientImportScope = Pick<
  LiftingClientListParams,
  "clientIds" | "auctionIds" | "dispositionStatus"
>;

export type Paginated<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export type LiftingClientFilterClient = {
  clientId: number;
  companyName: string;
};

export type LiftingClientFilterAuction = {
  label: string;
  auctionNumber: string;
  clientId: number;
  auctionId: number;
};

export type LiftingClientLogInput = {
  liftedQty: number;
  liftedDate: string;
  dispositionStatus: number;
  remarks: string;
};

export type LiftingClientLogRow = {
  id: string;
  liftedQty: number;
  liftedDate: string;
  dispositionStatus: number;
  dispositionStatusLabel: string;
  remarks: string;
  loggedAt: string;
  createdByUserId: string;
  createdByUserName: string | null;
};

export type LiftingClientLogsListParams = {
  page: number;
  pageSize: number;
  search?: string;
  sortBy?: "liftedDate" | "loggedAt" | "liftedQty";
  sortOrder?: "asc" | "desc";
  dispositionStatus?: number;
};

const LIFTING_CLIENT_SORT_FIELDS = new Set([
  "auctionDate",
  "approvedQty",
  "totalLiftedQty",
  "balanceQty",
  "lastLiftedDate",
]);

const excludedClientsCondition = notInArray(auctionLots.clientId, [
  ...LIFTING_EXCLUDED_CLIENT_IDS,
]);

const recentAuctionCreateDatetimeCondition = sql`${auctions.createdAt} >= now() - make_interval(days => ${LIFTING_CLIENT_AUCTION_LOOKBACK_DAYS})`;

const liftingAggSubquery = sql`
  (
    SELECT
      ll.client_id AS client_id,
      ll.lot_id AS lot_id,
      COALESCE(SUM(CAST(ll.qty AS decimal(38, 3))), 0) AS total_lifted_qty,
      CAST(MAX(ll.lifting_date) AS text) AS last_lifted_date
    FROM lifting_client_logs ll
    GROUP BY ll.client_id, ll.lot_id
  ) lifting_agg
`;

const latestLiftingRemarksSql = sql<string | null>`(
  SELECT ll.rfdl_reason_description
  FROM lifting_client_logs ll
  WHERE ll.client_id = ${auctionLots.clientId}
    AND ll.lot_id = ${auctionLots.id}
  ORDER BY ll.id DESC
  LIMIT 1
)`;

const listApprovedQtySql = roundQtySql(
  sql`COALESCE(CAST(${auctionLots.quantity} AS decimal(38, 3)), 0)`,
);

const listTotalLiftedQtySql = roundQtySql(
  sql`COALESCE(CAST(lifting_agg.total_lifted_qty AS decimal(38, 3)), 0)`,
);

const listBalanceQtySql = roundQtySql(
  sql`(CASE WHEN (0) >= ((${listApprovedQtySql}) - (${listTotalLiftedQtySql})) THEN (0) ELSE ((${listApprovedQtySql}) - (${listTotalLiftedQtySql})) END)`,
);

function toIso(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const asLocal = trimmed.includes("T")
      ? trimmed.slice(0, 19)
      : trimmed.replace(" ", "T").slice(0, 19);
    const fromDatetimeLocal = datetimeLocalToIso(asLocal);
    if (fromDatetimeLocal) return fromDatetimeLocal;
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return dateInputToIso(trimmed);
  }
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : formatUtcNow(d);
}

function buildAuctionIdsCondition(auctionIds: number[]): SQL | undefined {
  if (auctionIds.length === 0) return undefined;
  return inArray(auctionLots.auctionId, auctionIds);
}

function listScopeQuery(selectShape: Parameters<typeof db.select>[0]) {
  return db
    .select(selectShape)
    .from(auctionLots)
    .innerJoin(
      auctions,
      and(
        eq(auctions.id, auctionLots.auctionId),
        eq(auctions.clientId, auctionLots.clientId),
      ),
    )
    .innerJoin(clients, eq(clients.id, auctionLots.clientId))
    .leftJoin(
      sql`${liftingAggSubquery}`,
      sql`lifting_agg.client_id = ${auctionLots.clientId} AND lifting_agg.lot_id = ${auctionLots.id}`,
    )
    .leftJoin(
      plantLocations,
      and(
        eq(plantLocations.id, auctionLots.plantLocationId),
        eq(plantLocations.clientId, auctionLots.clientId),
      ),
    )
    .leftJoin(bidders, eq(bidders.id, auctionLots.winnerBidderId))
    .leftJoin(
      bidderContactUser,
      and(
        eq(bidderContactUser.bidderId, bidders.id),
        eq(bidderContactUser.isActive, true),
      ),
    );
}

type LotRowRaw = {
  clientId: number;
  lotId: number;
  auctionId: number;
  latestLiftedStatus: number;
  auctionDate: string;
  auctionNumber: string | null;
  lotNumber: string | null;
  totalQuantity: string | null;
  clientName: string;
  plantName: string | null;
  bidderName: string | null;
  contactPhone: string | null;
  auctionType: string | null;
  totalLiftedQty: string;
  lastLiftedDate: string | null;
  remarks: string | null;
};

async function mapLotRow(raw: LotRowRaw): Promise<LiftingClientLotRow> {
  const approvedQty = parseQty(raw.totalQuantity);
  const totalLiftedQty = parseQty(raw.totalLiftedQty);
  const resolved = await resolveClientDispositionByStatus(
    raw.latestLiftedStatus,
  );
  const dispositionStatus = resolved.id;
  const auctionName =
    raw.auctionNumber?.trim() || `Auction ${raw.auctionId}`;

  return {
    id: formatLotId(raw.lotId),
    clientId: raw.clientId,
    auctionId: raw.auctionId,
    auctionDate: toIso(raw.auctionDate) ?? formatUtcNow(),
    auctionName,
    clientName: raw.clientName,
    plantName: raw.plantName?.trim() || "",
    lotNumber: raw.lotNumber?.trim() || String(raw.lotId),
    bidderName: raw.bidderName?.trim() || "",
    contactPhone: raw.contactPhone?.trim() || "",
    auctionType: raw.auctionType?.trim() || null,
    approvedQty,
    totalLiftedQty,
    balanceQty: roundQtyToTwoDecimals(
      Math.max(0, approvedQty - totalLiftedQty),
    ),
    lastLiftedDate: raw.lastLiftedDate?.trim().slice(0, 10) || null,
    dispositionStatus,
    dispositionStatusLabel:
      resolved.label ??
      LIFTING_CLIENT_DISPOSITION_LABELS[
        dispositionStatus as keyof typeof LIFTING_CLIENT_DISPOSITION_LABELS
      ] ??
      String(dispositionStatus),
    remarks: raw.remarks?.trim() || "",
  };
}

const listSelectShape = {
  clientId: auctionLots.clientId,
  lotId: auctionLots.id,
  auctionId: auctionLots.auctionId,
  latestLiftedStatus: auctionLots.latestLiftedStatus,
  auctionDate: auctions.auctionDate,
  auctionNumber: auctions.auctionNumber,
  auctionType: auctions.auctionType,
  lotNumber: auctionLots.lotNumber,
  totalQuantity: auctionLots.quantity,
  clientName: clients.companyName,
  plantName: plantLocations.name,
  bidderName: bidders.companyName,
  contactPhone: bidderContactUser.phoneNumber,
  totalLiftedQty: listTotalLiftedQtySql,
  lastLiftedDate: sql<string | null>`lifting_agg.last_lifted_date`,
  remarks: latestLiftingRemarksSql,
};

function buildListWhereFromScope(
  scope: LiftingClientImportScope,
): SQL | undefined {
  return buildListWhere({
    page: 1,
    pageSize: 1,
    clientIds: scope.clientIds,
    auctionIds: scope.auctionIds,
    dispositionStatus: scope.dispositionStatus,
  });
}

function buildListWhere(params: LiftingClientListParams): SQL | undefined {
  const conditions: SQL[] = [
    excludedClientsCondition,
    liftingEligibleLotCondition,
    recentAuctionCreateDatetimeCondition,
    inArray(auctionLots.clientId, params.clientIds),
  ];

  const auctionCondition = params.allRecentAuctions
    ? undefined
    : buildAuctionIdsCondition(params.auctionIds);
  if (auctionCondition) conditions.push(auctionCondition);

  if (params.dispositionStatus != null) {
    conditions.push(
      eq(auctionLots.latestLiftedStatus, params.dispositionStatus),
    );
  }

  const search = params.search?.trim();
  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      or(
        ilike(auctionLots.lotNumber, pattern),
        ilike(clients.companyName, pattern),
        ilike(plantLocations.name, pattern),
        ilike(bidders.companyName, pattern),
        ilike(auctions.auctionNumber, pattern),
      )!,
    );
  }

  if (conditions.length === 1) return conditions[0];
  return and(...conditions);
}

function buildListOrderBy(params: LiftingClientListParams) {
  const sortBy =
    params.sortBy && LIFTING_CLIENT_SORT_FIELDS.has(params.sortBy)
      ? params.sortBy
      : "auctionDate";
  const descOrder = (params.sortOrder ?? "desc") === "desc";

  const col = (() => {
    switch (sortBy) {
      case "approvedQty":
        return listApprovedQtySql;
      case "totalLiftedQty":
        return listTotalLiftedQtySql;
      case "balanceQty":
        return listBalanceQtySql;
      case "lastLiftedDate":
        return sql`lifting_agg.last_lifted_date`;
      default:
        return auctions.auctionDate;
    }
  })();

  return descOrder ? desc(col) : asc(col);
}

async function syncLatestLiftedFromLiftingTable(
  executor: Pick<typeof db, "execute">,
  lotId: number,
): Promise<void> {
  await executor.execute(syncLatestLiftedForLotSql(lotId));
}

export class LiftingClientsService {
  async listClients(): Promise<LiftingClientFilterClient[]> {
    const rows = await db
      .selectDistinct({
        clientId: clients.id,
        companyName: clients.companyName,
      })
      .from(clients)
      .innerJoin(auctionLots, eq(auctionLots.clientId, clients.id))
      .where(
        and(
          eq(clients.isActive, true),
          notInArray(clients.id, [...LIFTING_EXCLUDED_CLIENT_IDS]),
          liftingEligibleLotCondition,
        ),
      )
      .orderBy(asc(clients.companyName));

    return rows.map((r) => ({
      clientId: r.clientId,
      companyName: r.companyName,
    }));
  }

  async listAuctions(
    clientIds: number[],
  ): Promise<LiftingClientFilterAuction[]> {
    if (clientIds.length === 0) return [];

    const rows = await db
      .selectDistinct({
        clientId: auctions.clientId,
        auctionId: auctions.id,
        auctionNumber: auctions.auctionNumber,
        auctionDate: auctions.auctionDate,
      })
      .from(auctions)
      .innerJoin(
        auctionLots,
        and(
          eq(auctionLots.clientId, auctions.clientId),
          eq(auctionLots.auctionId, auctions.id),
          liftingEligibleLotCondition,
        ),
      )
      .where(
        and(
          eq(auctions.isActive, true),
          inArray(auctions.clientId, clientIds),
          notInArray(auctions.clientId, [...LIFTING_EXCLUDED_CLIENT_IDS]),
          recentAuctionCreateDatetimeCondition,
        ),
      )
      .orderBy(desc(auctions.auctionDate));

    return rows.map((r) => {
      const auctionNumber =
        r.auctionNumber?.trim() || `Auction #${r.auctionId}`;
      return {
        label: auctionNumber,
        auctionNumber,
        clientId: r.clientId,
        auctionId: r.auctionId,
      };
    });
  }

  async list(
    params: LiftingClientListParams,
  ): Promise<Paginated<LiftingClientLotRow>> {
    const hasAuctionScope =
      params.allRecentAuctions || params.auctionIds.length > 0;
    if (params.clientIds.length === 0 || !hasAuctionScope) {
      return {
        items: [],
        total: 0,
        page: Math.max(1, params.page),
        pageSize: Math.max(1, Math.min(100, params.pageSize)),
      };
    }

    const page = Math.max(1, params.page);
    const pageSize = Math.max(1, Math.min(100, params.pageSize));
    const offset = (page - 1) * pageSize;
    const where = buildListWhere(params);

    let itemsQuery = listScopeQuery(listSelectShape);
    let countQuery = listScopeQuery({ count: count() });

    if (where) {
      itemsQuery = itemsQuery.where(where) as typeof itemsQuery;
      countQuery = countQuery.where(where) as typeof countQuery;
    }

    const [rows, [totalRow]] = await Promise.all([
      itemsQuery.orderBy(buildListOrderBy(params)).offset(offset).limit(pageSize),
      countQuery,
    ]);

    return {
      items: await Promise.all((rows as LotRowRaw[]).map(mapLotRow)),
      total: Number(totalRow?.count ?? 0),
      page,
      pageSize,
    };
  }

  async getById(id: string): Promise<LiftingClientLotRow | null> {
    const lotId = parseLotId(id);

    const [row] = await listScopeQuery(listSelectShape).where(
      and(eq(auctionLots.id, lotId), liftingEligibleLotCondition),
    );

    if (!row) return null;
    return mapLotRow(row as LotRowRaw);
  }

  async listAllForImport(
    scope: LiftingClientImportScope,
  ): Promise<LiftingClientLotRow[]> {
    if (scope.clientIds.length === 0 || scope.auctionIds.length === 0) {
      return [];
    }

    const where = buildListWhereFromScope(scope);
    let itemsQuery = listScopeQuery(listSelectShape);
    if (where) {
      itemsQuery = itemsQuery.where(where) as typeof itemsQuery;
    }

    const rows = await itemsQuery.orderBy(desc(auctions.auctionDate));
    return Promise.all((rows as LotRowRaw[]).map(mapLotRow));
  }

  async insertLiftingLog(
    lotId: number,
    input: LiftingClientLogInput,
    createdBy: number,
  ): Promise<LiftingClientLotRow> {
    const id = formatLotId(lotId);

    let disposition: Awaited<ReturnType<typeof assertActiveClientDisposition>>;
    try {
      disposition = await assertActiveClientDisposition(input.dispositionStatus);
    } catch {
      throw new LiftingClientValidationError(
        "dispositionStatus",
        LiftingClientsValidationMessages.DISPOSITION_INVALID,
      );
    }
    const liftingStatus = disposition.id;

    const liftedQty = roundQtyToTwoDecimals(input.liftedQty);
    if (!Number.isFinite(liftedQty) || liftedQty < 0) {
      throw new LiftingClientValidationError(
        "liftedQty",
        LiftingClientsValidationMessages.LIFTED_QTY_CANNOT_BE_NEGATIVE,
      );
    }

    const liftedDate = input.liftedDate.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(liftedDate)) {
      throw new LiftingClientValidationError(
        "liftedDate",
        LiftingClientsValidationMessages.LIFTED_DATE_INVALID,
      );
    }

    const remarks = input.remarks.trim();

    const [lot] = await db
      .select({
        clientId: auctionLots.clientId,
        auctionId: auctionLots.auctionId,
      })
      .from(auctionLots)
      .where(
        and(
          eq(auctionLots.id, lotId),
          liftingEligibleLotCondition,
          excludedClientsCondition,
        ),
      );

    if (!lot) {
      throw new LiftingLotNotFoundError(id);
    }

    const clientId = lot.clientId;

    const [itemRow] = await db
      .select({ itemId: auctionLotItems.itemId })
      .from(auctionLotItems)
      .where(
        and(
          eq(auctionLotItems.clientId, clientId),
          eq(auctionLotItems.auctionId, lot.auctionId),
          eq(auctionLotItems.lotId, lotId),
          eq(auctionLotItems.isActive, true),
        ),
      )
      .orderBy(asc(auctionLotItems.itemId))
      .limit(1);

    if (!itemRow) {
      throw new LiftingClientValidationError(
        "_root",
        LiftingClientsValidationMessages.NO_LOT_ITEMS,
      );
    }

    const now = new Date();
    const createdOn = formatIstWallNow(now).slice(0, 10);

    await db.transaction(async (tx) => {
      await tx.insert(liftingClientLogs).values({
        liftingEntryDate: formatUtcNow(now),
        liftingDate: liftedDate,
        clientId,
        auctionId: lot.auctionId,
        lotId,
        itemId: itemRow.itemId,
        qty: String(liftedQty),
        liftingStatus,
        createdBy,
        createdOn,
        rfdlReasonDescription: remarks || null,
      });

      await syncLatestLiftedFromLiftingTable(tx, lotId);
    });

    const updated = await this.getById(id);
    if (!updated) {
      throw new LiftingLotNotFoundError(id);
    }
    return updated;
  }

  async saveLog(
    id: string,
    input: LiftingClientLogInput,
    createdBy: number,
  ): Promise<LiftingClientLotRow> {
    return this.insertLiftingLog(parseLotId(id), input, createdBy);
  }

  private async mapLogRow(row: {
    id: number;
    liftingEntryDate: string;
    liftingDate: string | null;
    qty: string;
    liftingStatus: number;
    rfdlReasonDescription: string | null;
    createdBy: number;
    createdByUserName: string | null;
  }): Promise<LiftingClientLogRow> {
    const resolved = await resolveClientDispositionByStatus(row.liftingStatus);
    const dispositionStatus = resolved.id;
    return {
      id: String(row.id),
      liftedQty: parseQty(row.qty),
      liftedDate: row.liftingDate?.trim() || "",
      dispositionStatus,
      dispositionStatusLabel:
        resolved.label ??
        LIFTING_CLIENT_DISPOSITION_LABELS[
          dispositionStatus as keyof typeof LIFTING_CLIENT_DISPOSITION_LABELS
        ] ??
        String(dispositionStatus),
      remarks: row.rfdlReasonDescription?.trim() || "",
      loggedAt: toIso(row.liftingEntryDate) ?? formatUtcNow(),
      createdByUserId: String(row.createdBy),
      createdByUserName: row.createdByUserName ?? null,
    };
  }

  private async getLogById(
    lotId: number,
    logId: string,
  ): Promise<LiftingClientLogRow | null> {
    const numericLogId = Number(logId);
    if (!Number.isInteger(numericLogId) || numericLogId <= 0) return null;

    const [row] = await db
      .select({
        id: liftingClientLogs.id,
        liftingEntryDate: liftingClientLogs.liftingEntryDate,
        liftingDate: liftingClientLogs.liftingDate,
        qty: liftingClientLogs.qty,
        liftingStatus: liftingClientLogs.liftingStatus,
        rfdlReasonDescription: liftingClientLogs.rfdlReasonDescription,
        createdBy: liftingClientLogs.createdBy,
        createdByUserName: users.name,
      })
      .from(liftingClientLogs)
      .leftJoin(users, eq(users.id, liftingClientLogs.createdBy))
      .where(
        and(
          eq(liftingClientLogs.id, numericLogId),
          eq(liftingClientLogs.lotId, lotId),
        ),
      )
      .limit(1);

    return row ? this.mapLogRow(row) : null;
  }

  async listLogs(
    id: string,
    opts: LiftingClientLogsListParams = { page: 1, pageSize: 10 },
  ): Promise<Paginated<LiftingClientLogRow>> {
    const lotId = parseLotId(id);

    const lot = await this.getById(id);
    if (!lot) {
      throw new LiftingLotNotFoundError(id);
    }

    const { page, pageSize, offset } = clampPagination(opts.page, opts.pageSize);
    const search = opts.search?.trim();
    const conditions: SQL[] = [eq(liftingClientLogs.lotId, lotId)];

    if (opts.dispositionStatus != null) {
      conditions.push(
        eq(liftingClientLogs.liftingStatus, opts.dispositionStatus),
      );
    }

    if (search) {
      const pattern = `%${search}%`;
      conditions.push(
        or(
          ilike(liftingClientLogs.rfdlReasonDescription, pattern),
          ilike(users.name, pattern),
          ilike(sql`CAST(${liftingClientLogs.qty} AS text)`, pattern),
          ilike(sql`CAST(${liftingClientLogs.liftingDate} AS text)`, pattern),
          ilike(
            sql`CAST(${liftingClientLogs.liftingEntryDate} AS text)`,
            pattern,
          ),
        )!,
      );
    }

    const whereExpr = and(...conditions);
    const descOrder = (opts.sortOrder ?? "desc") === "desc";
    const sortBy = opts.sortBy ?? "liftedDate";
    const primaryCol =
      sortBy === "loggedAt"
        ? liftingClientLogs.liftingEntryDate
        : sortBy === "liftedQty"
          ? liftingClientLogs.qty
          : liftingClientLogs.liftingDate;
    const orderBy = descOrder
      ? [desc(primaryCol), desc(liftingClientLogs.id)]
      : [asc(primaryCol), asc(liftingClientLogs.id)];

    const [rows, [countRow]] = await Promise.all([
      db
        .select({
          id: liftingClientLogs.id,
          liftingEntryDate: liftingClientLogs.liftingEntryDate,
          liftingDate: liftingClientLogs.liftingDate,
          qty: liftingClientLogs.qty,
          liftingStatus: liftingClientLogs.liftingStatus,
          rfdlReasonDescription: liftingClientLogs.rfdlReasonDescription,
          createdBy: liftingClientLogs.createdBy,
          createdByUserName: users.name,
        })
        .from(liftingClientLogs)
        .leftJoin(users, eq(users.id, liftingClientLogs.createdBy))
        .where(whereExpr)
        .orderBy(...orderBy)
        .limit(pageSize)
        .offset(offset),
      db
        .select({ total: count() })
        .from(liftingClientLogs)
        .leftJoin(users, eq(users.id, liftingClientLogs.createdBy))
        .where(whereExpr),
    ]);

    const items = await Promise.all(rows.map((row) => this.mapLogRow(row)));

    return {
      items,
      total: Number(countRow?.total ?? 0),
      page,
      pageSize,
    };
  }

  async updateLog(
    id: string,
    logId: string,
    input: LiftingClientLogInput,
    _updatedBy: number,
  ): Promise<{ lot: LiftingClientLotRow; log: LiftingClientLogRow }> {
    const lotId = parseLotId(id);
    const numericLogId = Number(logId);
    if (!Number.isInteger(numericLogId) || numericLogId <= 0) {
      throw new LiftingClientLogNotFoundError(id, logId);
    }

    let disposition: Awaited<ReturnType<typeof assertActiveClientDisposition>>;
    try {
      disposition = await assertActiveClientDisposition(input.dispositionStatus);
    } catch {
      throw new LiftingClientValidationError(
        "dispositionStatus",
        LiftingClientsValidationMessages.DISPOSITION_INVALID,
      );
    }
    const liftingStatus = disposition.id;

    const liftedQty = roundQtyToTwoDecimals(input.liftedQty);
    if (!Number.isFinite(liftedQty) || liftedQty < 0) {
      throw new LiftingClientValidationError(
        "liftedQty",
        LiftingClientsValidationMessages.LIFTED_QTY_CANNOT_BE_NEGATIVE,
      );
    }

    const liftedDate = input.liftedDate.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(liftedDate)) {
      throw new LiftingClientValidationError(
        "liftedDate",
        LiftingClientsValidationMessages.LIFTED_DATE_INVALID,
      );
    }

    const remarks = input.remarks.trim();

    const [existingLog] = await db
      .select({ id: liftingClientLogs.id })
      .from(liftingClientLogs)
      .where(
        and(
          eq(liftingClientLogs.id, numericLogId),
          eq(liftingClientLogs.lotId, lotId),
        ),
      );

    if (!existingLog) {
      throw new LiftingClientLogNotFoundError(id, logId);
    }

    await db.transaction(async (tx) => {
      await tx
        .update(liftingClientLogs)
        .set({
          liftingDate: liftedDate,
          qty: String(liftedQty),
          liftingStatus,
          rfdlReasonDescription: remarks || null,
        })
        .where(
          and(
            eq(liftingClientLogs.id, numericLogId),
            eq(liftingClientLogs.lotId, lotId),
          ),
        );

      await syncLatestLiftedFromLiftingTable(tx, lotId);
    });

    const updatedLot = await this.getById(id);
    if (!updatedLot) {
      throw new LiftingLotNotFoundError(id);
    }

    const log = await this.getLogById(lotId, logId);
    if (!log) {
      throw new LiftingClientLogNotFoundError(id, logId);
    }

    return { lot: updatedLot, log };
  }
}

export const liftingClientsService = new LiftingClientsService();
