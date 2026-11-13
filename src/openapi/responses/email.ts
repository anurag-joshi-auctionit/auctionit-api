import { z } from "../zod.js";

// Shape built in src/routes/email.ts from emailService.enqueue() → { id }.

export const EmailQueued = z
  .object({
    ok: z.literal(true),
    id: z.number().int().openapi({ description: "Id of the queued email row." }),
    status: z.literal("queued"),
  })
  .openapi("EmailQueued");
