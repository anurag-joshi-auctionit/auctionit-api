import { env } from "./env.js";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { randomUUID } from "node:crypto";
import { pinoHttp } from "pino-http";
import { logger } from "./lib/logger.js";
import {
  createSocketServer,
  getActiveAuctionIds,
  setLiveHandlers,
} from "./live/socket.js";
import { broadcastSnapshot, pushJoinSnapshot } from "./live/broadcast.js";
import { initLiveRedis } from "./live/redis.js";
import { initSseFanout } from "./live/sse-hub.js";
import { initLiveTransportConfig } from "./live/transport-config.js";
import { noBidExtensionService } from "./services/no-bid-extension.service.js";
import {
  NO_BID_EXTENSION_LEAD_SEC,
  NO_BID_EXTENSION_TICK_MS,
} from "./lib/auctions/no-bid-extension.js";
import { emdSettlementService } from "./services/emd-settlement.service.js";
import { EMD_SETTLEMENT_TICK_MS } from "./lib/emd/constants.js";
import {
  additionalFieldsImportJobsService,
  ADDITIONAL_FIELDS_IMPORT_TICK_MS,
} from "./services/additional-fields-import-jobs.service.js";
import { enqueueConcludedNotifications } from "./services/auction-notification.service.js";
import { runRaStageLifecycleSync } from "./services/auction-ra-stages/lifecycle-tick.service.js";
import { RA_STAGE_LIFECYCLE_TICK_MS } from "./lib/auction-ra-stages/constants.js";
import { getPoolMetrics } from "./db/index.js";
import { bootstrapPermissionCatalog } from "./services/roles.service.js";
import { routeMounts } from "./routes/mounts.js";
import { mountApiDocs } from "./openapi/serve.js";

const app = express();

if (env.TRUST_PROXY) {
  app.set("trust proxy", 1);
}

app.use(
  pinoHttp({
    logger,
    genReqId: (req, res) => {
      const existing = req.headers["x-request-id"];
      const id = typeof existing === "string" && existing.length > 0 ? existing : randomUUID();
      res.setHeader("x-request-id", id);
      return id;
    },
    autoLogging: {
      ignore: (req) => req.url === "/health",
    },
  }),
);

if (env.NODE_ENV === "development" || env.NODE_ENV === "local") {
  app.use(cors({ origin: "*" }));
}
app.use(express.json({ limit: "25mb" }));
app.use(cookieParser());

app.get("/health", (_req, res) => {
  res.json({ ok: true, pool: getPoolMetrics() });
});

mountApiDocs(app);

app.use(
  express.static(join(dirname(fileURLToPath(import.meta.url)), "../public")),
);

for (const { prefix, router } of routeMounts) {
  app.use(prefix, router);
}

app.use(
  (
    err: unknown,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    (req.log ?? logger).error({ err }, "unhandled request error");
    res.status(500).json({ error: "Internal server error", requestId: req.id });
  },
);

