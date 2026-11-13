import { z } from "zod";
import { env } from "../../env.js";

const singleRateSchema = z.object({
  base: z.string(),
  date: z.string(),
  rates: z.record(z.number().positive()),
});

const rangeRatesSchema = z.object({
  base: z.string(),
  rates: z.record(z.record(z.number().positive())),
});

export type FxRatePoint = { rateDate: string; rate: number };

export class FrankfurterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrankfurterError";
  }
}

async function getJson(path: string): Promise<unknown> {
  const url = `${env.FX_API_BASE_URL.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(env.FX_API_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new FrankfurterError(`Frankfurter ${res.status} for ${path}`);
  }
  return res.json();
}

/**
 * Rate for `date` (`YYYY-MM-DD`). ECB does not publish on weekends/holidays;
 * the API then answers with the previous business day, reflected in `rateDate`.
 */
export async function fetchRate(
  base: string,
  quote: string,
  date: string,
): Promise<FxRatePoint> {
  const body = singleRateSchema.parse(
    await getJson(`/${date}?base=${base}&symbols=${quote}`),
  );
  const rate = body.rates[quote];
  if (rate == null) {
    throw new FrankfurterError(`Frankfurter returned no ${quote} rate for ${date}`);
  }
  return { rateDate: body.date, rate };
}

/** Business-day rates between `from` and `to` inclusive, oldest first. */
export async function fetchRateRange(
  base: string,
  quote: string,
  from: string,
  to: string,
): Promise<FxRatePoint[]> {
  const body = rangeRatesSchema.parse(
    await getJson(`/${from}..${to}?base=${base}&symbols=${quote}`),
  );
  return Object.entries(body.rates)
    .flatMap(([rateDate, rates]) => {
      const rate = rates[quote];
      return rate == null ? [] : [{ rateDate, rate }];
    })
    .sort((a, b) => a.rateDate.localeCompare(b.rateDate));
}
