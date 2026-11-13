import pino from "pino";
import { env } from "../env.js";

/**
 * Shared structured logger for use outside a request (services, workers,
 * tickers). Request handlers should prefer `req.log` (a child logger with the
 * request id already attached, from the `pino-http` middleware in index.ts)
 * so their log lines correlate with the request that produced them.
 */
export const logger = pino({
  level: env.LOG_LEVEL ?? (env.NODE_ENV === "production" ? "info" : "debug"),
  transport:
    env.NODE_ENV === "production"
      ? undefined
      : {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" },
        },
});
