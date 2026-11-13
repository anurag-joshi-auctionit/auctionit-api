import { asc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  liftingBidderDispositions,
  liftingClientDispositions,
} from "../../db/schema/index.js";
import {
  DEFAULT_LIFTING_CLIENT_DISPOSITION_ID,
  LIFTING_CLIENT_DISPOSITION,
  LIFTING_CLIENT_DISPOSITION_LABELS,
  type LiftingClientDispositionId,
} from "../../lib/masters/status-keys.js";

export type ClientDispositionRow = {
  id: number;
  label: string;
  description: string;
  isActive: boolean;
};

export type BidderDispositionRow = ClientDispositionRow & {
  requiresLiftedQty: boolean;
  requiresNextFollowup: boolean;
};

let clientCache: ClientDispositionRow[] | null = null;
let bidderCache: BidderDispositionRow[] | null = null;
let clientCacheAt = 0;
let bidderCacheAt = 0;
const CACHE_TTL_MS = 60_000;

function isCacheFresh(at: number): boolean {
  return Date.now() - at < CACHE_TTL_MS;
}

export function invalidateDispositionCache(): void {
  clientCache = null;
  bidderCache = null;
  clientCacheAt = 0;
  bidderCacheAt = 0;
}

export async function listClientDispositions(
  activeOnly = false,
): Promise<ClientDispositionRow[]> {
  if (clientCache && isCacheFresh(clientCacheAt) && !activeOnly) {
    return clientCache;
  }

  const rows = await db
    .select({
      id: liftingClientDispositions.id,
      label: liftingClientDispositions.label,
      description: liftingClientDispositions.description,
      isActive: liftingClientDispositions.isActive,
    })
    .from(liftingClientDispositions)
    .where(activeOnly ? eq(liftingClientDispositions.isActive, true) : undefined)
    .orderBy(asc(liftingClientDispositions.id));

  const mapped = rows.map((r) => ({
    id: r.id,
    label: r.label,
    description: r.description ?? "",
    isActive: Boolean(r.isActive),
  }));

  if (!activeOnly) {
    clientCache = mapped;
    clientCacheAt = Date.now();
  }

  return mapped;
}

export async function listBidderDispositions(
  activeOnly = false,
): Promise<BidderDispositionRow[]> {
  if (bidderCache && isCacheFresh(bidderCacheAt) && !activeOnly) {
    return bidderCache;
  }

  const rows = await db
    .select({
      id: liftingBidderDispositions.id,
      label: liftingBidderDispositions.label,
      description: liftingBidderDispositions.description,
      isActive: liftingBidderDispositions.isActive,
      requiresLiftedQty: liftingBidderDispositions.requiresLiftedQty,
      requiresNextFollowup: liftingBidderDispositions.requiresNextFollowup,
    })
    .from(liftingBidderDispositions)
    .where(activeOnly ? eq(liftingBidderDispositions.isActive, true) : undefined)
    .orderBy(asc(liftingBidderDispositions.id));

  const mapped = rows.map((r) => ({
    id: r.id,
    label: r.label,
    description: r.description ?? "",
    isActive: Boolean(r.isActive),
    requiresLiftedQty: Boolean(r.requiresLiftedQty),
    requiresNextFollowup: Boolean(r.requiresNextFollowup),
  }));

  if (!activeOnly) {
    bidderCache = mapped;
    bidderCacheAt = Date.now();
  }

  return mapped;
}

export async function assertActiveClientDisposition(id: number): Promise<{
  id: number;
  label: string;
}> {
  const rows = await listClientDispositions(true);
  const row = rows.find((r) => r.id === id);
  if (!row) {
    throw new DispositionValidationError(`Invalid client disposition: ${id}`);
  }
  return {
    id: row.id,
    label: row.label,
  };
}

export async function assertActiveBidderDisposition(id: number): Promise<{
  id: number;
  label: string;
  requiresLiftedQty: boolean;
  requiresNextFollowup: boolean;
}> {
  const rows = await listBidderDispositions(true);
  const row = rows.find((r) => r.id === id);
  if (!row) {
    throw new DispositionValidationError(`Invalid bidder disposition: ${id}`);
  }
  return {
    id: row.id,
    label: row.label,
    requiresLiftedQty: row.requiresLiftedQty,
    requiresNextFollowup: row.requiresNextFollowup,
  };
}

export async function resolveClientDispositionByStatus(
  status: number | null | undefined,
): Promise<{ id: number; label: string }> {
  if (status == null) {
    return {
      id: DEFAULT_LIFTING_CLIENT_DISPOSITION_ID,
      label:
        LIFTING_CLIENT_DISPOSITION_LABELS[DEFAULT_LIFTING_CLIENT_DISPOSITION_ID],
    };
  }

  const rows = await listClientDispositions(false);
  const row = rows.find((r) => r.id === status);
  if (row) {
    return { id: row.id, label: row.label };
  }

  if (status in LIFTING_CLIENT_DISPOSITION_LABELS) {
    return {
      id: status,
      label:
        LIFTING_CLIENT_DISPOSITION_LABELS[status as LiftingClientDispositionId],
    };
  }

  return {
    id: DEFAULT_LIFTING_CLIENT_DISPOSITION_ID,
    label:
      LIFTING_CLIENT_DISPOSITION_LABELS[DEFAULT_LIFTING_CLIENT_DISPOSITION_ID],
  };
}

export async function resolveBidderDispositionById(
  dispositionId: number,
): Promise<{ id: number; label: string; requiresLiftedQty: boolean }> {
  const rows = await listBidderDispositions(false);
  const row = rows.find((r) => r.id === dispositionId);
  if (row) {
    return {
      id: row.id,
      label: row.label,
      requiresLiftedQty: row.requiresLiftedQty,
    };
  }

  return {
    id: dispositionId,
    label: `Unknown (${dispositionId})`,
    requiresLiftedQty: false,
  };
}

export async function resolveOpenClientDispositionId(): Promise<number> {
  const rows = await listClientDispositions(true);
  const open = rows.find((r) => r.id === DEFAULT_LIFTING_CLIENT_DISPOSITION_ID);
  return open?.id ?? LIFTING_CLIENT_DISPOSITION.OPEN;
}

export async function bidderDispositionRequiresLiftedQty(
  id: number,
): Promise<boolean> {
  const rows = await listBidderDispositions(false);
  return rows.find((r) => r.id === id)?.requiresLiftedQty ?? false;
}

export class DispositionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispositionValidationError";
  }
}