const httpServer = createServer(app);

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let i = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await fn(items[idx]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

void createSocketServer(httpServer).then(async () => {
  // Cross-instance fanout for the SSE channel plus the shared transport mode.
  // Both degrade to single-process behaviour when Redis is absent.
  await initLiveRedis();
  await initSseFanout();
  await initLiveTransportConfig();

  setLiveHandlers({
    onJoin: async (socket, auctionId) => {
      await pushJoinSnapshot(socket, auctionId);
    },
  });

  // Periodically re-sync every watched auction so time-derived state stays
  // authoritative. In-flight guard + bounded concurrency prevent death spirals
  // when snapshots are slow.
  {
    let resyncing = false;
    setInterval(() => {
      if (resyncing) return;
      resyncing = true;
      const ids = getActiveAuctionIds();
      // Awaiting each broadcast is what makes `resyncing` a real guard: it used
      // to reset while every snapshot query was still running, so a slow tick
      // stacked a fresh wave on top of the unfinished one.
      void mapPool(ids, env.LIVE_RESYNC_CONCURRENCY, (auctionId) =>
        broadcastSnapshot(auctionId),
      )
        .catch((err) => console.error("live resync failed", err))
        .finally(() => {
          resyncing = false;
        });
    }, env.LIVE_RESYNC_MS);
  }

  // Resolve each lot's end-of-life as one atomic step, every tick: extend
  // no-bid lots first (within the clock-skew epsilon of their effective
  // end), then close any auction with no open lots left — in the same
  // transaction, so a lot just extended can never be swept into "closed" in
  // the same breath. Auto-close has no feature flag of its own and must
  // keep running even when NO_BID_EXTENSION_ENABLED is off.
  {
    let running = false;
    setInterval(() => {
      if (running) return;
      running = true;
      void noBidExtensionService
        .tick(NO_BID_EXTENSION_LEAD_SEC, env.NO_BID_EXTENSION_ENABLED)
        .then((result) => {
          for (const auctionId of result.auctionIds) {
            void broadcastSnapshot(auctionId);
          }
          for (const auctionId of result.closedAuctionIds) {
            console.log(`auction ${auctionId} auto-closed (bidding ended)`);
            void broadcastSnapshot(auctionId);
            void runRaStageLifecycleSync({ auctionId }).catch((err) =>
              console.error(
                `RA Stages sync failed for auto-closed auction ${auctionId}`,
                err,
              ),
            );
          }
          if (result.closedAuctionIds.length > 0) {
            void enqueueConcludedNotifications(result.closedAuctionIds)
              .then((count) => {
                if (count > 0) {
                  console.log(`enqueued auction concluded emails: ${count}`);
                }
              })
              .catch((err) =>
                console.error("auction concluded email enqueue failed", err),
              );
          }
        })
        .catch((err) => console.error("lot resolution tick failed", err))
        .finally(() => {
          running = false;
        });
    }, NO_BID_EXTENSION_TICK_MS);
  }

  if (env.EMD_SETTLEMENT_ENABLED) {
    let settling = false;
    setInterval(() => {
      if (settling) return;
      settling = true;
      void emdSettlementService
        .tick()
        .then((result) => {
          if (result.processed > 0) {
            console.log(`emd settlement: ${result.processed} job(s) done`);
          }
        })
        .catch((err) => console.error("emd settlement tick failed", err))
        .finally(() => {
          settling = false;
        });
    }, EMD_SETTLEMENT_TICK_MS);
  }

  // RA Stages have no manual open/close/reopen action: this tick is the only
  // periodic sweep that keeps every stage's status in sync with its own
  // startsAt/endsAt AND its parent auction's status (draft/archived forces
  // draft, closed forces closed, published drives the normal progression).
  // The same sync also runs synchronously, scoped to one auction, whenever
  // that auction's own status changes — see auctions.service.ts and
  // auction-close.service.ts — so this periodic sweep is just the safety net.
  {
    let tickingRaStages = false;
    setInterval(() => {
      if (tickingRaStages) return;
      tickingRaStages = true;
      void runRaStageLifecycleSync()
        .then((result) => {
          if (
            result.resetToDraft > 0 ||
            result.closedByAuction > 0 ||
            result.published > 0 ||
            result.closed > 0
          ) {
            console.log(
              `RA Stages tick: resetToDraft=${result.resetToDraft} closedByAuction=${result.closedByAuction} published=${result.published} closed=${result.closed}`,
            );
          }
        })
        .catch((err) => console.error("RA Stages lifecycle tick failed", err))
        .finally(() => {
          tickingRaStages = false;
        });
    }, RA_STAGE_LIFECYCLE_TICK_MS);
  }

  {
    let importing = false;
    setInterval(() => {
      if (importing) return;
      importing = true;
      void additionalFieldsImportJobsService
        .tick()
        .then((result) => {
          if (result.processed > 0 || result.failed > 0) {
            console.log(
              `additional-fields import: ${result.processed} done, ${result.failed} failed`,
            );
          }
        })
        .catch((err) => console.error("additional-fields import tick failed", err))
        .finally(() => {
          importing = false;
        });
    }, ADDITIONAL_FIELDS_IMPORT_TICK_MS);
  }

  httpServer.listen(env.PORT, () => {
    console.log(`api listening on http://localhost:${env.PORT}`);
    void bootstrapPermissionCatalog()
      .then(() => console.log("permission catalog bootstrapped"))
      .catch((err) =>
        console.error("permission catalog bootstrap failed", err),
      );
  });
});
