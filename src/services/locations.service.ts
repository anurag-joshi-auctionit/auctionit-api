import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { locations } from "../db/schema/locations.js";

export class LocationsService {
  async listCountries(): Promise<string[]> {
    const rows = await db
      .selectDistinct({ country: locations.country })
      .from(locations)
      .orderBy(asc(locations.country));
    return rows.map((r) => r.country);
  }

  async listStates(country: string): Promise<string[]> {
    const rows = await db
      .selectDistinct({ state: locations.state })
      .from(locations)
      .where(eq(locations.country, country.trim()))
      .orderBy(asc(locations.state));
    return rows.map((r) => r.state);
  }

  async listCities(
    country: string,
    state: string,
  ): Promise<Array<{ id: number; city: string }>> {
    const rows = await db
      .select({ id: locations.id, city: locations.city })
      .from(locations)
      .where(
        and(
          eq(locations.country, country.trim()),
          eq(locations.state, state.trim()),
        ),
      )
      .orderBy(asc(locations.city));
    return rows;
  }

  async search(
    query: string,
    limit = 50,
  ): Promise<
    Array<{ id: number; city: string; state: string; country: string }>
  > {
    const q = query.trim();
    if (!q) return [];

    const pattern = `%${q}%`;
    const rows = await db
      .select({
        id: locations.id,
        city: locations.city,
        state: locations.state,
        country: locations.country,
      })
      .from(locations)
      .where(
        or(
          ilike(locations.city, pattern),
          ilike(locations.state, pattern),
          ilike(locations.country, pattern),
        ),
      )
      .orderBy(asc(locations.city), asc(locations.state), asc(locations.country))
      .limit(limit);
    return rows;
  }

  async getById(id: number) {
    const [row] = await db
      .select()
      .from(locations)
      .where(eq(locations.id, id))
      .limit(1);
    return row ?? null;
  }

  async findIdByPlace(
    country: string,
    state: string,
    city: string,
  ): Promise<number | null> {
    const [row] = await db
      .select({ id: locations.id })
      .from(locations)
      .where(
        and(
          sql`lower(trim(${locations.country})) = lower(trim(${country}))`,
          sql`lower(trim(${locations.state})) = lower(trim(${state}))`,
          sql`lower(trim(${locations.city})) = lower(trim(${city}))`,
        ),
      )
      .limit(1);
    return row?.id ?? null;
  }
}

export const locationsService = new LocationsService();
