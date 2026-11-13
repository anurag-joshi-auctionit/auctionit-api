import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  max,
  ne,
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
import { ClientsErrorMessages, type ServiceFeeType } from "@auctionit/messages/clients";
import type {
  AuctionSettingsInput,
  ClientsListParams,
  CompanyInfoUpdateInput,
  CreateClientInput,
  MappedBiddersListParams,
  MaterialLocationInput,
  PlantLocationInput,
} from "../lib/clients/schemas.js";
import { db } from "../db/index.js";
import { auctionLotBidderMaps } from "../db/schema/auction-lot-bidder-maps.js";
import { auctions } from "../db/schema/auctions.js";
import { bidders } from "../db/schema/bidders.js";
import { clients } from "../db/schema/clients.js";
import { locations } from "../db/schema/locations.js";
import { plantLocations } from "../db/schema/plant-locations.js";
import { materialLocations } from "../db/schema/material-locations.js";
import { roles, ROLE_CODES } from "../db/schema/roles.js";
import { users } from "../db/schema/users.js";
import { locationsService } from "./locations.service.js";
import { KamUserNotFoundError } from "../lib/clients/schemas.js";
import { formatUtcNow } from "@auctionit/lib/date";

export type {
  AuctionSettingsInput,
  CompanyInfoUpdateInput,
  CreateClientInput,
  MaterialLocationInput,
  PlantLocationInput,
  ClientsListParams,
  ClientStatusFilter,
  MappedBiddersListParams,
} from "../lib/clients/schemas.js";

export type KamUserOption = {
  userId: number;
  name: string;
  emailId: string | null;
};

export type ClientListItem = {
  clientId: number;
  companyName: string;
  pan: string | null;
  gstin: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  locationId: number | null;
  serviceFeeType: ServiceFeeType;
  serviceFeeValue: number;
  materials: number[];
  plantLocationCount: number;
  materialLocationCount: number;
  isActive: boolean;
  createdAt: string;
};

export type ClientListCounts = { total: number; active: number; inactive: number };

export type ClientListResult = {
  items: ClientListItem[];
  total: number;
  page: number;
  pageSize: number;
  counts: ClientListCounts;
};

export type ClientDetail = {
  clientId: number;
  companyName: string;
  isActive: boolean;
  createdAt: string;
  companyInfo: {
    address: string | null;
    locationId: number | null;
    country: string | null;
    state: string | null;
    city: string | null;
    pincode: string | null;
    phone: string | null;
    website: string | null;
    email: string | null;
    pan: string | null;
    tan: string | null;
    gstin: string | null;
    materials: number[];
  };
  auctionSettings: {
    auctionPrefix: string | null;
    serviceFeeType: ServiceFeeType;
    serviceFeeValue: number;
    isLastBidExtension: boolean;
    lastBidExtensionWindow: number;
    lastBidExtensionInterval: number;
    lastBidExtensionCountMax: number;
    isStaggered: boolean;
    staggerInterval: number;
  };
  regions: Array<{ regionId: number; regionName: string | null; isActive: boolean }>;
  plantLocations: Array<{
    id: number;
    name: string | null;
    address: string | null;
    country: string | null;
    state: string | null;
    city: string | null;
    locationId: number | null;
    pincode: string | null;
    gstin: string | null;
    pan: string | null;
    pocName: string | null;
    pocEmail: string | null;
    pocPhone: string | null;
    billingName: string | null;
    billingEmailTo: string | null;
    billingEmailCc: string | null;
    gracePeriod: number | null;
    orderNumber: string | null;
    orderDate: string | null;
    kamId: number | null;
    kamName: string | null;
    kamEmail: string | null;
    isActive: boolean;
  }>;
  materialLocations: Array<{
    id: number;
    name: string | null;
    country: string | null;
    state: string | null;
    city: string | null;
    locationId: number | null;
    pincode: string | null;
    isActive: boolean;
  }>;
  contacts: Array<{
    id: number;
    name: string;
    flag: string;
    phone: string | null;
    email: string | null;
    isActive: boolean;
  }>;
  notifications: Array<{
    id: number;
    notificationId: number;
    notification: string;
    minutes: number | null;
    sendEmail: boolean | null;
    sendSms: boolean | null;
    isActive: boolean | null;
  }>;
  users: Array<{
    userId: number;
    name: string;
    emailId: string | null;
    designation: string | null;
    isActive: boolean;
  }>;
  /** False while any published auction for this client is live today (IST). */
  canEditAuctionSettings: boolean;
};

export type MappedBidderListItem = {
  bidderId: number;
  companyName: string;
  contactPhone: string | null;
  contactEmail: string | null;
  /** Distinct auctions of this client the bidder is actively mapped to. */
  auctionCount: number;
  /** Latest auction date among those auctions; null if none. */
  lastAuctionDate: string | null;
};

