import {
  LiftingBidderErrorMessages,
  LiftingBidderValidationMessages,
} from "@auctionit/messages/lifting-bidders";
import { datetimeLocalToIso, formatUtcNow } from "@auctionit/lib/date";
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
  auctionLots,
  auctions,
  bidders,
  clients,
  liftingBidderDispositions,
  liftingEngagementLogs,
  plantLocations,
  uoms,
  users,
} from "../db/schema/index.js";

const bidderContactUser = alias(users, "bidder_contact_user");
import {
  assertActiveBidderDisposition,
  resolveBidderDispositionById,
} from "./masters/resolve-disposition.js";
import { LIFTING_BIDDER_DISPOSITION } from "../lib/masters/status-keys.js";
import { LIFTING_EXCLUDED_CLIENT_IDS } from "../lib/lifting-scope.js";
import { liftingEligibleLotCondition } from "../lib/lifting-lot-eligibility.js";
import { formatLotId, parseLotId } from "../lib/lifting-lot-id.js";
import {
  computeBalanceQty,
  parseQty,
  parseQtyOrNull,
  roundQtySql,
  roundQtyToTwoDecimals,
} from "../lib/qty.js";

export type LiftingLotRow = {
  id: string;
  auctionDate: string;
  lotConfirmation: string | null;
  liftingDue: string | null;
  auctionName: string;
  clientName: string;
  plantName: string;
  lotNumber: string;
  bidderName: string;
  contactPhone: string;
  auctionType: string | null;
  uom: string;
  approvedQty: number;
  liftedQtyBidder: number;
  liftedQtyClient: number;
  balanceQty: number;
  dispositionStatus: number | null;
  dispositionStatusLabel: string | null;
  nextFollowup: string | null;
  lastModified: string;
  searchKey: string;
};

export type LiftingEngagementDto = {
  id: string;
  dateTime: string;
  dispositionStatus: number;
  dispositionStatusLabel: string;
  notes: string;
  liftedQtyBidder: number | null;
  loggedByUserId: string | null;
  loggedByUserName: string | null;
};

export type LiftingEngagementInput = {
  dispositionStatus: number;
  notes: string;
  nextFollowup?: string;
  liftedQtyBidder?: number;
};

export type LiftingDateFilterField =
  | "auctionDate"
  | "lotConfirmation"
  | "liftingDue"
  | "nextFollowup"
  | "lastModified";

/** Legacy `lifting_client_logs.lifting_status` / disposition id for open lots. */
export const OPEN_LIFTING_STATUS = 1;

const excludedClientsCondition = notInArray(auctionLots.clientId, [
  ...LIFTING_EXCLUDED_CLIENT_IDS,
]);

const openLatestLiftingStatusCondition = eq(
  auctionLots.latestLiftedStatus,
  OPEN_LIFTING_STATUS,
);

export type LiftingListParams = {
  page: number;
  pageSize: number;
  search?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  clientNames?: string[];
  bidderName?: string;
  dispositionStatus?: number;
  dateField?: LiftingDateFilterField;
  dateFrom?: string;
  dateTo?: string;
};

export type Paginated<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export type LiftingListMeta = {
  totalCount: number;
  liftingOngoing: number;
  partialLiftingDone: number;
  liftingCompleted: number;
  todayFollowup: number;
};

export type LiftingFilterOptions = {
  clients: { id: number; name: string }[];
  bidders: { id: number; name: string }[];
};

const LIFTING_SORT_FIELDS = new Set([
  "auctionDate",
  "lotConfirmation",
  "liftingDue",
  "approvedQty",
  "liftedQtyBidder",
  "liftedQtyClient",
  "balanceQty",
  "nextFollowup",
  "lastModified",
]);

export class LiftingNotFoundError extends Error {
  constructor(public readonly lotId: string) {
    super(`Lifting lot not found: ${lotId}`);
    this.name = "LiftingNotFoundError";
  }
}

export class LiftingValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "LiftingValidationError";
  }
}

