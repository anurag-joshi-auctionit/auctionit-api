import type pg from "pg";

export const DEFAULT_COUNTRY = "India";

export function asString(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export function normalizeState(v: string | null): string | null {
  const s = asString(v);
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower === "odisha") return "Orissa";
  if (lower === "nct of delhi" || lower === "delhi ncr") return "Delhi";
  return s;
}

export function normalizeCity(v: string | null): string | null {
  return asString(v);
}

export function normalizeCountry(v: string | null): string {
  return asString(v) ?? DEFAULT_COUNTRY;
}

export function locationKey(
  country: string,
  state: string,
  city: string,
): string {
  return `${country.trim().toLowerCase()}|${state.trim().toLowerCase()}|${city.trim().toLowerCase()}`;
}

export function locationIdSubquery(
  countryParam: string,
  stateParam: string,
  cityParam: string,
): string {
  return `(
    SELECT id FROM locations
    WHERE lower(trim(country)) = lower(trim(COALESCE(NULLIF(${countryParam}, ''), '${DEFAULT_COUNTRY}')))
      AND lower(trim(state)) = lower(trim(${stateParam}))
      AND lower(trim(city)) = lower(trim(${cityParam}))
  )`;
}

export async function loadLocationLookupMap(
  pool: pg.Pool,
): Promise<Map<string, number>> {
  const res = await pool.query<{
    id: number;
    country: string;
    state: string;
    city: string;
  }>("SELECT id, country, state, city FROM locations");

  const map = new Map<string, number>();
  for (const row of res.rows) {
    map.set(locationKey(row.country, row.state, row.city), row.id);
  }
  return map;
}

export function resolveLocationId(
  map: Map<string, number>,
  country: string | null,
  state: string | null,
  city: string | null,
): {
  locationId: number | null;
  country: string;
  state: string | null;
  city: string | null;
} {
  const normalizedCountry = normalizeCountry(country);
  const normalizedState = normalizeState(state);
  const normalizedCity = normalizeCity(city);

  if (!normalizedState || !normalizedCity) {
    return {
      locationId: null,
      country: normalizedCountry,
      state: normalizedState,
      city: normalizedCity,
    };
  }

  const locationId =
    map.get(locationKey(normalizedCountry, normalizedState, normalizedCity)) ??
    null;

  return {
    locationId,
    country: normalizedCountry,
    state: normalizedState,
    city: normalizedCity,
  };
}

export function normalizePincode(v: string | null): string | null {
  const s = asString(v);
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  return digits.length === 6 ? digits : null;
}

function normalizeTaxId(v: string | null): string | null {
  const s = asString(v);
  return s ? s.toUpperCase() : null;
}

export function normalizePan(v: string | null): string | null {
  const s = normalizeTaxId(v);
  return s && /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(s) ? s : null;
}

export function normalizeGstin(v: string | null): string | null {
  const s = normalizeTaxId(v);
  return s && /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(s)
    ? s
    : null;
}

export function normalizeTan(v: string | null): string | null {
  const s = normalizeTaxId(v);
  return s && /^[A-Z]{4}[0-9]{5}[A-Z]$/.test(s) ? s : null;
}

import {
  isValidServiceFeeNumber,
  type ServiceFeeType,
} from "@auctionit/messages/clients";

/** Null/0 → fixed 0; valid percentage → service_percentage; else invalid. */
export function resolveSeedServiceFee(
  v: number | string | null,
): { type: ServiceFeeType; value: number } | null {
  if (v == null) {
    return { type: "fixed_amount", value: 0 };
  }
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n === 0) {
    return { type: "fixed_amount", value: 0 };
  }
  return isValidServiceFeeNumber(n)
    ? { type: "service_percentage", value: n }
    : null;
}
