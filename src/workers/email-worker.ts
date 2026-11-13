import { env } from "../env.js";
import { enqueueAboutToStartNotifications } from "../services/auction-notification.service.js";
import { runWorkerTick } from "../services/email-dispatch.service.js";
import {
  enqueueDueReminders,
  getIstCalendarParts,
  SI_PAYMENT_REMINDER_HOUR_GATE,
} from "../services/service-invoice-payment-reminder.service.js";

let stopping = false;
let inFlight: Promise<unknown> | null = null;

const REMINDER_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let lastPaymentReminderSweepAtMs: number | null = null;

const ABOUT_TO_START_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
let lastAboutToStartSweepAtMs: number | null = null;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * At most once per hour after 10:00 IST: enqueue SI payment reminders.
 * Idempotent via per-day log dedupe inside enqueueDueReminders.
 */
async function maybeEnqueueServiceInvoicePaymentReminders(): Promise<void> {
  const now = new Date();
  const { hour } = getIstCalendarParts(now);
  if (hour < SI_PAYMENT_REMINDER_HOUR_GATE) {
    return;
  }

  const nowMs = now.getTime();
  if (
    lastPaymentReminderSweepAtMs != null &&
    nowMs - lastPaymentReminderSweepAtMs < REMINDER_SWEEP_INTERVAL_MS
  ) {
    return;
  }
  lastPaymentReminderSweepAtMs = nowMs;

  const { before, after } = await enqueueDueReminders(now);
  if (before > 0 || after > 0) {
    console.log(
      `email worker enqueued SI payment reminders: before-due=${before} after-due=${after}`,
    );
  }
}

/**
 * At most once per 10 minutes: enqueue auction about-to-start emails (NotificationId 3).
 * Idempotent via lifetime log dedupe inside enqueueAboutToStartNotifications.
 */
async function maybeEnqueueAuctionAboutToStart(): Promise<void> {
  const now = new Date();
  const nowMs = now.getTime();
  if (
    lastAboutToStartSweepAtMs != null &&
    nowMs - lastAboutToStartSweepAtMs < ABOUT_TO_START_SWEEP_INTERVAL_MS
  ) {
    return;
  }
  lastAboutToStartSweepAtMs = nowMs;

  const count = await enqueueAboutToStartNotifications(now);
  if (count > 0) {
    console.log(
      `email worker enqueued auction about-to-start emails: ${count}`,
    );
  }
}

async function loop(): Promise<void> {
  console.log(
    `email worker starting (batch=${env.EMAIL_WORKER_BATCH_SIZE}, rate=${env.EMAIL_RATE_PER_SECOND}/s, idle=${env.EMAIL_WORKER_IDLE_MS}ms)`,
  );

  while (!stopping) {
    try {
      try {
        await maybeEnqueueServiceInvoicePaymentReminders();
      } catch (err) {
        console.error("email worker SI payment reminder sweep failed", err);
      }

      try {
        await maybeEnqueueAuctionAboutToStart();
      } catch (err) {
        console.error("email worker auction about-to-start sweep failed", err);
      }

      const tick = runWorkerTick();
      inFlight = tick;
      const processed = await tick;
      inFlight = null;
      if (processed === 0) {
        await sleep(env.EMAIL_WORKER_IDLE_MS);
      }
    } catch (err) {
      inFlight = null;
      console.error("email worker tick failed", err);
      await sleep(env.EMAIL_WORKER_IDLE_MS);
    }
  }

  if (inFlight) {
    console.log("email worker draining in-flight batch…");
    try {
      await inFlight;
    } catch (err) {
      console.error("email worker drain failed", err);
    }
  }
  console.log("email worker stopped");
}

function requestStop(signal: string): void {
  if (stopping) return;
  console.log(`email worker received ${signal}, shutting down…`);
  stopping = true;
}

process.on("SIGTERM", () => requestStop("SIGTERM"));
process.on("SIGINT", () => requestStop("SIGINT"));

loop().catch((err) => {
  console.error("email worker crashed", err);
  process.exit(1);
});