function buildSearchKey(parts: {
  auctionName: string;
  clientName: string;
  plantName: string;
  lotNumber: string;
  bidderName: string;
  contactPhone: string;
}): string {
  return [
    parts.auctionName,
    parts.clientName,
    parts.plantName,
    parts.lotNumber,
    parts.bidderName,
    parts.contactPhone,
  ]
    .join(" ")
    .toLowerCase();
}

function toIso(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const naive = datetimeLocalToIso(trimmed.replace(" ", "T").slice(0, 19));
    if (naive) return naive;
  }
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : formatUtcNow(d);
}

function addCalendarDays(base: string, days: number | null): string | null {
  if (days == null || days <= 0) return null;
  const d = new Date(base);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return formatUtcNow(d);
}

/** Live SUM of client lifting logs — same source as Clients `totalLiftedQty`. */
const liftingAggSubquery = sql`
  (
    SELECT
      ll.client_id AS client_id,
      ll.lot_id AS lot_id,
      COALESCE(SUM(CAST(ll.qty AS decimal(38, 3))), 0) AS total_lifted_qty
    FROM lifting_client_logs ll
    GROUP BY ll.client_id, ll.lot_id
  ) lifting_agg
`;

const latestEngagementDispositionSql = sql<number | null>`(
  SELECT m.id
  FROM lifting_engagement_logs e
  INNER JOIN lifting_bidder_dispositions m ON m.id = e.disposition_id
  WHERE e.client_id = ${auctionLots.clientId}
    AND e.lot_id = ${auctionLots.id}
  ORDER BY e.created_at DESC
  LIMIT 1
)`;

const latestEngagementDispositionLabelSql = sql<string | null>`(
  SELECT m.label
  FROM lifting_engagement_logs e
  INNER JOIN lifting_bidder_dispositions m ON m.id = e.disposition_id
  WHERE e.client_id = ${auctionLots.clientId}
    AND e.lot_id = ${auctionLots.id}
  ORDER BY e.created_at DESC
  LIMIT 1
)`;

const latestEngagementNextFollowupSql = sql<string | null>`(
  SELECT CASE
    WHEN NOT m.requires_next_followup THEN NULL
    ELSE CAST(e.next_followup AS text)
  END
  FROM lifting_engagement_logs e
  INNER JOIN lifting_bidder_dispositions m ON m.id = e.disposition_id
  WHERE e.client_id = ${auctionLots.clientId}
    AND e.lot_id = ${auctionLots.id}
  ORDER BY e.created_at DESC
  LIMIT 1
)`;

const latestEngagementLiftedQtyBidderSql = sql<string>`COALESCE((
  SELECT CAST(e.lifted_qty_bidder AS text)
  FROM lifting_engagement_logs e
  WHERE e.client_id = ${auctionLots.clientId}
    AND e.lot_id = ${auctionLots.id}
  ORDER BY e.created_at DESC
  LIMIT 1
), '0')`;

const latestEngagementCreatedAtSql = sql<string | null>`(
  SELECT CAST(e.created_at AS text)
  FROM lifting_engagement_logs e
  WHERE e.client_id = ${auctionLots.clientId}
    AND e.lot_id = ${auctionLots.id}
  ORDER BY e.created_at DESC
  LIMIT 1
)`;

const listDispositionStatusSql = latestEngagementDispositionSql;

const listLastModifiedSql = sql<string>`COALESCE(
  (${latestEngagementCreatedAtSql})::timestamptz,
  ${auctionLots.updatedAt}::timestamptz,
  ${auctions.auctionDate}::timestamptz
)`;

const listApprovedQtySql = roundQtySql(
  sql`COALESCE(CAST(${auctionLots.quantity} AS decimal(38, 3)), 0)`,
);

const listLiftedQtyBidderSql = roundQtySql(
  sql`COALESCE(CAST((${latestEngagementLiftedQtyBidderSql}) AS decimal(38, 3)), 0)`,
);

const listLiftedQtyClientSql = roundQtySql(
  sql`COALESCE(CAST(lifting_agg.total_lifted_qty AS decimal(38, 3)), 0)`,
);

