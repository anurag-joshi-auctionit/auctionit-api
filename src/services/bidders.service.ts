import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  max,
  ne,
  notInArray,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import {
  MAX_SELECT_ALL_IDS,
  mergeOptionsById,
  resolveOptionsLimit,
  toOptionIdsResult,
  type EntityOptionIdsResult,
} from "../lib/options-query.js";
import { currentlyBlockedBidderIdsForClient } from "../lib/bidders/blocked-for-client.js";
import { BiddersErrorMessages } from "@auctionit/messages/bidders";
import type {
  BidderBlocksListParams,
  BidderExemptionsListParams,
  BidderInfoInput,
  BlockedBiddersListParams,
  BiddersListParams,
  CreateBidderInput,
  ExemptedBiddersListParams,
} from "../lib/bidders/schemas.js";
import { db } from "../db/index.js";
import { bidders } from "../db/schema/bidders.js";
import { users } from "../db/schema/users.js";
import { bidderBlockLogs } from "../db/schema/bidder-blocks.js";
import { bidderExemptionLogs } from "../db/schema/bidder-exemptions.js";
import { auctionLotBidderMaps } from "../db/schema/auction-lot-bidder-maps.js";
import { auctions } from "../db/schema/auctions.js";
import { clients } from "../db/schema/clients.js";
import { locations } from "../db/schema/locations.js";
import { subscriptions } from "../db/schema/subscriptions.js";
import { clampPagination } from "./list-query.js";
import { locationsService } from "./locations.service.js";
import { bidderUsersService } from "./users.service.js";
import { buildBidderVan } from "../lib/bidders/van.js";
import { formatUtcNow, last30IstDateRange } from "@auctionit/lib/date";
import {
  detachBidderFromUnstartedLots,
  type DetachUnstartedResult,
} from "./bidder-unstarted-detach.js";

export type {
  BiddersListParams,
  BidderStatusFilter,
} from "../lib/bidders/schemas.js";

export type BidderListItem = {
  bidderId: number;
  companyName: string;
  pan: string | null;
  gstin: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  locationId: number | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  materials: number[];
  emd: number | null;
  van: string | null;
  isActive: boolean;
  isVerified: boolean;
  isSubscribed: boolean;
  createdAt: string;
  auctionCount: number;
  lastAuctionDate: string | null;
};

export type BidderListCounts = {
  total: number;
  active: number;
  inactive: number;
  newLast30d: number;
  unverified: number;
};

export type BidderListResult = {
  items: BidderListItem[];
  total: number;
  page: number;
  pageSize: number;
  counts: BidderListCounts;
};

export type BidderBlockListItem = {
  id: number;
  clientId: number;
  clientName: string | null;
  isBlocked: boolean;
  reason: string | null;
  createdAt: string;
  blockedByName: string | null;
};

