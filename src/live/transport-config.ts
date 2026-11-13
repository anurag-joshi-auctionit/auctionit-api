import { z } from "zod";
import { env } from "../env.js";
import {
  publishLive,
  readLiveKey,
  subscribeLive,
  writeLiveKey,
} from "./redis.js";

export const LIVE_TRANSPORT_MODES = [
  "auto",
  "socket",
  "sse",
  "poll",
] as const;

export type LiveTransportMode = (typeof LIVE_TRANSPORT_MODES)[number];

export const liveTransportModeSchema = z.enum(LIVE_TRANSPORT_MODES);

/** Client-visible transport policy, served by GET /live/transport. */
export type LiveTransportConfig = {
  mode: LiveTransportMode;
  /** False when SSE is disabled server-side; clients must not try /live/stream. */
  sseEnabled: boolean;
  /** Socket.IO unreachable for this long → clients open the SSE fallback. */
  failoverConnectMs: number;
  /** No event (including heartbeats) for this long → clients drop to polling. */
  failoverSilenceMs: number;
  pollIntervalMs: number;
  sseRetryMs: number;
  updatedAt: string | null;
  updatedByUserId: number | null;
};

const REDIS_KEY = "live:transport:mode";
const REDIS_CHANNEL = "live:transport";

const stored = z.object({
  mode: liveTransportModeSchema,
  updatedAt: z.string(),
  updatedByUserId: z.number().int().nullable(),
});

type StoredMode = z.infer<typeof stored>;

let current: StoredMode = {
  mode: env.LIVE_TRANSPORT_MODE,
  updatedAt: new Date().toISOString(),
  updatedByUserId: null,
};

function applyStored(next: StoredMode): void {
  current = next;
  console.log(
    JSON.stringify({
      scope: "live",
      event: "transport_mode",
      mode: next.mode,
      updatedByUserId: next.updatedByUserId,
    }),
  );
}

/**
 * Load the persisted mode and follow changes made on other API instances. The
 * env value stays the fallback, so a Redis-less deployment still boots with a
 * deliberate transport and only loses cross-instance propagation.
 */
export async function initLiveTransportConfig(): Promise<void> {
  const raw = await readLiveKey(REDIS_KEY);
  if (raw) {
    const parsed = stored.safeParse(safeJson(raw));
    if (parsed.success) applyStored(parsed.data);
  }
  await subscribeLive(REDIS_CHANNEL, (message) => {
    const parsed = stored.safeParse(safeJson(message));
    if (parsed.success) applyStored(parsed.data);
  });
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function getLiveTransportMode(): LiveTransportMode {
  return current.mode;
}

export function getLiveTransportConfig(): LiveTransportConfig {
  return {
    mode: current.mode,
    sseEnabled: env.LIVE_SSE_ENABLED,
    failoverConnectMs: env.LIVE_FAILOVER_CONNECT_MS,
    failoverSilenceMs: env.LIVE_FAILOVER_SILENCE_MS,
    pollIntervalMs: env.LIVE_POLL_INTERVAL_MS,
    sseRetryMs: env.LIVE_SSE_RETRY_MS,
    updatedAt: current.updatedAt,
    updatedByUserId: current.updatedByUserId,
  };
}

export async function setLiveTransportMode(
  mode: LiveTransportMode,
  updatedByUserId: number | null,
): Promise<LiveTransportConfig> {
  const next: StoredMode = {
    mode,
    updatedAt: new Date().toISOString(),
    updatedByUserId,
  };
  applyStored(next);
  const payload = JSON.stringify(next);
  await writeLiveKey(REDIS_KEY, payload);
  publishLive(REDIS_CHANNEL, payload);
  return getLiveTransportConfig();
}