const listBalanceQtySql = roundQtySql(sql`(CASE WHEN (0) >= ((${listApprovedQtySql})
    - (CASE WHEN ((${listLiftedQtyBidderSql})) >= ((${listLiftedQtyClientSql})) THEN ((${listLiftedQtyBidderSql})) ELSE ((${listLiftedQtyClientSql})) END)) THEN (0) ELSE ((${listApprovedQtySql})
    - (CASE WHEN ((${listLiftedQtyBidderSql})) >= ((${listLiftedQtyClientSql})) THEN ((${listLiftedQtyBidderSql})) ELSE ((${listLiftedQtyClientSql})) END)) END)`);

/** reviewed_at only when lot is approved; rejects must not drive lifting due. */
const lotReviewedAtWhenApprovedSql = sql`CASE WHEN ${auctionLots.isApproved} IS TRUE THEN ${auctionLots.reviewedAt} END`;

const liftingDueBaseSql = sql`COALESCE(${lotReviewedAtWhenApprovedSql}, ${auctions.auctionDate})`;

const liftingDueDateSql = sql`(
  ${liftingDueBaseSql} + make_interval(days => COALESCE(${auctionLots.materialLiftingDays}, 0))
)`;

const lotConfirmationSql = sql<
  string | null
>`CAST(${lotReviewedAtWhenApprovedSql} AS text)`;

type LotRowRaw = {
  clientId: number;
  lotId: number;
  dispositionStatus: number | null;
  dispositionStatusLabel: string | null;
  nextFollowup: string | null;
  liftedQtyBidder: string;
  lastModified: string;
  auctionDate: string;
  auctionNumber: string | null;
  materialLiftingDays: number | null;
  lotNumber: string | null;
  uom: string | null;
  totalQuantity: string | null;
  lotUpdateDatetime: string | null;
  clientName: string;
  plantName: string | null;
  bidderName: string | null;
  contactPhone: string | null;
  auctionType: string | null;
  lotConfirmation: string | null;
  liftedQtyClient: string | null;
};

function mapLotRow(raw: LotRowRaw): LiftingLotRow {
  const approvedQty = parseQty(raw.totalQuantity);
  const liftedQtyBidder = parseQty(raw.liftedQtyBidder);
  const liftedQtyClient = parseQty(raw.liftedQtyClient);
  const auctionName = raw.auctionNumber?.trim() || `Auction ${raw.clientId}`;
  const clientName = raw.clientName;
  const plantName = raw.plantName?.trim() || "";
  const lotNumber = raw.lotNumber?.trim() || String(raw.lotId);
  const bidderName = raw.bidderName?.trim() || "";
  const contactPhone = raw.contactPhone?.trim() || "";

  const dispositionStatus =
    raw.dispositionStatus == null ? null : Number(raw.dispositionStatus);
  const dispositionStatusLabel =
    raw.dispositionStatusLabel?.trim() ||
    (dispositionStatus != null ? String(dispositionStatus) : null);

  const auctionDateIso = toIso(raw.auctionDate) ?? formatUtcNow();
  const lotConfirmation = toIso(raw.lotConfirmation) ?? auctionDateIso;
  const liftingDueBase = lotConfirmation ?? auctionDateIso;
  const liftingDue = addCalendarDays(liftingDueBase, raw.materialLiftingDays);

  const lastModified =
    toIso(raw.lastModified) ?? toIso(raw.lotUpdateDatetime) ?? auctionDateIso;

  return {
    id: formatLotId(raw.lotId),
    auctionDate: auctionDateIso,
    lotConfirmation,
    liftingDue,
    auctionName,
    clientName,
    plantName,
    lotNumber,
    bidderName,
    contactPhone,
    auctionType: raw.auctionType?.trim() || null,
    uom: raw.uom?.trim() || "",
    approvedQty,
    liftedQtyBidder,
    liftedQtyClient,
    balanceQty: computeBalanceQty(
      approvedQty,
      liftedQtyBidder,
      liftedQtyClient,
    ),
    dispositionStatus,
    dispositionStatusLabel,
    nextFollowup: toIso(raw.nextFollowup),
    lastModified,
    searchKey: buildSearchKey({
      auctionName,
      clientName,
      plantName,
      lotNumber,
      bidderName,
      contactPhone,
    }),
  };
}

