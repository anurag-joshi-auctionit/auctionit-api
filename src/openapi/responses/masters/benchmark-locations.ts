import { paginated } from "../../common.js";
import { z } from "../../zod.js";
import { masterBenchmarkEntity } from "./shared.js";

// Mirrors BenchmarkLocationMasterDto / MasterListResult in services/masters/benchmark-locations.service.ts.

export const MasterBenchmarkLocation = masterBenchmarkEntity("MasterBenchmarkLocation");

export const MasterBenchmarkLocationList = paginated(MasterBenchmarkLocation).openapi("MasterBenchmarkLocationList");

export const MasterBenchmarkLocationOptions = z
  .array(MasterBenchmarkLocation)
  .openapi({ description: "Active rows only, ordered by name." });
