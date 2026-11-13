import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

// Adds `.openapi()` to every Zod schema. Docs files import `z` from here (not
// from "zod") so the extension is installed before any `.openapi()` call runs.
extendZodWithOpenApi(z);

export { z };