const listScopeLotSelectShape = {
  clientId: auctionLots.clientId,
  lotId: auctionLots.id,
  dispositionStatus: listDispositionStatusSql,
  dispositionStatusLabel: latestEngagementDispositionLabelSql,
  nextFollowup: latestEngagementNextFollowupSql,
  liftedQtyBidder: listLiftedQtyBidderSql,
  lastModified: listLastModifiedSql,
  auctionDate: auctions.auctionDate,
  auctionNumber: auctions.auctionNumber,
  auctionType: auctions.auctionType,
  materialLiftingDays: auctionLots.materialLiftingDays,
  lotNumber: auctionLots.lotNumber,
  uom: uoms.code,
  totalQuantity: auctionLots.quantity,
  lotUpdateDatetime: auctionLots.updatedAt,
  clientName: clients.companyName,
  plantName: plantLocations.name,
  bidderName: bidders.companyName,
  contactPhone: bidderContactUser.phoneNumber,
  lotConfirmation: lotConfirmationSql,
  liftedQtyClient: listLiftedQtyClientSql,
};

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
    )
    .leftJoin(uoms, eq(uoms.id, auctionLots.uomId));
}

/** List/stats: open auction lots; CRM fields from latest engagement log row. */
function listScopeJoins() {
  return listScopeQuery(listScopeLotSelectShape);
}

function dateColumnForFilter(field: LiftingDateFilterField): SQL {
  switch (field) {
    case "auctionDate":
      return sql`CAST(${auctions.auctionDate} AS date)`;
    case "lotConfirmation":
      return sql`CAST(COALESCE(${lotReviewedAtWhenApprovedSql}, ${auctions.auctionDate}) AS date)`;
    case "liftingDue":
      return sql`CAST(${liftingDueDateSql} AS date)`;
    case "nextFollowup":
      return sql`CAST(${latestEngagementNextFollowupSql} AS date)`;
    case "lastModified":
      return sql`CAST(${listLastModifiedSql} AS date)`;
    default:
      return sql`CAST(${auctions.auctionDate} AS date)`;
  }
}

function buildListWhere(
  params: LiftingListParams,
  options: { openOnly?: boolean } = {},
): SQL | undefined {
  const conditions: SQL[] = [];

  if (options.openOnly !== false) {
    conditions.push(excludedClientsCondition);
    conditions.push(liftingEligibleLotCondition);
    conditions.push(openLatestLiftingStatusCondition);
  }

  if (params.search) {
    const term = `%${params.search}%`;
    const searchClause = or(
      ilike(auctions.auctionNumber, term),
      ilike(clients.companyName, term),
      ilike(plantLocations.name, term),
      ilike(auctionLots.lotNumber, term),
      ilike(bidders.companyName, term),
      ilike(bidderContactUser.phoneNumber, term),
      sql`CAST(${auctionLots.id} AS text) ILIKE ${term}`,
      sql`CAST(${auctionLots.clientId} AS text) ILIKE ${term}`,
    );
    if (searchClause) conditions.push(searchClause);
  }

  if (params.clientNames && params.clientNames.length > 0) {
    conditions.push(inArray(clients.companyName, params.clientNames));
  }

  if (params.bidderName) {
    conditions.push(eq(bidders.companyName, params.bidderName));
  }

  if (params.dispositionStatus != null) {
    conditions.push(
      sql`(${listDispositionStatusSql}) = ${params.dispositionStatus}`,
    );
  }

  if (params.dateField && params.dateFrom) {
    const col = dateColumnForFilter(params.dateField);
    if (params.dateTo) {
      conditions.push(
        sql`${col} >= CAST(${params.dateFrom} AS date) AND ${col} <= CAST(${params.dateTo} AS date)`,
      );
    } else {
      conditions.push(sql`${col} >= CAST(${params.dateFrom} AS date)`);
    }
  }

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return and(...conditions);
}

