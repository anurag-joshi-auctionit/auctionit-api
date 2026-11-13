const PRICE_SCALE = 2;
const RATE_SCALE = 6;

function toScaledBigInt(value: number | string, scale: number): bigint {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new RangeError(`Invalid decimal: ${value}`);
  const [whole, frac = ""] = n.toFixed(scale).split(".");
  const sign = whole!.startsWith("-") ? -1n : 1n;
  const digits = `${whole!.replace("-", "")}${frac.padEnd(scale, "0")}`;
  return sign * BigInt(digits);
}

function formatScaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, -scale);
  const frac = digits.slice(-scale);
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** Formats a rate the way it is stored (`numeric(18,6)`). */
export function formatRate(rate: number | string): string {
  return formatScaled(toScaledBigInt(rate, RATE_SCALE), RATE_SCALE);
}

/**
 * `round(price * rate, 2)` in exact decimal arithmetic, half away from zero —
 * the same result Postgres `round(numeric, 2)` gives for the backfill.
 */
export function convertToInr(price: number | string, rate: number | string): string {
  const cents = toScaledBigInt(price, PRICE_SCALE);
  const micros = toScaledBigInt(rate, RATE_SCALE);
  const product = cents * micros;
  const divisor = 10n ** BigInt(RATE_SCALE);
  const half = divisor / 2n;
  const rounded =
    product >= 0n
      ? (product + half) / divisor
      : -((-product + half) / divisor);
  return formatScaled(rounded, PRICE_SCALE);
}
