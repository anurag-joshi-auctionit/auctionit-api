import { paginated } from "../../common.js";
import { z } from "../../zod.js";
import { masterBenchmarkEntity } from "./shared.js";

// Mirrors BenchmarkMaterialMasterDto / MasterListResult in services/masters/benchmark-materials.service.ts.

export const MasterBenchmarkMaterial = masterBenchmarkEntity("MasterBenchmarkMaterial");

export const MasterBenchmarkMaterialList = paginated(MasterBenchmarkMaterial).openapi("MasterBenchmarkMaterialList");

export const MasterBenchmarkMaterialOptions = z
  .array(MasterBenchmarkMaterial)
  .openapi({ description: "Active rows only, ordered by name." });