function buildListOrderBy(params: LiftingListParams) {
  const sortBy =
    params.sortBy && LIFTING_SORT_FIELDS.has(params.sortBy)
      ? params.sortBy
      : "auctionDate";
  const descOrder = (params.sortOrder ?? "desc") === "desc";

  const col = (() => {
    switch (sortBy) {
      case "auctionDate":
        return auctions.auctionDate;
      case "lotConfirmation":
        return sql`COALESCE(${lotReviewedAtWhenApprovedSql}, ${auctions.auctionDate})`;
      case "liftingDue":
        return liftingDueDateSql;
      case "approvedQty":
        return listApprovedQtySql;
      case "liftedQtyBidder":
        return listLiftedQtyBidderSql;
      case "liftedQtyClient":
        return listLiftedQtyClientSql;
      case "balanceQty":
        return listBalanceQtySql;
      case "nextFollowup":
        return latestEngagementNextFollowupSql;
      case "lastModified":
        return listLastModifiedSql;
      default:
        return auctions.auctionDate;
    }
  })();

  return descOrder ? desc(col) : asc(col);
}

async function validateEngagementInput(
  input: LiftingEngagementInput,
): Promise<{
  id: number;
  requiresLiftedQty: boolean;
  requiresNextFollowup: boolean;
}> {
  const V = LiftingBidderValidationMessages;
  let disposition: Awaited<ReturnType<typeof assertActiveBidderDisposition>>;
  try {
    disposition = await assertActiveBidderDisposition(input.dispositionStatus);
  } catch {
    throw new LiftingValidationError(
      "dispositionStatus",
      V.DISPOSITION_INVALID,
    );
  }

  if (disposition.requiresNextFollowup) {
    if (!input.nextFollowup?.trim()) {
      throw new LiftingValidationError(
        "nextFollowup",
        V.NEXT_FOLLOWUP_REQUIRED,
      );
    }
    const followUp = new Date(input.nextFollowup);
    if (Number.isNaN(followUp.getTime())) {
      throw new LiftingValidationError(
        "nextFollowup",
        V.NEXT_FOLLOWUP_INVALID,
      );
    }
    if (followUp.getTime() < Date.now()) {
      throw new LiftingValidationError(
        "nextFollowup",
        V.NEXT_FOLLOWUP_BEFORE_NOW,
      );
    }
  }

  if (disposition.requiresLiftedQty) {
    const qty =
      input.liftedQtyBidder === undefined
        ? undefined
        : roundQtyToTwoDecimals(input.liftedQtyBidder);
    if (qty === undefined || Number.isNaN(qty)) {
      throw new LiftingValidationError(
        "liftedQtyBidder",
        V.LIFTED_QTY_BIDDER_REQUIRED,
      );
    }
    if (qty < 0) {
      throw new LiftingValidationError(
        "liftedQtyBidder",
        V.LIFTED_QTY_NONNEGATIVE,
      );
    }
  }

  return {
    id: disposition.id,
    requiresLiftedQty: disposition.requiresLiftedQty,
    requiresNextFollowup: disposition.requiresNextFollowup,
  };
}

async function auctionLotExists(lotId: number): Promise<boolean> {
  const [row] = await db
    .select({ lotId: auctionLots.id })
    .from(auctionLots)
    .where(
      and(
        eq(auctionLots.id, lotId),
        liftingEligibleLotCondition,
        openLatestLiftingStatusCondition,
        excludedClientsCondition,
      ),
    );
  return Boolean(row);
}

