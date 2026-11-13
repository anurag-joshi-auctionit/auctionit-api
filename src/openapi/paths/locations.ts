import { z } from "zod";
import { documentRouter } from "../define.js";
import {
  LocationCities,
  LocationCountries,
  LocationSearchResult,
  LocationStates,
} from "../responses/locations.js";

// Docs for src/routes/locations.ts — see docs/api/README.md.
const r = documentRouter("/locations");

// Query schemas below are defined inline in routes/locations.ts.

r.get("/countries", {
  summary: "List countries",
  description: "Distinct countries in the locations master, alphabetical.",
  responses: { 200: LocationCountries },
});

r.get("/states", {
  summary: "List states of a country",
  description: "Distinct states for an exact `country` match, alphabetical.",
  query: z.object({ country: z.string().trim().min(1) }),
  responses: { 200: LocationStates },
});

r.get("/cities", {
  summary: "List cities of a state",
  description: "Cities (with their location id) for an exact `country` + `state` match, alphabetical.",
  query: z.object({ country: z.string().trim().min(1), state: z.string().trim().min(1) }),
  responses: { 200: LocationCities },
});

r.get("/search", {
  summary: "Search locations",
  description:
    "Case-insensitive substring match on city, state or country, ordered by city/state/country. An empty `q` returns no rows.",
  query: z.object({
    q: z.string().trim().optional().default(""),
    limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  }),
  responses: { 200: LocationSearchResult },
});