export type BidderBlocksListResult = {
  items: BidderBlockListItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type BlockedBidderItem = {
  logId: number;
  bidderId: number;
  companyName: string;
  clientId: number;
  clientName: string | null;
  reason: string | null;
  blockedAt: string;
  blockedByName: string | null;
};

export type BlockedBidderSortField = "companyName" | "blockedAt";

export type BlockedBiddersListResult = {
  items: BlockedBidderItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type ExemptedBidderItem = {
  logId: number;
  bidderId: number;
  companyName: string;
  clientId: number;
  clientName: string | null;
  reason: string | null;
  exemptedAt: string;
  exemptedByName: string | null;
};

export type BidderExemptionListItem = {
  id: number;
  clientId: number;
  clientName: string | null;
  isExempted: boolean;
  reason: string | null;
  createdAt: string;
  exemptedByName: string | null;
};

export type BidderExemptionsListResult = {
  items: BidderExemptionListItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type ExemptedBidderSortField = "companyName" | "exemptedAt";

export type ExemptedBiddersListResult = {
  items: ExemptedBidderItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type BidderDetail = {
  bidderId: number;
  companyName: string;
  isActive: boolean;
  isVerified: boolean;
  createdAt: string;
  /** Linked login user email (1:1 via users.bidder_id). */
  contactEmail: string | null;
  contactPhone: string | null;
  profile: {
    address: string | null;
    locationId: number | null;
    country: string | null;
    state: string | null;
    city: string | null;
    pincode: string | null;
    website: string | null;
    pan: string | null;
    gstin: string | null;
    materials: number[];
    emd: number | null;
    van: string | null;
    validFrom: string | null;
    validTo: string | null;
  };
  blocks: Array<{
    id: number;
    clientId: number;
    clientName: string | null;
    isBlocked: boolean;
    reason: string | null;
    createdAt: string;
    blockedByName: string | null;
  }>;
  mappings: Array<{
    id: number;
    clientId: number;
    clientName: string | null;
    bidderCode: string | null;
    allMaterialLocation: boolean;
    isActive: boolean | null;
    isBlocked: boolean;
    isRefunded: boolean | null;
    createDatetime: string;
  }>;
};

export class BidderNotFoundError extends Error {
  constructor() {
    super(BiddersErrorMessages.BIDDER_NOT_FOUND);
    this.name = "BidderNotFoundError";
  }
}

export class BidderLocationNotFoundError extends Error {
  constructor() {
    super(BiddersErrorMessages.LOCATION_NOT_FOUND);
    this.name = "BidderLocationNotFoundError";
  }
}

export class ClientNotFoundError extends Error {
  constructor() {
    super(BiddersErrorMessages.CLIENT_NOT_FOUND);
    this.name = "ClientNotFoundError";
  }
}

export class BidderAlreadyBlockedError extends Error {
  constructor() {
    super(BiddersErrorMessages.ALREADY_BLOCKED_FOR_CLIENT);
    this.name = "BidderAlreadyBlockedError";
  }
}

export class BidderNotBlockedForClientError extends Error {
  constructor() {
    super(BiddersErrorMessages.NOT_BLOCKED_FOR_CLIENT);
    this.name = "BidderNotBlockedForClientError";
  }
}

export class BidderAlreadyExemptedError extends Error {
  constructor() {
    super(BiddersErrorMessages.ALREADY_EXEMPTED);
    this.name = "BidderAlreadyExemptedError";
  }
}

export class BidderNotExemptedError extends Error {
  constructor() {
    super(BiddersErrorMessages.NOT_EXEMPTED);
    this.name = "BidderNotExemptedError";
  }
}

function parseEmd(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toProfile(
  row: typeof bidders.$inferSelect,
  loc: typeof locations.$inferSelect | null,
): BidderDetail["profile"] {
  return {
    address: row.address ?? null,
    locationId: row.locationId ?? null,
    country: loc?.country ?? row.country ?? null,
    state: loc?.state ?? row.state ?? null,
    city: loc?.city ?? row.city ?? null,
    pincode: row.pincode ?? null,
    website: row.website ?? null,
    pan: row.pan ?? null,
    gstin: row.gstin ?? null,
    materials: row.materials ?? [],
    emd: parseEmd(row.emdAvailableBalance),
    van: row.van ?? null,
    validFrom: row.validFrom ?? null,
    validTo: row.validTo ?? null,
  };
}

async function nextBidderId(): Promise<number> {
  const [row] = await db.select({ value: max(bidders.id) }).from(bidders);
  return (row?.value ?? 0) + 1;
}

async function nextBlockLogId(): Promise<number> {
  const [row] = await db
    .select({ value: max(bidderBlockLogs.id) })
    .from(bidderBlockLogs);
  return (row?.value ?? 0) + 1;
}

async function nextExemptionLogId(): Promise<number> {
  const [row] = await db
    .select({ value: max(bidderExemptionLogs.id) })
    .from(bidderExemptionLogs);
  return (row?.value ?? 0) + 1;
}

async function resolveLocationFields(locationId: number): Promise<{
  locationId: number | null;
  country: string | null;
  state: string | null;
  city: string | null;
}> {
  const loc = await locationsService.getById(locationId);
  if (!loc) {
    throw new BidderLocationNotFoundError();
  }
  return {
    locationId,
    country: loc.country ?? null,
    state: loc.state ?? null,
    city: loc.city ?? null,
  };
}

function activeInactiveStatus(
  isActiveColumn: AnyColumn,
  status: "all" | "active" | "inactive" | undefined,
): SQL | undefined {
  if (status === "active") return eq(isActiveColumn, true);
  if (status === "inactive") return eq(isActiveColumn, false);
  return undefined;
}

function createdAtDateRange(
  createdAtColumn: AnyColumn,
  opts: {
    dateField?: BiddersListParams["dateField"];
    dateFrom?: string;
    dateTo?: string;
  },
): SQL | undefined {
  if (opts.dateField !== "createdAt" || !opts.dateFrom) return undefined;
  if (opts.dateTo) {
    return sql`${createdAtColumn}::date >= CAST(${opts.dateFrom} AS date) AND ${createdAtColumn}::date <= CAST(${opts.dateTo} AS date)`;
  }
  return sql`${createdAtColumn}::date >= CAST(${opts.dateFrom} AS date)`;
}

/**
 * MAX(active-map auction_date)::date is in range. No maps never match.
 * dateFrom alone means max date >= from.
 */
function lastAuctionDateRange(opts: {
  dateField?: BiddersListParams["dateField"];
  dateFrom?: string;
  dateTo?: string;
}): SQL | undefined {
  if (opts.dateField !== "lastAuctionDate" || !opts.dateFrom) return undefined;
  const onOrAfterFrom = sql`exists (
    select 1
    from ${auctionLotBidderMaps} m
    inner join ${auctions} a on a.auction_id = m.auction_id
    where m.bidder_id = ${bidders.id}
      and m.is_active = true
      and a.auction_date::date >= cast(${opts.dateFrom} as date)
  )`;
  if (!opts.dateTo) return onOrAfterFrom;
  return sql`${onOrAfterFrom} and not exists (
    select 1
    from ${auctionLotBidderMaps} m
    inner join ${auctions} a on a.auction_id = m.auction_id
    where m.bidder_id = ${bidders.id}
      and m.is_active = true
      and a.auction_date::date > cast(${opts.dateTo} as date)
  )`;
}

function auctionCountOrderExpr(): SQL {
  return sql`(
    select count(distinct m.auction_id)::int
    from ${auctionLotBidderMaps} m
    where m.bidder_id = ${bidders.id}
      and m.is_active = true
  )`;
}

function lastAuctionDateOrderExpr(): SQL {
  return sql`(
    select max(a.auction_date)
    from ${auctionLotBidderMaps} m
    inner join ${auctions} a on a.auction_id = m.auction_id
    where m.bidder_id = ${bidders.id}
      and m.is_active = true
  )`;
}

function toIsoTimestamp(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function combineConditions(conditions: (SQL | undefined)[]): SQL | undefined {
  const defined = conditions.filter((c): c is SQL => c != null);
  return defined.length ? and(...defined) : undefined;
}

function buildSortOrder<T extends string>(
  sortBy: T | undefined,
  sortOrder: "asc" | "desc" | undefined,
  allowed: ReadonlySet<T>,
  defaultField: T,
  columns: Record<T, readonly AnyColumn[]>,
): ReturnType<typeof asc>[] {
  const field = sortBy && allowed.has(sortBy) ? sortBy : defaultField;
  const dir = sortOrder === "desc" ? desc : asc;
  const cols = columns[field];
  return cols.map((col, i) => (i === 0 ? dir(col) : asc(col)));
}

const BIDDER_SORT_FIELDS = new Set([
  "companyName",
  "emd",
  "isActive",
  "createdAt",
] as const);

const hasCoveringSubscriptionSql = sql<boolean>`exists (
  select 1 from ${subscriptions} s
  where s.bidder_id = ${bidders.id}
    and s.invoice_status <> 'cancelled'
    and s.from_date is not null
    and s.to_date is not null
    and s.from_date <= (now() at time zone 'Asia/Kolkata')::date
    and s.to_date >= (now() at time zone 'Asia/Kolkata')::date
)`;

const noCoveringSubscriptionSql = sql`not exists (
  select 1 from ${subscriptions} s
  where s.bidder_id = ${bidders.id}
    and s.invoice_status <> 'cancelled'
    and s.from_date is not null
    and s.to_date is not null
    and s.from_date <= (now() at time zone 'Asia/Kolkata')::date
    and s.to_date >= (now() at time zone 'Asia/Kolkata')::date
)`;

function buildBidderListWhere(
  opts: Pick<
    BiddersListParams,
    "search" | "status" | "dateField" | "dateFrom" | "dateTo"
  >,
) {
  const search = opts.search?.trim();
  const status = opts.status ?? "all";

  const conditions = [
    ne(bidders.id, 0),
    activeInactiveStatus(
      bidders.isActive,
      status === "active" || status === "inactive" ? status : "all",
    ),
    status === "verified" ? eq(bidders.isVerified, true) : undefined,
    status === "unverified" ? eq(bidders.isVerified, false) : undefined,
    status === "subscribed" ? hasCoveringSubscriptionSql : undefined,
    status === "unsubscribed" ? noCoveringSubscriptionSql : undefined,
    createdAtDateRange(bidders.createdAt, opts),
    lastAuctionDateRange(opts),
  ];

  if (search) {
    const term = `%${search}%`;
    conditions.push(
      or(
        ilike(sql`cast(${bidders.id} as text)`, term),
        ilike(bidders.companyName, term),
        ilike(bidders.van, term),
        ilike(bidders.gstin, term),
        ilike(bidders.state, term),
        ilike(locations.state, term),
      )!,
    );
  }

  return combineConditions(conditions);
}

function buildBidderListOrderBy(
  sortBy?: BiddersListParams["sortBy"],
  sortOrder?: BiddersListParams["sortOrder"],
): SQL[] {
  const descOrder = sortOrder === "desc";
  if (sortBy === "auctionCount") {
    const expr = auctionCountOrderExpr();
    return [
      descOrder ? sql`${expr} desc` : sql`${expr} asc`,
      asc(bidders.companyName),
    ];
  }
  if (sortBy === "lastAuctionDate") {
    const expr = lastAuctionDateOrderExpr();
    return [
      descOrder ? sql`${expr} desc nulls last` : sql`${expr} asc nulls last`,
      asc(bidders.companyName),
    ];
  }
  return buildSortOrder(sortBy, sortOrder, BIDDER_SORT_FIELDS, "companyName", {
    companyName: [bidders.companyName],
    emd: [bidders.emdAvailableBalance, bidders.companyName],
    isActive: [bidders.isActive, bidders.companyName],
    createdAt: [bidders.createdAt, bidders.companyName],
  });
}

const bidderListSelect = {
  bidderId: bidders.id,
  companyName: bidders.companyName,
  pan: bidders.pan,
  gstin: bidders.gstin,
  country: locations.country,
  state: locations.state,
  city: locations.city,
  locationId: bidders.locationId,
  contactName: users.name,
  contactEmail: users.emailId,
  contactPhone: users.phoneNumber,
  materials: bidders.materials,
  emd: bidders.emdAvailableBalance,
  van: bidders.van,
  isActive: bidders.isActive,
  isVerified: bidders.isVerified,
  isSubscribed: hasCoveringSubscriptionSql,
  createdAt: bidders.createdAt,
};

async function auctionStatsForBidders(bidderIds: number[]): Promise<
  Map<number, { auctionCount: number; lastAuctionDate: string | null }>
> {
  const stats = new Map<
    number,
    { auctionCount: number; lastAuctionDate: string | null }
  >();
  if (bidderIds.length === 0) return stats;

  const rows = await db
    .select({
      bidderId: auctionLotBidderMaps.bidderId,
      auctionCount: sql<number>`count(distinct ${auctionLotBidderMaps.auctionId})::int`,
      lastAuctionDate: max(auctions.auctionDate),
    })
    .from(auctionLotBidderMaps)
    .innerJoin(auctions, eq(auctions.id, auctionLotBidderMaps.auctionId))
    .where(
      and(
        eq(auctionLotBidderMaps.isActive, true),
        inArray(auctionLotBidderMaps.bidderId, bidderIds),
      ),
    )
    .groupBy(auctionLotBidderMaps.bidderId);

  for (const row of rows) {
    stats.set(row.bidderId, {
      auctionCount: Number(row.auctionCount),
      lastAuctionDate: toIsoTimestamp(row.lastAuctionDate),
    });
  }
  return stats;
}

export class BiddersService {
  async getCounts(): Promise<BidderListCounts> {
    const { from, to } = last30IstDateRange();
    const [counts] = await db
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${bidders.isActive})::int`,
        inactive: sql<number>`count(*) filter (where not ${bidders.isActive})::int`,
        unverified: sql<number>`count(*) filter (where not ${bidders.isVerified})::int`,
        newLast30d: sql<number>`count(*) filter (where ${bidders.createdAt}::date >= cast(${from} as date) and ${bidders.createdAt}::date <= cast(${to} as date))::int`,
      })
      .from(bidders)
      .where(ne(bidders.id, 0));

    return (
      counts ?? {
        total: 0,
        active: 0,
        inactive: 0,
        unverified: 0,
        newLast30d: 0,
      }
    );
  }

  async listActiveBidderOptions(opts: {
    q?: string;
    limit?: number;
    ids?: number[];
    clientId?: number;
  } = {}): Promise<Array<{ bidderId: number; companyName: string }>> {
    const q = opts.q?.trim() ?? "";
    const ids = opts.ids ?? [];
    const limit = resolveOptionsLimit(q, opts.limit);

    const baseConditions: SQL[] = [
      eq(bidders.isActive, true),
      eq(bidders.isVerified, true),
    ];
    if (opts.clientId != null) {
      const blockedIds = await currentlyBlockedBidderIdsForClient(opts.clientId);
      if (blockedIds.length > 0) {
        baseConditions.push(notInArray(bidders.id, blockedIds));
      }
    }

    const selectShape = {
      id: bidders.id,
      companyName: bidders.companyName,
    };

    const byIds =
      ids.length > 0
        ? await db
            .select(selectShape)
            .from(bidders)
            .where(and(...baseConditions, inArray(bidders.id, ids)))
            .orderBy(asc(bidders.companyName))
        : [];

    const searchConditions: SQL[] = [...baseConditions];
    if (q) {
      const term = `%${q}%`;
      searchConditions.push(
        or(
          ilike(bidders.companyName, term),
          ilike(sql`cast(${bidders.id} as text)`, term),
        )!,
      );
    }

    const searchQuery = db
      .select(selectShape)
      .from(bidders)
      .where(and(...searchConditions))
      .orderBy(asc(bidders.companyName));

    const searched =
      limit != null ? await searchQuery.limit(limit) : await searchQuery;

    const merged = mergeOptionsById(byIds, searched, limit);
    merged.sort((a, b) => a.companyName.localeCompare(b.companyName));

    return merged.map((r) => ({
      bidderId: r.id,
      companyName: r.companyName,
    }));
  }

  async listActiveBidderOptionIds(opts: {
    q?: string;
    clientId?: number;
  } = {}): Promise<EntityOptionIdsResult> {
    const q = opts.q?.trim() ?? "";
    const baseConditions: SQL[] = [
      eq(bidders.isActive, true),
      eq(bidders.isVerified, true),
    ];
    if (opts.clientId != null) {
      const blockedIds = await currentlyBlockedBidderIdsForClient(opts.clientId);
      if (blockedIds.length > 0) {
        baseConditions.push(notInArray(bidders.id, blockedIds));
      }
    }
    if (q) {
      const term = `%${q}%`;
      baseConditions.push(
        or(
          ilike(bidders.companyName, term),
          ilike(sql`cast(${bidders.id} as text)`, term),
        )!,
      );
    }
    const searchWhere = and(...baseConditions);

    const [countRow] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(bidders)
      .where(searchWhere);

    const total = countRow?.total ?? 0;
    const rows = await db
      .select({ id: bidders.id })
      .from(bidders)
      .where(searchWhere)
      .orderBy(asc(bidders.companyName))
      .limit(MAX_SELECT_ALL_IDS);

    return toOptionIdsResult(
      rows.map((r) => r.id),
      total,
    );
  }

  async list(opts: BiddersListParams): Promise<BidderListResult> {
    const { page, pageSize, offset } = clampPagination(
      opts.page,
      opts.pageSize,
    );
    const whereExpr = buildBidderListWhere(opts);
    const orderBy = buildBidderListOrderBy(opts.sortBy, opts.sortOrder);

    const [countRow] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(bidders)
      .leftJoin(locations, eq(bidders.locationId, locations.id))
      .leftJoin(users, eq(users.bidderId, bidders.id))
      .where(whereExpr);

    const rows = await db
      .select(bidderListSelect)
      .from(bidders)
      .leftJoin(locations, eq(bidders.locationId, locations.id))
      .leftJoin(users, eq(users.bidderId, bidders.id))
      .where(whereExpr)
      .orderBy(...orderBy)
      .limit(pageSize)
      .offset(offset);

    const [counts, auctionStats] = await Promise.all([
      this.getCounts(),
      auctionStatsForBidders(rows.map((row) => row.bidderId)),
    ]);

    return {
      items: rows.map((r) => {
        const auction = auctionStats.get(r.bidderId);
        return {
          ...r,
          materials: r.materials ?? [],
          emd: parseEmd(r.emd),
          isSubscribed: Boolean(r.isSubscribed),
          auctionCount: auction?.auctionCount ?? 0,
          lastAuctionDate: auction?.lastAuctionDate ?? null,
        };
      }),
      total: countRow?.total ?? 0,
      page,
      pageSize,
      counts,
    };
  }

  async get(bidderId: number): Promise<BidderDetail | null> {
    const [row] = await db
      .select({
        bidder: bidders,
        location: locations,
        contactEmail: users.emailId,
        contactPhone: users.phoneNumber,
      })
      .from(bidders)
      .leftJoin(locations, eq(bidders.locationId, locations.id))
      .leftJoin(users, eq(users.bidderId, bidders.id))
      .where(eq(bidders.id, bidderId))
      .limit(1);

    if (!row) return null;

    return {
      bidderId: row.bidder.id,
      companyName: row.bidder.companyName,
      isActive: row.bidder.isActive,
      isVerified: row.bidder.isVerified,
      createdAt: row.bidder.createdAt,
      contactEmail: row.contactEmail?.trim() || null,
      contactPhone: row.contactPhone?.trim() || null,
      profile: toProfile(row.bidder, row.location),
      blocks: [],
      mappings: [],
    };
  }

  async listGloballyBlocked(
    params: BlockedBiddersListParams,
  ): Promise<BlockedBiddersListResult> {
    const { page, pageSize, offset } = clampPagination(
      params.page,
      params.pageSize,
    );
    const search = params.search?.trim();

    const ranked = db
      .select({
        id: bidderBlockLogs.id,
        clientId: bidderBlockLogs.clientId,
        bidderId: bidderBlockLogs.bidderId,
        isBlocked: bidderBlockLogs.isBlocked,
        reason: bidderBlockLogs.reason,
        createdAt: bidderBlockLogs.createdAt,
        createdBy: bidderBlockLogs.createdBy,
        rn: sql<number>`row_number() over (
          partition by ${bidderBlockLogs.clientId}, ${bidderBlockLogs.bidderId}
          order by ${bidderBlockLogs.createdAt} desc, ${bidderBlockLogs.id} desc
        )`.as("rn"),
      })
      .from(bidderBlockLogs)
      .as("ranked");

    const conditions = [eq(ranked.rn, 1), eq(ranked.isBlocked, true)];
    if (search) {
      const term = `%${search}%`;
      conditions.push(
        or(
          ilike(sql`cast(${ranked.bidderId} as text)`, term),
          ilike(sql`cast(${ranked.clientId} as text)`, term),
          ilike(bidders.companyName, term),
          ilike(clients.companyName, term),
          ilike(ranked.reason, term),
        )!,
      );
    }
    const whereExpr = and(...conditions);

    const sortBy: BlockedBidderSortField =
      params.sortBy === "blockedAt" ? "blockedAt" : "companyName";
    const dir = params.sortOrder === "desc" ? desc : asc;
    const orderBy =
      sortBy === "blockedAt"
        ? [dir(ranked.createdAt), asc(bidders.companyName)]
        : [dir(bidders.companyName), asc(clients.companyName)];

    const [countRow] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(ranked)
      .innerJoin(bidders, eq(bidders.id, ranked.bidderId))
      .leftJoin(clients, eq(clients.id, ranked.clientId))
      .where(whereExpr);

    const rows = await db
      .select({
        logId: ranked.id,
        bidderId: ranked.bidderId,
        companyName: bidders.companyName,
        clientId: ranked.clientId,
        clientName: clients.companyName,
        reason: ranked.reason,
        blockedAt: ranked.createdAt,
        blockedByName: users.name,
      })
      .from(ranked)
      .innerJoin(bidders, eq(bidders.id, ranked.bidderId))
      .leftJoin(clients, eq(clients.id, ranked.clientId))
      .leftJoin(users, eq(users.id, ranked.createdBy))
      .where(whereExpr)
      .orderBy(...orderBy)
      .limit(pageSize)
      .offset(offset);

    return {
      items: rows.map((r) => ({
        logId: r.logId,
        bidderId: r.bidderId,
        companyName: r.companyName,
        clientId: r.clientId,
        clientName: r.clientName ?? null,
        reason: r.reason ?? null,
        blockedAt: r.blockedAt,
        blockedByName: r.blockedByName ?? null,
      })),
      total: countRow?.total ?? 0,
      page,
      pageSize,
    };
  }

  async listClientBlocksForBidder(
    bidderId: number,
    opts: BidderBlocksListParams = { page: 1, pageSize: 10 },
  ): Promise<BidderBlocksListResult> {
    await this.requireBidder(bidderId);

    const search = opts.search?.trim();
    const { page, pageSize, offset } = clampPagination(
      opts.page,
      opts.pageSize,
    );

    const ranked = db
      .select({
        id: bidderBlockLogs.id,
        clientId: bidderBlockLogs.clientId,
        isBlocked: bidderBlockLogs.isBlocked,
        reason: bidderBlockLogs.reason,
        createdAt: bidderBlockLogs.createdAt,
        createdBy: bidderBlockLogs.createdBy,
        rn: sql<number>`row_number() over (
          partition by ${bidderBlockLogs.clientId}
          order by ${bidderBlockLogs.createdAt} desc, ${bidderBlockLogs.id} desc
        )`.as("rn"),
      })
      .from(bidderBlockLogs)
      .where(eq(bidderBlockLogs.bidderId, bidderId))
      .as("ranked");

    const conditions: SQL[] = [eq(ranked.rn, 1), eq(ranked.isBlocked, true)];
    if (search) {
      const term = `%${search}%`;
      conditions.push(
        or(
          ilike(clients.companyName, term),
          ilike(ranked.reason, term),
          ilike(sql`cast(${ranked.clientId} as text)`, term),
        )!,
      );
    }
    const whereExpr = and(...conditions);

    const descOrder = (opts.sortOrder ?? "desc") === "desc";
    const orderBy = descOrder
      ? [desc(ranked.createdAt), desc(ranked.id)]
      : [asc(ranked.createdAt), asc(ranked.id)];

    const [rows, [countRow]] = await Promise.all([
      db
        .select({
          id: ranked.id,
          clientId: ranked.clientId,
          clientName: clients.companyName,
          isBlocked: ranked.isBlocked,
          reason: ranked.reason,
          createdAt: ranked.createdAt,
          blockedByName: users.name,
        })
        .from(ranked)
        .leftJoin(clients, eq(clients.id, ranked.clientId))
        .leftJoin(users, eq(users.id, ranked.createdBy))
        .where(whereExpr)
        .orderBy(...orderBy)
        .limit(pageSize)
        .offset(offset),
      db
        .select({ total: count() })
        .from(ranked)
        .leftJoin(clients, eq(clients.id, ranked.clientId))
        .where(whereExpr),
    ]);

    return {
      items: rows.map((r) => ({
        id: r.id,
        clientId: r.clientId,
        clientName: r.clientName ?? null,
        isBlocked: r.isBlocked,
        reason: r.reason ?? null,
        createdAt: r.createdAt,
        blockedByName: r.blockedByName ?? null,
      })),
      total: Number(countRow?.total ?? 0),
      page,
      pageSize,
    };
  }

  async blockForClient(
    bidderId: number,
    clientId: number,
    reason: string,
    userId: number,
  ): Promise<{ ok: true }> {
    await this.requireBidder(bidderId);
    await this.assertClientExists(clientId);

    const activeBlocks = await this.listClientBlocksForBidder(bidderId, {
      page: 1,
      pageSize: 100,
    });
    if (activeBlocks.items.some((b) => b.clientId === clientId)) {
      throw new BidderAlreadyBlockedError();
    }

    const now = formatUtcNow();
    const id = await nextBlockLogId();
    await db.insert(bidderBlockLogs).values({
      id,
      clientId,
      bidderId,
      isBlocked: true,
      reason,
      createdAt: now,
      createdBy: userId,
      updatedAt: now,
      updatedBy: userId,
    });

    return { ok: true };
  }

  async unblockForClient(
    bidderId: number,
    clientId: number,
    userId: number,
  ): Promise<{ ok: true }> {
    await this.requireBidder(bidderId);

    const activeBlocks = await this.listClientBlocksForBidder(bidderId, {
      page: 1,
      pageSize: 100,
    });
    if (!activeBlocks.items.some((b) => b.clientId === clientId)) {
      throw new BidderNotBlockedForClientError();
    }

    const now = formatUtcNow();
    const id = await nextBlockLogId();
    await db.insert(bidderBlockLogs).values({
      id,
      clientId,
      bidderId,
      isBlocked: false,
      reason: null,
      createdAt: now,
      createdBy: userId,
      updatedAt: now,
      updatedBy: userId,
    });

    return { ok: true };
  }

  async listGloballyExempted(
    params: ExemptedBiddersListParams,
  ): Promise<ExemptedBiddersListResult> {
    const { page, pageSize, offset } = clampPagination(
      params.page,
      params.pageSize,
    );
    const search = params.search?.trim();

    const ranked = db
      .select({
        id: bidderExemptionLogs.id,
        clientId: bidderExemptionLogs.clientId,
        bidderId: bidderExemptionLogs.bidderId,
        isExempted: bidderExemptionLogs.isExempted,
        reason: bidderExemptionLogs.reason,
        createdAt: bidderExemptionLogs.createdAt,
        createdBy: bidderExemptionLogs.createdBy,
        rn: sql<number>`row_number() over (
          partition by ${bidderExemptionLogs.clientId}, ${bidderExemptionLogs.bidderId}
          order by ${bidderExemptionLogs.createdAt} desc, ${bidderExemptionLogs.id} desc
        )`.as("rn"),
      })
      .from(bidderExemptionLogs)
      .as("ranked");

    const conditions = [eq(ranked.rn, 1), eq(ranked.isExempted, true)];
    if (search) {
      const term = `%${search}%`;
      conditions.push(
        or(
          ilike(sql`cast(${ranked.bidderId} as text)`, term),
          ilike(sql`cast(${ranked.clientId} as text)`, term),
          ilike(bidders.companyName, term),
          ilike(clients.companyName, term),
          ilike(ranked.reason, term),
        )!,
      );
    }
    const whereExpr = and(...conditions);

    const sortBy: ExemptedBidderSortField =
      params.sortBy === "exemptedAt" ? "exemptedAt" : "companyName";
    const dir = params.sortOrder === "desc" ? desc : asc;
    const orderBy =
      sortBy === "exemptedAt"
        ? [dir(ranked.createdAt), asc(bidders.companyName)]
        : [dir(bidders.companyName), asc(clients.companyName)];

    const [countRow] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(ranked)
      .innerJoin(bidders, eq(bidders.id, ranked.bidderId))
      .leftJoin(clients, eq(clients.id, ranked.clientId))
      .where(whereExpr);

    const rows = await db
      .select({
        logId: ranked.id,
        bidderId: ranked.bidderId,
        companyName: bidders.companyName,
        clientId: ranked.clientId,
        clientName: clients.companyName,
        reason: ranked.reason,
        exemptedAt: ranked.createdAt,
        exemptedByName: users.name,
      })
      .from(ranked)
      .innerJoin(bidders, eq(bidders.id, ranked.bidderId))
      .leftJoin(clients, eq(clients.id, ranked.clientId))
      .leftJoin(users, eq(users.id, ranked.createdBy))
      .where(whereExpr)
      .orderBy(...orderBy)
      .limit(pageSize)
      .offset(offset);

    return {
      items: rows.map((r) => ({
        logId: r.logId,
        bidderId: r.bidderId,
        companyName: r.companyName,
        clientId: r.clientId,
        clientName: r.clientName ?? null,
        reason: r.reason ?? null,
        exemptedAt: r.exemptedAt,
        exemptedByName: r.exemptedByName ?? null,
      })),
      total: countRow?.total ?? 0,
      page,
      pageSize,
    };
  }

  async listClientExemptionsForBidder(
    bidderId: number,
    opts: BidderExemptionsListParams = { page: 1, pageSize: 10 },
  ): Promise<BidderExemptionsListResult> {
    await this.requireBidder(bidderId);

    const search = opts.search?.trim();
    const { page, pageSize, offset } = clampPagination(
      opts.page,
      opts.pageSize,
    );

    const ranked = db
      .select({
        id: bidderExemptionLogs.id,
        clientId: bidderExemptionLogs.clientId,
        isExempted: bidderExemptionLogs.isExempted,
        reason: bidderExemptionLogs.reason,
        createdAt: bidderExemptionLogs.createdAt,
        createdBy: bidderExemptionLogs.createdBy,
        rn: sql<number>`row_number() over (
          partition by ${bidderExemptionLogs.clientId}
          order by ${bidderExemptionLogs.createdAt} desc, ${bidderExemptionLogs.id} desc
        )`.as("rn"),
      })
      .from(bidderExemptionLogs)
      .where(eq(bidderExemptionLogs.bidderId, bidderId))
      .as("ranked");

    const conditions: SQL[] = [eq(ranked.rn, 1), eq(ranked.isExempted, true)];
    if (search) {
      const term = `%${search}%`;
      conditions.push(
        or(
          ilike(clients.companyName, term),
          ilike(ranked.reason, term),
          ilike(sql`cast(${ranked.clientId} as text)`, term),
        )!,
      );
    }
    const whereExpr = and(...conditions);

    const descOrder = (opts.sortOrder ?? "desc") === "desc";
    const orderBy = descOrder
      ? [desc(ranked.createdAt), desc(ranked.id)]
      : [asc(ranked.createdAt), asc(ranked.id)];

    const [rows, [countRow]] = await Promise.all([
      db
        .select({
          id: ranked.id,
          clientId: ranked.clientId,
          clientName: clients.companyName,
          isExempted: ranked.isExempted,
          reason: ranked.reason,
          createdAt: ranked.createdAt,
          exemptedByName: users.name,
        })
        .from(ranked)
        .leftJoin(clients, eq(clients.id, ranked.clientId))
        .leftJoin(users, eq(users.id, ranked.createdBy))
        .where(whereExpr)
        .orderBy(...orderBy)
        .limit(pageSize)
        .offset(offset),
      db
        .select({ total: count() })
        .from(ranked)
        .leftJoin(clients, eq(clients.id, ranked.clientId))
        .where(whereExpr),
    ]);

    return {
      items: rows.map((r) => ({
        id: r.id,
        clientId: r.clientId,
        clientName: r.clientName ?? null,
        isExempted: r.isExempted,
        reason: r.reason ?? null,
        createdAt: r.createdAt,
        exemptedByName: r.exemptedByName ?? null,
      })),
      total: Number(countRow?.total ?? 0),
      page,
      pageSize,
    };
  }

  async exemptForClient(
    bidderId: number,
    clientId: number,
    reason: string,
    userId: number,
  ): Promise<{ ok: true }> {
    await this.requireBidder(bidderId);
    await this.assertClientExists(clientId);

    const activeExemptions = await this.listClientExemptionsForBidder(
      bidderId,
      { page: 1, pageSize: 100 },
    );
    if (activeExemptions.items.some((e) => e.clientId === clientId)) {
      throw new BidderAlreadyExemptedError();
    }

    const now = formatUtcNow();
    const id = await nextExemptionLogId();
    await db.insert(bidderExemptionLogs).values({
      id,
      clientId,
      bidderId,
      isExempted: true,
      reason,
      createdAt: now,
      createdBy: userId,
      updatedAt: now,
      updatedBy: userId,
    });

    return { ok: true };
  }

  async revokeExemptionForClient(
    bidderId: number,
    clientId: number,
    userId: number,
  ): Promise<{ ok: true }> {
    await this.requireBidder(bidderId);

    const activeExemptions = await this.listClientExemptionsForBidder(
      bidderId,
      { page: 1, pageSize: 100 },
    );
    if (!activeExemptions.items.some((e) => e.clientId === clientId)) {
      throw new BidderNotExemptedError();
    }

    const now = formatUtcNow();
    const id = await nextExemptionLogId();
    await db.insert(bidderExemptionLogs).values({
      id,
      clientId,
      bidderId,
      isExempted: false,
      reason: null,
      createdAt: now,
      createdBy: userId,
      updatedAt: now,
      updatedBy: userId,
    });

    return { ok: true };
  }

  async create(
    input: CreateBidderInput,
    userId: number,
  ): Promise<{ bidderId: number; userId: number }> {
    const now = formatUtcNow();
    const bidderId = await nextBidderId();
    const locationFields = await resolveLocationFields(input.locationId);

    await db.insert(bidders).values({
      id: bidderId,
      companyName: input.companyName,
      address: input.address ?? null,
      locationId: locationFields.locationId,
      country: locationFields.country,
      state: locationFields.state,
      city: locationFields.city,
      pincode: input.pincode ?? null,
      website: input.website ?? null,
      pan: input.pan ?? null,
      gstin: input.gstin ?? null,
      materials: input.materials ?? [],
      isActive: input.isActive ?? false,
      isVerified: input.isVerified ?? false,
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
      van: buildBidderVan(bidderId),
      createdAt: now,
      updatedAt: now,
      createdBy: userId,
      updatedBy: userId,
    });

    try {
      const created = await bidderUsersService.createForBidder(
        bidderId,
        {
          name: input.user.name,
          userLoginName: input.user.userLoginName,
          emailId: input.user.emailId,
          phoneNumber: input.user.phoneNumber,
          whatsappNumber: input.user.whatsappNumber ?? null,
          designation: input.user.designation ?? null,
          isActive: input.user.isActive ?? true,
        },
        userId,
      );
      return { bidderId, userId: created.userId };
    } catch (e) {
      await db.delete(bidders).where(eq(bidders.id, bidderId));
      throw e;
    }
  }

  async updateProfile(
    bidderId: number,
    input: BidderInfoInput,
    userId: number,
  ): Promise<void> {
    await this.requireBidder(bidderId);

    const updates: Partial<typeof bidders.$inferInsert> = {
      updatedAt: formatUtcNow(),
      updatedBy: userId,
    };

    if (input.companyName !== undefined)
      updates.companyName = input.companyName;
    if (input.address !== undefined) updates.address = input.address ?? null;
    if (input.pincode !== undefined) updates.pincode = input.pincode ?? null;
    if (input.website !== undefined) updates.website = input.website ?? null;
    if (input.pan !== undefined) updates.pan = input.pan ?? null;
    if (input.gstin !== undefined) updates.gstin = input.gstin ?? null;
    if (input.materials !== undefined) updates.materials = input.materials;
    if (input.validFrom !== undefined)
      updates.validFrom = input.validFrom ?? null;
    if (input.validTo !== undefined) updates.validTo = input.validTo ?? null;

    if (input.locationId !== undefined) {
      const locationFields = await resolveLocationFields(input.locationId);
      updates.locationId = locationFields.locationId;
      updates.country = locationFields.country;
      updates.state = locationFields.state;
      updates.city = locationFields.city;
    }

    await db.update(bidders).set(updates).where(eq(bidders.id, bidderId));
  }

  async setStatus(
    bidderId: number,
    status: { isActive: boolean; isVerified: boolean },
    userId: number,
  ): Promise<DetachUnstartedResult | null> {
    await this.requireBidder(bidderId);
    await db
      .update(bidders)
      .set({
        isActive: status.isActive,
        isVerified: status.isVerified,
        updatedAt: formatUtcNow(),
        updatedBy: userId,
      })
      .where(eq(bidders.id, bidderId));
    // Always re-run while unverified so a failed EMD release can be retried
    // by saving status again. Live lots are left in place.
    if (!status.isVerified) {
      return detachBidderFromUnstartedLots(bidderId, userId);
    }
    return null;
  }

  /**
   * Flip a bidder to unverified (e.g. on a bank account change request) and
   * release them from unstarted lots, same as an admin unverifying them.
   */
  async markUnverified(bidderId: number, userId: number): Promise<void> {
    await this.requireBidder(bidderId);
    await db
      .update(bidders)
      .set({ isVerified: false, updatedAt: formatUtcNow(), updatedBy: userId })
      .where(eq(bidders.id, bidderId));
    await detachBidderFromUnstartedLots(bidderId, userId);
  }

  /** Approve a pending bidder: mark verified (unlocks full participation). */
  async approve(bidderId: number, userId: number): Promise<void> {
    await this.requireBidder(bidderId);
    const now = formatUtcNow();
    await db
      .update(bidders)
      .set({ isVerified: true, updatedAt: now, updatedBy: userId })
      .where(eq(bidders.id, bidderId));
  }

  /** Reject a pending bidder: deactivate the bidder and revoke its login. */
  async reject(bidderId: number, userId: number): Promise<void> {
    await this.requireBidder(bidderId);
    const now = formatUtcNow();
    await db.transaction(async (tx) => {
      await tx
        .update(bidders)
        .set({
          isActive: false,
          isVerified: false,
          updatedAt: now,
          updatedBy: userId,
        })
        .where(eq(bidders.id, bidderId));
      // Revoke the bidder's login so they can no longer sign in.
      await tx
        .update(users)
        .set({ isActive: false, lastUpdatedAt: now, lastUpdatedBy: userId })
        .where(eq(users.bidderId, bidderId));
    });
    await detachBidderFromUnstartedLots(bidderId, userId);
  }

  async requireBidder(bidderId: number): Promise<void> {
    const [row] = await db
      .select({ id: bidders.id })
      .from(bidders)
      .where(eq(bidders.id, bidderId))
      .limit(1);
    if (!row) throw new BidderNotFoundError();
  }

  private async assertClientExists(clientId: number): Promise<void> {
    const [row] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    if (!row) throw new ClientNotFoundError();
  }
}

export const biddersService = new BiddersService();
