import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.local", override: true });
import { z } from "zod";

const boolFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : v.toLowerCase() === "true"));

const schema = z.object({
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (v) => v.startsWith("postgres://") || v.startsWith("postgresql://"),
      { message: "DATABASE_URL must start with postgres:// or postgresql://" }
    ),
  PORT: z.coerce.number().default(4000),
  API_PREFIX: z.string().default("/api/v1"),
  CORS_ORIGINS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  NODE_ENV: z
    .enum(["development", "local", "staging", "production", "test"])
    .default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .optional(),
  // When false, password login issues a full session without email/SMS OTP.
  AUTH_2FA_ENABLED: boolFromEnv.default(true),
  // When true, every SQL query (with params) is logged to the console.
  DB_LOG_SQL: boolFromEnv.default(false),
  MSSQL_SERVER: z.string().optional(),
  MSSQL_PORT: z.coerce.number().default(1433),
  MSSQL_USER: z.string().optional(),
  MSSQL_PASSWORD: z.string().optional(),
  MSSQL_DATABASE: z.string().optional(),
  MSSQL_ENCRYPT: boolFromEnv.default(false),
  MSSQL_TRUST_SERVER_CERTIFICATE: boolFromEnv.default(true),

  R2_ACCOUNT_ID: z.string().default("f7b039f77ae0978c85ff11d1b0d13243"),
  // Per-environment bucket: auctionit-local (dev) / auctionit-staging (staging).
  R2_BUCKET: z.string().default("auctionit-local"),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),

  SMS_API_URL: z
    .string()
    .url()
    .default("https://bulksms.analyticsmantra.com/sendsms/sendsms.php"),
  SMS_USERNAME: z.string().default("jintel"),
  SMS_PASSWORD: z.string().default("welcome1"),
  SMS_TYPE: z.string().default("TEXT"),
  SMS_SENDER: z.string().default("JIAUCT"),
  // DLT (TRAI) compliance params — required by the Indian gateway for delivery.
  SMS_DLT_PEID: z.string().default("1101616050000022954"),
  SMS_DLT_HEADER_ID: z.string().default("1205160327544676712"),
  // The gateway returns HTTP 200 even on failure; success means this token
  // appears in the response body.
  SMS_SUCCESS_TOKEN: z.string().default("SUBMIT_SUCCESS"),
  // Prefixed to bare 10-digit numbers (gateway expects country code, e.g. 91).
  SMS_COUNTRY_CODE: z.string().default("91"),

  // Email transport: SendGrid when SENDGRID_API_KEY is set; otherwise SMTP.
  SENDGRID_API_KEY: z.string().optional(),
  SENDGRID_FROM_EMAIL: z.string().email().default("noreply@auctionit.in"),
  SENDGRID_FROM_NAME: z.string().default("AuctionIt"),
  EMAIL_HOST: z.string().default("mail.auctionit.in"),
  EMAIL_PORT: z.coerce.number().default(25),
  EMAIL_SECURE: boolFromEnv.default(false),
  EMAIL_USERNAME: z.string().default("auction-01@auctionit.in"),
  // Required for SMTP path — no default (avoid shipping credentials in repo).
  EMAIL_PASSWORD: z.string().optional(),
  EMAIL_FROM_NAME: z.string().default("AuctionIt"),
  // Email outbox / worker.
  EMAIL_DISPATCH_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  EMAIL_DISPATCH_CONCURRENCY: z.coerce.number().int().min(1).default(5),
  EMAIL_RATE_PER_SECOND: z.coerce.number().int().min(1).default(10),
  EMAIL_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).default(50),
  EMAIL_WORKER_IDLE_MS: z.coerce.number().int().min(100).default(5_000),
  EMAIL_RETRY_BASE_MS: z.coerce.number().int().min(1_000).default(30_000),
  EMAIL_RETRY_MAX_MS: z.coerce.number().int().min(1_000).default(900_000),
  EMAIL_STUCK_RECLAIM_MS: z.coerce.number().int().min(10_000).default(300_000),

  // AES-256-GCM for bank account fields at rest (base64-encoded 32 bytes).
  SENSITIVE_DATA_ENCRYPTION_KEY: z.string().optional(),

  // Legacy AuctionIT 5.0 — TripleDES bank fields used when seeding from MSSQL.
  LEGACY_BANK_ENCRYPTION_KEY: z.string().default("MyComplexKey"),
  // TempBidderInfo — plain registration uploads for seed:bidder-documents.
  LEGACY_BIDDER_TEMP_INFO_PATH: z.string().optional(),
  // Legacy InvoiceAnnexure folder (UploadedFiles/InvoiceAnnexure) for seed:service-invoice-documents.
  LEGACY_SERVICE_INVOICE_ANNEXURE_DIR: z.string().optional(),
  // Legacy generated PDF folder (PdfInvoiceFiles/ServiceInvoiceInfo) for seed:service-invoice-documents.
  LEGACY_SERVICE_INVOICE_PDF_DIR: z.string().optional(),
  // Legacy subscription invoice PDFs (PdfInvoiceFiles/PaymentInfoReport) for seed:subscription-documents.
  LEGACY_SUBSCRIPTION_INVOICE_PDF_DIR: z.string().optional(),

  // Instamojo v2 (OAuth2 client_credentials) for bidder self-service
  // subscription payments. Defaults target the sandbox; set INSTAMOJO_ENABLED
  // and real credentials to go live. When disabled, the pay endpoints return 503.
  INSTAMOJO_ENABLED: boolFromEnv.default(false),
  INSTAMOJO_CLIENT_ID: z.string().optional(),
  INSTAMOJO_CLIENT_SECRET: z.string().optional(),
  INSTAMOJO_AUTH_URL: z
    .string()
    .url()
    .default("https://test.instamojo.com/oauth2/token/"),
  INSTAMOJO_API_URL: z.string().url().default("https://test.instamojo.com/v2/"),
  // Base URL of the external portal app, used to build the Instamojo redirect_url.
  APP_BASE_URL: z.string().url().default("http://localhost:3002"),

  // No-bid extension engine. Lead + tick are code constants (see
  // no-bid-extension.ts). This flag only parks the loop.
  NO_BID_EXTENSION_ENABLED: boolFromEnv.default(true),

  // EMD settlement worker (close / cancel / withdraw jobs in emd_settlement_jobs).
  EMD_SETTLEMENT_ENABLED: boolFromEnv.default(true),
  EMD_SETTLEMENT_BATCH: z.coerce.number().int().min(1).max(5_000).default(500),
  EMD_SETTLEMENT_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  EMD_SETTLEMENT_STUCK_MS: z.coerce.number().int().min(60_000).default(600_000),

  // Postgres pool — sized for live-auction concurrency (bids + snapshots).
  DB_POOL_MAX: z.coerce.number().int().min(2).default(20),
  DB_POOL_IDLE_MS: z.coerce.number().int().min(1_000).default(10_000),
  DB_POOL_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(5_000),
  // Per-statement timeout applied via SET on each new connection (ms).
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(30_000),

  // Behind nginx / a load balancer so req.ip reflects the real client.
  TRUST_PROXY: boolFromEnv.default(false),

  // Swagger UI at /docs and the raw spec at /openapi.json. Unset → on outside
  // production, off in production. When on in production, admin login is required.
  API_DOCS_ENABLED: boolFromEnv.optional(),

  // Socket.IO Redis adapter for multi-instance broadcasts. When unset, the
  // in-memory adapter is used (single-process only).
  REDIS_URL: z.string().url().optional(),
  // Force websocket-only when the reverse proxy supports Upgrade; default still
  // allows polling→websocket upgrade for local/dev.
  SOCKET_TRANSPORTS: z
    .string()
    .default("polling,websocket")
    .transform((s) =>
      s
        .split(",")
        .map((t) => t.trim())
        .filter((t): t is "polling" | "websocket" =>
          t === "polling" || t === "websocket",
        ),
    ),

  // Startup default for the live push transport. Admins can override it at
  // runtime (persisted in Redis when REDIS_URL is set, otherwise per-process).
  //   auto   — clients prefer Socket.IO and fail over to SSE, then polling
  //   socket — Socket.IO only
  //   sse    — SSE only (kill switch when a proxy breaks the WS upgrade)
  //   poll   — REST snapshot polling only (last resort)
  LIVE_TRANSPORT_MODE: z
    .enum(["auto", "socket", "sse", "poll"])
    .default("auto"),
  // Master switch for the SSE fallback channel. When false, /live/stream is
  // refused and clients fall straight through from Socket.IO to polling.
  LIVE_SSE_ENABLED: boolFromEnv.default(true),
  // Keep-alive comment cadence. Must stay below the shortest idle timeout of
  // any proxy in front of the API or streams get cut mid-auction.
  LIVE_SSE_HEARTBEAT_MS: z.coerce.number().int().min(1_000).default(15_000),
  // Per-process cap on open SSE streams (each holds a socket + response).
  LIVE_SSE_MAX_CLIENTS: z.coerce.number().int().min(1).default(2_000),
  // `retry:` hint written to each stream — how long EventSource waits before
  // reconnecting on its own.
  LIVE_SSE_RETRY_MS: z.coerce.number().int().min(500).default(3_000),
  // Client failover thresholds, served via GET /live/transport so they can be
  // tuned without rebuilding the apps.
  LIVE_FAILOVER_CONNECT_MS: z.coerce.number().int().min(1_000).default(8_000),
  LIVE_FAILOVER_SILENCE_MS: z.coerce.number().int().min(5_000).default(30_000),
  LIVE_POLL_INTERVAL_MS: z.coerce.number().int().min(2_000).default(10_000),

  // Live engine timers / refresh coalescing.
  LIVE_RESYNC_MS: z.coerce.number().int().min(1_000).default(15_000),
  LIVE_RESYNC_CONCURRENCY: z.coerce.number().int().min(1).default(3),
  LIVE_REFRESH_MIN_INTERVAL_MS: z.coerce.number().int().min(250).default(2_000),

  // Frankfurter (ECB reference rates, no API key) for converting non-INR
  // benchmark prices to INR.
  FX_API_BASE_URL: z.string().url().default("https://api.frankfurter.dev/v1"),
  FX_API_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(10_000),
  // When the FX API is unreachable, reuse a cached rate at most this many days old.
  FX_RATE_MAX_STALENESS_DAYS: z.coerce.number().int().min(0).default(7),

  /** Optional login name for the seeded owner (must be an admin user). */
  SEED_OWNER_LOGIN: z.string().optional(),
  /**
   * Comma-separated emails for seeded owners (admin role required).
   * Used when SEED_OWNER_LOGIN is unset. Defaults to AuctionIT principals.
   */
  SEED_OWNER_EMAILS: z
    .string()
    .default("anurag.joshi@auctionit.in")
    .transform((s) =>
      s
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
});

export const env = schema.parse(process.env);
