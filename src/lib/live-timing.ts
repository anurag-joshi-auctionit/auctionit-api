/**
 * Lightweight timing for live-engine hot paths. Emits structured logs when a
 * call exceeds `warnMs` so pool starvation / slow snapshots show up in logs
 * without needing a full APM stack.
 */

export async function timedLive<T>(
  label: string,
  fn: () => Promise<T>,
  warnMs = 100,
): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const ms = performance.now() - start;
    if (ms >= warnMs) {
      console.warn(
        JSON.stringify({
          scope: "live",
          label,
          ms: Math.round(ms * 100) / 100,
        }),
      );
    }
  }
}