export class LiftingService {
  async list(params: LiftingListParams): Promise<Paginated<LiftingLotRow>> {
    const page = Math.max(1, params.page);
    const pageSize = Math.max(1, Math.min(100, params.pageSize));
    const offset = (page - 1) * pageSize;
    const where = buildListWhere(params, { openOnly: true });

    let itemsQuery = listScopeJoins();
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
      items: (rows as LotRowRaw[]).map(mapLotRow),
      total: Number(totalRow?.count ?? 0),
      page,
      pageSize,
    };
  }

  async stats(todayDate?: string): Promise<LiftingListMeta> {
    const where = buildListWhere({ page: 1, pageSize: 1 }, { openOnly: true });

    let inner = listScopeQuery({
      dispositionStatus: listDispositionStatusSql.as("dispositionStatus"),
      nextFollowup: latestEngagementNextFollowupSql.as("nextFollowup"),
    });
    if (where) {
      inner = inner.where(where) as typeof inner;
    }
    const innerAs = inner.as("lifting_stats_inner");

    const todayFollowupSql =
      todayDate != null
        ? sql<number>`SUM(CASE WHEN ${innerAs.nextFollowup} IS NOT NULL AND CAST(${innerAs.nextFollowup} AS date) = CAST(${todayDate} AS date) THEN 1 ELSE 0 END)`
        : sql<number>`SUM(CASE WHEN ${innerAs.nextFollowup} IS NOT NULL AND CAST(${innerAs.nextFollowup} AS date) = CAST(now() AS date) THEN 1 ELSE 0 END)`;

    const [row] = await db
      .select({
        total: count(),
        liftingOngoing: sql<number>`SUM(CASE WHEN ${innerAs.dispositionStatus} = ${LIFTING_BIDDER_DISPOSITION.LIFTING_ONGOING} THEN 1 ELSE 0 END)`,
        partialLiftingDone: sql<number>`SUM(CASE WHEN ${innerAs.dispositionStatus} = ${LIFTING_BIDDER_DISPOSITION.PARTIAL_LIFTING_DONE} THEN 1 ELSE 0 END)`,
        liftingCompleted: sql<number>`SUM(CASE WHEN ${innerAs.dispositionStatus} = ${LIFTING_BIDDER_DISPOSITION.LIFTING_COMPLETED} THEN 1 ELSE 0 END)`,
        todayFollowup: todayFollowupSql,
      })
      .from(innerAs);
    return {
      totalCount: Number(row?.total ?? 0),
      liftingOngoing: Number(row?.liftingOngoing ?? 0),
      partialLiftingDone: Number(row?.partialLiftingDone ?? 0),
      liftingCompleted: Number(row?.liftingCompleted ?? 0),
      todayFollowup: Number(row?.todayFollowup ?? 0),
    };
  }

  async filterOptions(): Promise<LiftingFilterOptions> {
    const openWhere = buildListWhere(
      { page: 1, pageSize: 1 },
      { openOnly: true },
    );
    const activeEntities = and(
      eq(clients.isActive, true),
      or(eq(bidders.isActive, true), sql`${bidders.id} IS NULL`),
    );
    const filterWhere = openWhere
      ? and(openWhere, activeEntities)
      : activeEntities;

    const baseClients = listScopeQuery({
      id: clients.id,
      name: clients.companyName,
    }).groupBy(clients.id, clients.companyName);

    const baseBidders = listScopeQuery({
      id: bidders.id,
      name: bidders.companyName,
    }).groupBy(bidders.id, bidders.companyName);

    const [clientRows, bidderRows] = await Promise.all([
      baseClients.where(filterWhere),
      baseBidders.where(filterWhere),
    ]);

    return {
      clients: clientRows
        .filter(
          (r): r is { id: number; name: string } =>
            r.id != null && Boolean(r.name),
        )
        .map((r) => ({ id: r.id, name: r.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      bidders: bidderRows
        .filter(
          (r): r is { id: number; name: string } =>
            r.id != null && Boolean(r.name),
        )
        .map((r) => ({ id: r.id, name: r.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async getById(id: string): Promise<LiftingLotRow | null> {
    const lotId = parseLotId(id);

    const [row] = await listScopeJoins().where(
      and(
        eq(auctionLots.id, lotId),
        liftingEligibleLotCondition,
        openLatestLiftingStatusCondition,
        excludedClientsCondition,
      ),
    );

    if (!row) return null;
    return mapLotRow(row as LotRowRaw);
  }

  async listEngagements(id: string): Promise<LiftingEngagementDto[]> {
    const lotId = parseLotId(id);

    if (!(await auctionLotExists(lotId))) {
      throw new LiftingNotFoundError(id);
    }

    const rows = await db
      .select({
        id: liftingEngagementLogs.id,
        createdAt: liftingEngagementLogs.createdAt,
        dispositionId: liftingEngagementLogs.dispositionId,
        dispositionLabel: liftingBidderDispositions.label,
        notes: liftingEngagementLogs.notes,
        liftedQtyBidder: liftingEngagementLogs.liftedQtyBidder,
        loggedByUserId: liftingEngagementLogs.loggedByUserId,
        loggedByUserName: users.name,
      })
      .from(liftingEngagementLogs)
      .innerJoin(
        liftingBidderDispositions,
        eq(
          liftingBidderDispositions.id,
          liftingEngagementLogs.dispositionId,
        ),
      )
      .leftJoin(users, eq(users.id, liftingEngagementLogs.loggedByUserId))
      .where(eq(liftingEngagementLogs.lotId, lotId))
      .orderBy(desc(liftingEngagementLogs.createdAt));

    return Promise.all(
      rows.map(async (row) => {
        const resolved = await resolveBidderDispositionById(row.dispositionId);
        return {
          id: String(row.id),
          dateTime: toIso(row.createdAt) ?? formatUtcNow(),
          dispositionStatus: resolved.id,
          dispositionStatusLabel:
            row.dispositionLabel ?? resolved.label ?? String(resolved.id),
          notes: row.notes,
          liftedQtyBidder: parseQtyOrNull(row.liftedQtyBidder),
          loggedByUserId: String(row.loggedByUserId),
          loggedByUserName: row.loggedByUserName ?? null,
        };
      }),
    );
  }

  async logEngagement(
    id: string,
    input: LiftingEngagementInput,
    loggedByUserId: number,
  ): Promise<{ lot: LiftingLotRow; engagement: LiftingEngagementDto }> {
    const lotId = parseLotId(id);

    const existing = await this.getById(id);
    if (!existing) throw new LiftingNotFoundError(id);

    const [lotMeta] = await db
      .select({ clientId: auctionLots.clientId })
      .from(auctionLots)
      .where(eq(auctionLots.id, lotId));

    if (!lotMeta) throw new LiftingNotFoundError(id);

    const { id: dispositionId, requiresLiftedQty, requiresNextFollowup } =
      await validateEngagementInput(input);

    const now = formatUtcNow();
    const nextFollowup = requiresNextFollowup
      ? datetimeLocalToIso(input.nextFollowup!) ??
        formatUtcNow(new Date(input.nextFollowup!))
      : now;
    const liftedQtyBidder = roundQtyToTwoDecimals(
      input.liftedQtyBidder ?? existing.liftedQtyBidder,
    );
    const liftedQtyBidderStr = String(liftedQtyBidder);

    const [engagementRow] = await db
      .insert(liftingEngagementLogs)
      .values({
        clientId: lotMeta.clientId,
        lotId,
        dispositionId,
        notes: input.notes.trim(),
        nextFollowup,
        liftedQtyBidder: requiresLiftedQty ? liftedQtyBidderStr : null,
        loggedByUserId,
        createdAt: now,
      })
      .returning({
        id: liftingEngagementLogs.id,
        createdAt: liftingEngagementLogs.createdAt,
        dispositionId: liftingEngagementLogs.dispositionId,
        notes: liftingEngagementLogs.notes,
        liftedQtyBidder: liftingEngagementLogs.liftedQtyBidder,
        loggedByUserId: liftingEngagementLogs.loggedByUserId,
      });

    if (!engagementRow) {
      throw new Error(LiftingBidderErrorMessages.INSERT_FAILED);
    }

    const [user] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, loggedByUserId));

    const lot = (await this.getById(id))!;
    const resolved = await resolveBidderDispositionById(
      engagementRow.dispositionId,
    );

    const engagement: LiftingEngagementDto = {
      id: String(engagementRow.id),
      dateTime: toIso(engagementRow.createdAt) ?? now,
      dispositionStatus: resolved.id,
      dispositionStatusLabel: resolved.label ?? String(resolved.id),
      notes: engagementRow.notes,
      liftedQtyBidder: parseQtyOrNull(engagementRow.liftedQtyBidder),
      loggedByUserId: String(engagementRow.loggedByUserId),
      loggedByUserName: user?.name ?? null,
    };

    return { lot, engagement };
  }
}

export const liftingService = new LiftingService();