export type MappedBiddersListResult = {
  items: MappedBidderListItem[];
  total: number;
  page: number;
  pageSize: number;
};

function emptySubEntities(): Pick<
  ClientDetail,
  "regions" | "contacts" | "notifications" | "users"
> {
  return {
    regions: [],
    contacts: [],
    notifications: [],
    users: [],
  };
}

export class ClientLocationNotFoundError extends Error {
  constructor() {
    super("Location not found");
    this.name = "ClientLocationNotFoundError";
  }
}

export class ClientNotFoundError extends Error {
  constructor() {
    super("Client not found");
    this.name = "ClientNotFoundError";
  }
}

export class LastPlantLocationError extends Error {
  constructor() {
    super(ClientsErrorMessages.LAST_PLANT_LOCATION_REQUIRED);
    this.name = "LastPlantLocationError";
  }
}

export class ClientLiveAuctionError extends Error {
  constructor() {
    super(ClientsErrorMessages.AUCTION_SETTINGS_EDIT_REQUIRES_NO_LIVE);
    this.name = "ClientLiveAuctionError";
  }
}

/** Published, started, not-yet-ended auction for the client (today IST). */
async function clientHasLiveAuction(clientId: number): Promise<boolean> {
  const res = await db.execute<{ has_live: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM auctions a
      WHERE a.client_id = ${clientId}
        AND a.status = 'published'
        AND a.is_active = true
        AND a.auction_date::date = (now() AT TIME ZONE 'Asia/Kolkata')::date
        AND COALESCE(
          (SELECT min(a.auction_date::date + l.start_time) AT TIME ZONE 'Asia/Kolkata'
             FROM auction_lots l
             WHERE l.auction_id = a.auction_id AND l.is_active) <= now(),
          false
        )
        AND COALESCE(
          (SELECT max(
             COALESCE(
               l.extended_end_time,
               (a.auction_date::date + l.end_time) AT TIME ZONE 'Asia/Kolkata'
             )
           )
             FROM auction_lots l
             WHERE l.auction_id = a.auction_id AND l.is_active) > now(),
          true
        )
    ) AS has_live
  `);
  return res.rows[0]?.has_live === true;
}

async function resolveOrCreateLocationId(input: {
  locationId?: number | null;
  country?: string | null | undefined;
  state?: string | null | undefined;
  city?: string | null | undefined;
}): Promise<number | null> {
  let resolvedLocationId = input.locationId ?? null;
  if (resolvedLocationId) {
    const loc = await locationsService.getById(resolvedLocationId);
    if (!loc) resolvedLocationId = null;
  } else if (input.country && input.state && input.city) {
    resolvedLocationId = await locationsService.findIdByPlace(
      input.country,
      input.state,
      input.city,
    );
  }
  return resolvedLocationId;
}

async function nextPlantLocationId(): Promise<number> {
  const [row] = await db.select({ value: max(plantLocations.id) }).from(plantLocations);
  return (row?.value ?? 0) + 1;
}

async function nextMaterialLocationId(): Promise<number> {
  const [row] = await db
    .select({ value: max(materialLocations.id) })
    .from(materialLocations);
  return (row?.value ?? 0) + 1;
}

function toCompanyInfo(
  row: typeof clients.$inferSelect,
  loc: typeof locations.$inferSelect | null,
): ClientDetail["companyInfo"] {
  return {
    address: row.address ?? null,
    locationId: row.locationId ?? null,
    country: loc?.country ?? null,
    state: loc?.state ?? null,
    city: loc?.city ?? null,
    pincode: row.pincode ?? null,
    phone: row.phone ?? null,
    website: row.website ?? null,
    email: row.email ?? null,
    pan: row.pan ?? null,
    tan: row.tan ?? null,
    gstin: row.gstin ?? null,
    materials: row.materials ?? [],
  };
}

function toAuctionSettings(row: typeof clients.$inferSelect): ClientDetail["auctionSettings"] {
  return {
    auctionPrefix: row.auctionPrefix ?? null,
    serviceFeeType: row.serviceFeeType,
    serviceFeeValue: row.serviceFeeValue,
    isLastBidExtension: row.isLastBidExtension,
    lastBidExtensionWindow: row.lastBidExtensionWindow,
    lastBidExtensionInterval: row.lastBidExtensionInterval,
    lastBidExtensionCountMax: row.lastBidExtensionCountMax,
    isStaggered: row.isStaggered,
    staggerInterval: row.staggerInterval,
  };
}

async function nextClientId(): Promise<number> {
  const [row] = await db.select({ value: max(clients.id) }).from(clients);
  return (row?.value ?? 0) + 1;
}

function escapeIlike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function mappedBidderSearchSql(search: string | undefined): SQL {
  const q = search?.trim();
  if (!q) return sql`true`;
  const term = `%${escapeIlike(q)}%`;
  const nameMatch = sql`company_name ILIKE ${term} ESCAPE '\\'`;
  if (/^\d+$/.test(q)) {
    const id = Number(q);
    if (Number.isSafeInteger(id) && id > 0) {
      return sql`(${nameMatch} OR bidder_id = ${id})`;
    }
  }
  return nameMatch;
}

function mappedBidderOrderSql(
  sortBy: MappedBiddersListParams["sortBy"],
  sortOrder: MappedBiddersListParams["sortOrder"],
): SQL {
  const descOrder = sortOrder === "desc";
  switch (sortBy) {
    case "auctionCount":
      return descOrder
        ? sql`auction_count DESC, company_name ASC, bidder_id ASC`
        : sql`auction_count ASC, company_name ASC, bidder_id ASC`;
    case "lastAuctionDate":
      return descOrder
        ? sql`last_auction_date DESC NULLS LAST, company_name ASC, bidder_id ASC`
        : sql`last_auction_date ASC NULLS LAST, company_name ASC, bidder_id ASC`;
    default:
      return descOrder
        ? sql`company_name DESC, bidder_id ASC`
        : sql`company_name ASC, bidder_id ASC`;
  }
}

/** Standing map plus this client's active lot-bidder auction stats. */
function mappedBidderCtes(clientId: number): SQL {
  return sql`
    WITH mapped AS (
      SELECT DISTINCT bidder_id
      FROM ${clients} c
      CROSS JOIN LATERAL unnest(c.bidders) AS u(bidder_id)
      WHERE c.id = ${clientId}
        AND bidder_id > 0
    ),
    stats AS (
      SELECT
        m.bidder_id,
        COUNT(DISTINCT m.auction_id)::int AS auction_count,
        MAX(a.auction_date) AS last_auction_date
      FROM mapped mp
      INNER JOIN ${auctionLotBidderMaps} m
        ON m.bidder_id = mp.bidder_id
       AND m.client_id = ${clientId}
       AND m.is_active = true
      INNER JOIN ${auctions} a ON a.auction_id = m.auction_id
      GROUP BY m.bidder_id
    ),
    rows AS (
      SELECT
        b.id AS bidder_id,
        b.company_name,
        u.phone_number AS contact_phone,
        u.email_id AS contact_email,
        COALESCE(s.auction_count, 0)::int AS auction_count,
        s.last_auction_date
      FROM mapped mp
      INNER JOIN ${bidders} b
        ON b.id = mp.bidder_id
       AND b.is_active = true
      LEFT JOIN ${users} u ON u.bidder_id = b.id
      LEFT JOIN stats s ON s.bidder_id = b.id
    )
  `;
}

function toIsoTimestamp(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function clampPagination(page: number, pageSize: number) {
  const clampedPage = Math.max(1, page);
  const clampedPageSize = Math.max(1, Math.min(100, pageSize));
  return {
    page: clampedPage,
    pageSize: clampedPageSize,
    offset: (clampedPage - 1) * clampedPageSize,
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
    dateField?: "createdAt";
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

const CLIENT_SORT_FIELDS = new Set([
  "companyName",
  "serviceFeeValue",
  "isActive",
  "createdAt",
] as const);

function buildClientListWhere(
  opts: Pick<
    ClientsListParams,
    "search" | "status" | "dateField" | "dateFrom" | "dateTo"
  >,
) {
  const search = opts.search?.trim();
  const conditions = [
    activeInactiveStatus(clients.isActive, opts.status ?? "all"),
    createdAtDateRange(clients.createdAt, opts),
  ];

  if (search) {
    const term = `%${search}%`;
    conditions.push(
      or(
        ilike(sql`cast(${clients.id} as text)`, term),
        ilike(clients.companyName, term),
        ilike(clients.gstin, term),
        ilike(locations.state, term),
      )!,
    );
  }

  return combineConditions(conditions);
}

function buildClientListOrderBy(
  sortBy?: ClientsListParams["sortBy"],
  sortOrder?: ClientsListParams["sortOrder"],
) {
  return buildSortOrder(
    sortBy,
    sortOrder,
    CLIENT_SORT_FIELDS,
    "companyName",
    {
      companyName: [clients.companyName],
      serviceFeeValue: [clients.serviceFeeValue, clients.companyName],
      isActive: [clients.isActive, clients.companyName],
      createdAt: [clients.createdAt, clients.companyName],
    },
  );
}

const clientListSelect = {
  clientId: clients.id,
  companyName: clients.companyName,
  pan: clients.pan,
  gstin: clients.gstin,
  country: locations.country,
  state: locations.state,
  city: locations.city,
  locationId: clients.locationId,
  serviceFeeType: clients.serviceFeeType,
  serviceFeeValue: clients.serviceFeeValue,
  materials: clients.materials,
  plantLocationCount: sql<number>`(select count(*)::int from ${plantLocations} where ${plantLocations.clientId} = ${clients.id})`,
  materialLocationCount: sql<number>`(select count(*)::int from ${materialLocations} where ${materialLocations.clientId} = ${clients.id})`,
  isActive: clients.isActive,
  createdAt: clients.createdAt,
};

export class ClientsService {
  async getCounts(): Promise<ClientListCounts> {
    const [counts] = await db
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${clients.isActive})::int`,
        inactive: sql<number>`count(*) filter (where not ${clients.isActive})::int`,
      })
      .from(clients);

    return counts ?? { total: 0, active: 0, inactive: 0 };
  }

  async list(opts: ClientsListParams): Promise<ClientListResult> {
    const { page, pageSize, offset } = clampPagination(opts.page, opts.pageSize);
    const whereExpr = buildClientListWhere(opts);
    const orderBy = buildClientListOrderBy(opts.sortBy, opts.sortOrder);

    const [countRow] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(clients)
      .leftJoin(locations, eq(clients.locationId, locations.id))
      .where(whereExpr);

    const rows = await db
      .select(clientListSelect)
      .from(clients)
      .leftJoin(locations, eq(clients.locationId, locations.id))
      .where(whereExpr)
      .orderBy(...orderBy)
      .limit(pageSize)
      .offset(offset);

    const counts = await this.getCounts();

    return {
      items: rows.map((r) => ({
        ...r,
        materials: r.materials ?? [],
        plantLocationCount: r.plantLocationCount ?? 0,
        materialLocationCount: r.materialLocationCount ?? 0,
      })),
      total: countRow?.total ?? 0,
      page,
      pageSize,
      counts,
    };
  }

  async get(clientId: number): Promise<ClientDetail | null> {
    const [row] = await db
      .select({ client: clients, location: locations })
      .from(clients)
      .leftJoin(locations, eq(clients.locationId, locations.id))
      .where(eq(clients.id, clientId))
      .limit(1);

    if (!row) return null;

    const kamUser = users;
    const plantRows = await db
      .select({
        plant: plantLocations,
        kamName: kamUser.name,
        kamEmail: kamUser.emailId,
      })
      .from(plantLocations)
      .leftJoin(kamUser, eq(plantLocations.kamId, kamUser.id))
      .where(eq(plantLocations.clientId, clientId))
      .orderBy(asc(plantLocations.name));

    const materialRows = await db
      .select()
      .from(materialLocations)
      .where(eq(materialLocations.clientId, clientId))
      .orderBy(asc(materialLocations.name));

    const canEditAuctionSettings = !(await clientHasLiveAuction(clientId));

    return {
      clientId: row.client.id,
      companyName: row.client.companyName,
      isActive: row.client.isActive,
      createdAt: row.client.createdAt,
      companyInfo: toCompanyInfo(row.client, row.location),
      auctionSettings: toAuctionSettings(row.client),
      plantLocations: plantRows.map((r) => ({
        id: r.plant.id,
        name: r.plant.name ?? null,
        address: r.plant.address ?? null,
        country: r.plant.country ?? null,
        state: r.plant.state ?? null,
        city: r.plant.city ?? null,
        locationId: r.plant.locationId ?? null,
        pincode: r.plant.pincode ?? null,
        gstin: r.plant.gstin ?? null,
        pan: r.plant.pan ?? null,
        pocName: r.plant.pocName ?? null,
        pocEmail: r.plant.pocEmail ?? null,
        pocPhone: r.plant.pocPhone ?? null,
        billingName: r.plant.billingName ?? null,
        billingEmailTo: r.plant.billingEmailTo ?? null,
        billingEmailCc: r.plant.billingEmailCc ?? null,
        gracePeriod: r.plant.gracePeriod ?? null,
        orderNumber: r.plant.orderNumber ?? null,
        orderDate: r.plant.orderDate ?? null,
        kamId: r.plant.kamId ?? null,
        kamName: r.kamName ?? null,
        kamEmail: r.kamEmail ?? null,
        isActive: r.plant.isActive,
      })),
      materialLocations: materialRows.map((m) => ({
        id: m.id,
        name: m.name ?? null,
        country: m.country ?? null,
        state: m.state ?? null,
        city: m.city ?? null,
        locationId: m.locationId ?? null,
        pincode: m.pincode ?? null,
        isActive: m.isActive,
      })),
      canEditAuctionSettings,
      ...emptySubEntities(),
    };
  }

  async listMappedBidders(
    clientId: number,
    opts: MappedBiddersListParams,
  ): Promise<MappedBiddersListResult> {
    const [client] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    if (!client) throw new ClientNotFoundError();

    const { page, pageSize, offset } = clampPagination(opts.page, opts.pageSize);
    const searchSql = mappedBidderSearchSql(opts.search);
    const orderSql = mappedBidderOrderSql(opts.sortBy, opts.sortOrder);
    const ctes = mappedBidderCtes(clientId);

    const countRes = await db.execute<{ total: number }>(sql`
      ${ctes}
      SELECT COUNT(*)::int AS total
      FROM rows
      WHERE ${searchSql}
    `);
    const total = Number(countRes.rows[0]?.total ?? 0);

    const listRes = await db.execute<{
      bidder_id: number;
      company_name: string;
      contact_phone: string | null;
      contact_email: string | null;
      auction_count: number;
      last_auction_date: Date | string | null;
    }>(sql`
      ${ctes}
      SELECT
        bidder_id,
        company_name,
        contact_phone,
        contact_email,
        auction_count,
        last_auction_date
      FROM rows
      WHERE ${searchSql}
      ORDER BY ${orderSql}
      LIMIT ${pageSize}
      OFFSET ${offset}
    `);

    return {
      items: listRes.rows.map((row) => ({
        bidderId: Number(row.bidder_id),
        companyName: row.company_name,
        contactPhone: row.contact_phone?.trim() || null,
        contactEmail: row.contact_email?.trim() || null,
        auctionCount: Number(row.auction_count),
        lastAuctionDate: toIsoTimestamp(row.last_auction_date),
      })),
      total,
      page,
      pageSize,
    };
  }

  async listActiveClientOptions(opts: {
    q?: string;
    limit?: number;
    ids?: number[];
  } = {}): Promise<
    Array<{
      clientId: number;
      companyName: string;
      country: string | null;
      auctionPrefix: string | null;
    }>
  > {
    const q = opts.q?.trim() ?? "";
    const ids = opts.ids ?? [];
    const limit = resolveOptionsLimit(q, opts.limit);

    const selectShape = {
      id: clients.id,
      companyName: clients.companyName,
      country: locations.country,
      auctionPrefix: clients.auctionPrefix,
    };

    const byIds =
      ids.length > 0
        ? await db
            .select(selectShape)
            .from(clients)
            .leftJoin(locations, eq(clients.locationId, locations.id))
            .where(and(eq(clients.isActive, true), inArray(clients.id, ids)))
            .orderBy(asc(clients.companyName))
        : [];

    const searchWhere = q
      ? and(
          eq(clients.isActive, true),
          or(
            ilike(clients.companyName, `%${q}%`),
            ilike(clients.auctionPrefix, `%${q}%`),
            ilike(sql`cast(${clients.id} as text)`, `%${q}%`),
          ),
        )
      : eq(clients.isActive, true);

    const searchQuery = db
      .select(selectShape)
      .from(clients)
      .leftJoin(locations, eq(clients.locationId, locations.id))
      .where(searchWhere)
      .orderBy(asc(clients.companyName));

    const searched =
      limit != null ? await searchQuery.limit(limit) : await searchQuery;

    const merged = mergeOptionsById(byIds, searched, limit);
    merged.sort((a, b) => a.companyName.localeCompare(b.companyName));

    return merged.map((r) => ({
      clientId: r.id,
      companyName: r.companyName,
      country: r.country ?? null,
      auctionPrefix: r.auctionPrefix ?? null,
    }));
  }

  async listActiveClientOptionIds(opts: {
    q?: string;
  } = {}): Promise<EntityOptionIdsResult> {
    const q = opts.q?.trim() ?? "";
    const searchWhere = q
      ? and(
          eq(clients.isActive, true),
          or(
            ilike(clients.companyName, `%${q}%`),
            ilike(clients.auctionPrefix, `%${q}%`),
            ilike(sql`cast(${clients.id} as text)`, `%${q}%`),
          ),
        )
      : eq(clients.isActive, true);

    const [countRow] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(clients)
      .where(searchWhere);

    const total = countRow?.total ?? 0;
    const rows = await db
      .select({ id: clients.id })
      .from(clients)
      .where(searchWhere)
      .orderBy(asc(clients.companyName))
      .limit(MAX_SELECT_ALL_IDS);

    return toOptionIdsResult(
      rows.map((r) => r.id),
      total,
    );
  }

  async listKamUsers(): Promise<KamUserOption[]> {
    const rows = await db
      .select({
        userId: users.id,
        name: users.name,
        emailId: users.emailId,
      })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(
        and(eq(roles.code, ROLE_CODES.kam), eq(users.isActive, true)),
      )
      .orderBy(asc(users.name));

    return rows.map((r) => ({
      userId: r.userId,
      name: r.name,
      emailId: r.emailId ?? null,
    }));
  }

  async requireActiveKamUser(kamId: number): Promise<void> {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(
        and(
          eq(users.id, kamId),
          eq(roles.code, ROLE_CODES.kam),
          eq(users.isActive, true),
        ),
      )
      .limit(1);
    if (!row) {
      throw new KamUserNotFoundError();
    }
  }

  async requireClient(clientId: number): Promise<void> {
    const [row] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    if (!row) throw new ClientNotFoundError();
  }

  async getRegionPlantPickerData(clientId: number): Promise<{
    regions: Array<{ regionId: number; regionName: string | null }>;
    plants: Array<{ locationId: number; locationName: string | null; city: string | null }>;
  } | null> {
    const [exists] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    if (!exists) return null;

    const plantRows = await db
      .select({
        locationId: plantLocations.id,
        locationName: plantLocations.name,
        city: plantLocations.city,
      })
      .from(plantLocations)
      .where(and(eq(plantLocations.clientId, clientId), eq(plantLocations.isActive, true)))
      .orderBy(asc(plantLocations.name));

    return {
      regions: [],
      plants: plantRows.map((p) => ({
        locationId: p.locationId,
        locationName: p.locationName ?? null,
        city: p.city ?? null,
      })),
    };
  }

  async create(
    input: CreateClientInput,
    userId: number,
  ): Promise<{ clientId: number }> {
    const now = formatUtcNow();
    const info = input.companyInfo;
    const settings = {
      auctionPrefix: null as string | null,
      isLastBidExtension: false,
      isStaggered: false,
      staggerInterval: 0,
      lastBidExtensionWindow: 0,
      lastBidExtensionInterval: 0,
      lastBidExtensionCountMax: 0,
      ...input.auctionSettings,
    };

    const lastBidWindow = settings.lastBidExtensionWindow ?? 0;
    const lastBidInterval = settings.lastBidExtensionInterval ?? 0;
    const lastBidMax = settings.lastBidExtensionCountMax ?? 0;
    const staggerInterval = settings.staggerInterval ?? 0;

    const clientId = await nextClientId();
    let locationId: number | null = info.locationId;
    if (locationId) {
      const loc = await locationsService.getById(locationId);
      if (!loc) locationId = null;
    }

    const plantLocationsResolved = await Promise.all(
      input.plantLocations.map(async (p) => ({
        ...p,
        resolvedLocationId: await resolveOrCreateLocationId(p),
      })),
    );

    const materialLocationsResolved = await Promise.all(
      (input.materialLocations ?? []).map(async (m) => ({
        ...m,
        resolvedLocationId: await resolveOrCreateLocationId(m),
      })),
    );

    await db.transaction(async (tx) => {
      await tx.insert(clients).values({
        id: clientId,
        companyName: input.companyName,
        address: info.address ?? null,
        locationId,
        pincode: info.pincode ?? null,
        phone: info.phone ?? null,
        website: info.website ?? null,
        email: info.email ?? null,
        pan: info.pan ?? null,
        tan: info.tan ?? null,
        gstin: info.gstin ?? null,
        materials: info.materials ?? [],
        bidders: [],
        auctionPrefix: settings.auctionPrefix,
        serviceFeeType: input.auctionSettings?.serviceFeeType ?? input.serviceFeeType,
        serviceFeeValue: input.auctionSettings?.serviceFeeValue ?? input.serviceFeeValue,
        isLastBidExtension:
          lastBidWindow > 0 && lastBidInterval > 0 && lastBidMax > 0,
        lastBidExtensionWindow: lastBidWindow,
        lastBidExtensionInterval: lastBidInterval,
        lastBidExtensionCountMax: lastBidMax,
        isStaggered: settings.isStaggered,
        staggerInterval,
        isActive: input.isActive ?? false,
        createdAt: now,
        createdBy: userId,
      });

      if (plantLocationsResolved.length) {
        const [row] = await tx
          .select({ value: max(plantLocations.id) })
          .from(plantLocations);
        let nextId = (row?.value ?? 0) + 1;

        for (const p of plantLocationsResolved) {
          await tx.insert(plantLocations).values({
            id: nextId++,
            clientId,
            name: p.name,
            address: p.address ?? null,
            country: p.country ?? null,
            state: p.state ?? null,
            city: p.city ?? null,
            locationId: p.resolvedLocationId,
            pincode: p.pincode ?? null,
            isActive: p.isActive ?? true,
            pocName: p.pocName ?? null,
            pocEmail: p.pocEmail ?? null,
            pocPhone: p.pocPhone ?? null,
            billingName: p.billingName ?? null,
            billingEmailTo: p.billingEmailTo ?? null,
            billingEmailCc: p.billingEmailCc ?? null,
            gracePeriod: p.gracePeriod ?? null,
            gstin: p.gstin ?? null,
            pan: p.pan ?? null,
            orderNumber: p.orderNumber ?? null,
            orderDate: p.orderDate ?? null,
            kamId: p.kamId ?? null,
            createdAt: now,
            createdBy: userId,
          });
        }
      }

      if (materialLocationsResolved.length) {
        const [row] = await tx
          .select({ value: max(materialLocations.id) })
          .from(materialLocations);
        let nextId = (row?.value ?? 0) + 1;

        for (const m of materialLocationsResolved) {
          await tx.insert(materialLocations).values({
            id: nextId++,
            clientId,
            name: m.name,
            country: m.country ?? null,
            state: m.state ?? null,
            city: m.city ?? null,
            locationId: m.resolvedLocationId,
            pincode: m.pincode ?? null,
            isActive: m.isActive ?? true,
            createdAt: now,
            createdBy: userId,
          });
        }
      }
    });

    return { clientId };
  }

  async updateCompanyInfo(
    clientId: number,
    input: CompanyInfoUpdateInput,
    userId: number,
  ): Promise<void> {
    await this.requireClient(clientId);

    let locationId: number | null = input.locationId;
    if (locationId) {
      const loc = await locationsService.getById(locationId);
      if (!loc) locationId = null;
    }

    await db
      .update(clients)
      .set({
        address: input.address ?? null,
        locationId,
        pincode: input.pincode ?? null,
        phone: input.phone ?? null,
        website: input.website ?? null,
        email: input.email ?? null,
        pan: input.pan ?? null,
        tan: input.tan ?? null,
        gstin: input.gstin ?? null,
        serviceFeeType: input.serviceFeeType,
        serviceFeeValue: input.serviceFeeValue,
        ...(input.materials !== undefined ? { materials: input.materials } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        updatedAt: formatUtcNow(),
        updatedBy: userId,
      })
      .where(eq(clients.id, clientId));
  }

  async updateAuctionSettings(
    clientId: number,
    input: AuctionSettingsInput,
    userId: number,
  ): Promise<void> {
    await this.requireClient(clientId);
    if (await clientHasLiveAuction(clientId)) {
      throw new ClientLiveAuctionError();
    }

    const window = input.lastBidExtensionWindow;
    const interval = input.lastBidExtensionInterval;
    const max = input.lastBidExtensionCountMax;
    const staggerInterval = input.staggerInterval;

    await db
      .update(clients)
      .set({
        auctionPrefix: input.auctionPrefix,
        serviceFeeType: input.serviceFeeType,
        serviceFeeValue: input.serviceFeeValue,
        // Last-bid flag stays derived from its triple.
        isLastBidExtension: window > 0 && interval > 0 && max > 0,
        lastBidExtensionWindow: window,
        lastBidExtensionInterval: interval,
        lastBidExtensionCountMax: max,
        // Stagger gate is authoritative: persist exactly what was sent so it
        // can be turned off while keeping the interval. Zod + the
        // clients_stagger_interval_required CHECK enforce on => interval > 0.
        isStaggered: input.isStaggered,
        staggerInterval,
        updatedAt: formatUtcNow(),
        updatedBy: userId,
      })
      .where(eq(clients.id, clientId));
  }

  async createPlantLocation(
    clientId: number,
    input: PlantLocationInput,
    userId: number,
  ): Promise<{ id: number } | null> {
    const [client] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    if (!client) return null;

    if (input.kamId != null) {
      await this.requireActiveKamUser(input.kamId);
    }

    const now = formatUtcNow();
    const resolvedLocationId = await resolveOrCreateLocationId(input);
    const id = await nextPlantLocationId();

    await db.insert(plantLocations).values({
      id,
      clientId,
      name: input.name,
      address: input.address ?? null,
      country: input.country ?? null,
      state: input.state ?? null,
      city: input.city ?? null,
      locationId: resolvedLocationId,
      pincode: input.pincode ?? null,
      isActive: input.isActive ?? true,
      pocName: input.pocName ?? null,
      pocEmail: input.pocEmail ?? null,
      pocPhone: input.pocPhone ?? null,
      billingName: input.billingName ?? null,
      billingEmailTo: input.billingEmailTo ?? null,
      billingEmailCc: input.billingEmailCc ?? null,
      gracePeriod: input.gracePeriod ?? null,
      gstin: input.gstin ?? null,
      pan: input.pan ?? null,
      orderNumber: input.orderNumber ?? null,
      orderDate: input.orderDate ?? null,
      kamId: input.kamId ?? null,
      createdAt: now,
      createdBy: userId,
    });

    return { id };
  }

  async updatePlantLocation(
    clientId: number,
    locationId: number,
    input: Partial<PlantLocationInput>,
    userId: number,
  ): Promise<void> {
    const [existing] = await db
      .select({ id: plantLocations.id })
      .from(plantLocations)
      .where(and(eq(plantLocations.id, locationId), eq(plantLocations.clientId, clientId)))
      .limit(1);
    if (!existing) throw new ClientLocationNotFoundError();

    if (input.isActive === false) {
      const [current] = await db
        .select({ isActive: plantLocations.isActive })
        .from(plantLocations)
        .where(
          and(
            eq(plantLocations.id, locationId),
            eq(plantLocations.clientId, clientId),
          ),
        )
        .limit(1);
      if (current?.isActive) {
        const [countRow] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(plantLocations)
          .where(
            and(
              eq(plantLocations.clientId, clientId),
              eq(plantLocations.isActive, true),
              ne(plantLocations.id, locationId),
            ),
          );
        if ((countRow?.count ?? 0) === 0) {
          throw new LastPlantLocationError();
        }
      }
    }

    if (input.kamId != null) {
      await this.requireActiveKamUser(input.kamId);
    }

    const now = formatUtcNow();
    const patch: Partial<typeof plantLocations.$inferInsert> = {
      updatedAt: now,
      updatedBy: userId,
    };

    if (input.name !== undefined) patch.name = input.name;
    if (input.address !== undefined) patch.address = input.address ?? null;
    if (input.pincode !== undefined) patch.pincode = input.pincode ?? null;
    if (input.gstin !== undefined) patch.gstin = input.gstin ?? null;
    if (input.pan !== undefined) patch.pan = input.pan ?? null;
    if (input.pocName !== undefined) patch.pocName = input.pocName ?? null;
    if (input.pocEmail !== undefined) patch.pocEmail = input.pocEmail ?? null;
    if (input.pocPhone !== undefined) patch.pocPhone = input.pocPhone ?? null;
    if (input.billingName !== undefined) patch.billingName = input.billingName ?? null;
    if (input.billingEmailTo !== undefined) patch.billingEmailTo = input.billingEmailTo ?? null;
    if (input.billingEmailCc !== undefined) patch.billingEmailCc = input.billingEmailCc ?? null;
    if (input.gracePeriod !== undefined) patch.gracePeriod = input.gracePeriod ?? null;
    if (input.orderNumber !== undefined) patch.orderNumber = input.orderNumber ?? null;
    if (input.orderDate !== undefined) patch.orderDate = input.orderDate ?? null;
    if (input.kamId !== undefined) patch.kamId = input.kamId ?? null;
    if (input.isActive !== undefined) patch.isActive = input.isActive;

    if (
      input.locationId !== undefined ||
      input.country !== undefined ||
      input.state !== undefined ||
      input.city !== undefined
    ) {
      const resolvedLocationId = await resolveOrCreateLocationId({
        locationId: input.locationId,
        country: input.country,
        state: input.state,
        city: input.city,
      });
      patch.locationId = resolvedLocationId;
      if (input.country !== undefined) patch.country = input.country ?? null;
      if (input.state !== undefined) patch.state = input.state ?? null;
      if (input.city !== undefined) patch.city = input.city ?? null;
    }

    await db
      .update(plantLocations)
      .set(patch)
      .where(and(eq(plantLocations.id, locationId), eq(plantLocations.clientId, clientId)));
  }

  async createMaterialLocation(
    clientId: number,
    input: MaterialLocationInput,
    userId: number,
  ): Promise<{ id: number } | null> {
    const [client] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    if (!client) return null;

    const now = formatUtcNow();
    const resolvedLocationId = await resolveOrCreateLocationId(input);
    const id = await nextMaterialLocationId();

    await db.insert(materialLocations).values({
      id,
      clientId,
      name: input.name,
      country: input.country ?? null,
      state: input.state ?? null,
      city: input.city ?? null,
      locationId: resolvedLocationId,
      pincode: input.pincode ?? null,
      isActive: input.isActive ?? true,
      createdAt: now,
      createdBy: userId,
    });

    return { id };
  }

  async updateMaterialLocation(
    clientId: number,
    locationId: number,
    input: Partial<MaterialLocationInput>,
    userId: number,
  ): Promise<void> {
    const [existing] = await db
      .select({ id: materialLocations.id })
      .from(materialLocations)
      .where(
        and(eq(materialLocations.id, locationId), eq(materialLocations.clientId, clientId)),
      )
      .limit(1);
    if (!existing) throw new ClientLocationNotFoundError();

    const now = formatUtcNow();
    const patch: Partial<typeof materialLocations.$inferInsert> = {
      updatedAt: now,
      updatedBy: userId,
    };

    if (input.name !== undefined) patch.name = input.name;
    if (input.pincode !== undefined) patch.pincode = input.pincode ?? null;
    if (input.isActive !== undefined) patch.isActive = input.isActive;

    if (
      input.locationId !== undefined ||
      input.country !== undefined ||
      input.state !== undefined ||
      input.city !== undefined
    ) {
      const resolvedLocationId = await resolveOrCreateLocationId({
        locationId: input.locationId,
        country: input.country,
        state: input.state,
        city: input.city,
      });
      patch.locationId = resolvedLocationId;
      if (input.country !== undefined) patch.country = input.country ?? null;
      if (input.state !== undefined) patch.state = input.state ?? null;
      if (input.city !== undefined) patch.city = input.city ?? null;
    }

    await db
      .update(materialLocations)
      .set(patch)
      .where(
        and(eq(materialLocations.id, locationId), eq(materialLocations.clientId, clientId)),
      );
  }
}

export const clientsService = new ClientsService();
