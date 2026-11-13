import { z } from "../zod.js";

// Mirrors the locationsService return types in services/locations.service.ts.

export const LocationCountries = z
  .object({ items: z.array(z.string()).openapi({ example: ["India"] }) })
  .openapi("LocationCountries");

export const LocationStates = z
  .object({ items: z.array(z.string()).openapi({ example: ["Maharashtra"] }) })
  .openapi("LocationStates");

export const LocationCities = z
  .object({
    items: z.array(
      z.object({
        id: z.number().int().openapi({ description: "Location id (one row per country/state/city)." }),
        city: z.string(),
      }),
    ),
  })
  .openapi("LocationCities");

export const LocationSearchItem = z
  .object({ id: z.number().int(), city: z.string(), state: z.string(), country: z.string() })
  .openapi("LocationSearchItem");

export const LocationSearchResult = z
  .object({ items: z.array(LocationSearchItem) })
  .openapi("LocationSearchResult");
