import { ClientsValidationMessages } from "@auctionit/messages/clients";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { zodValidationErrorBody } from "./validation-error.js";

describe("zodValidationErrorBody", () => {
  it("maps Zod issue paths to dot-joined fieldErrors keys", () => {
    const schema = z.object({
      companyInfo: z.object({
        pan: z.string().min(1, ClientsValidationMessages.INVALID_PAN),
      }),
      plantLocations: z.array(
        z.object({
          kamId: z.number().int().positive(ClientsValidationMessages.KAM_REQUIRED),
        }),
      ),
    });

    const parsed = schema.safeParse({
      companyInfo: { pan: "" },
      plantLocations: [{ kamId: 0 }],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const body = zodValidationErrorBody(parsed.error);
      expect(body.error).toBe(ClientsValidationMessages.VALIDATION_FAILED);
      expect(body.fieldErrors["companyInfo.pan"]).toContain(
        ClientsValidationMessages.INVALID_PAN,
      );
      expect(body.fieldErrors["plantLocations.0.kamId"]).toContain(
        ClientsValidationMessages.KAM_REQUIRED,
      );
    }
  });
});
