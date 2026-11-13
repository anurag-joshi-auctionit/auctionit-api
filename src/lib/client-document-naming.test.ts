import { describe, expect, it } from "vitest";
import {
  buildClientR2StorageFileName,
  buildNewClientDocumentFileName,
  clientDocumentEpochMs,
  clientDocumentFileNameHasPrefix,
  legacyClientDocumentTypePrefix,
} from "./client-document-naming.js";

describe("client-document-naming", () => {
  it("maps legacy document type ids to prefixes", () => {
    expect(legacyClientDocumentTypePrefix(1)).toBe("agreement_");
    expect(legacyClientDocumentTypePrefix(2)).toBe("tnc_");
    expect(legacyClientDocumentTypePrefix(99)).toBe("document_");
  });

  it("detects existing prefix", () => {
    expect(
      clientDocumentFileNameHasPrefix(
        "agreement_101_1782719623402.pdf",
        "agreement_",
      ),
    ).toBe(true);
    expect(
      clientDocumentFileNameHasPrefix("custom_101_1_123.jpg", "agreement_"),
    ).toBe(false);
  });

  it("builds R2 storage file names from type prefix and client id", () => {
    expect(
      buildClientR2StorageFileName({
        prefix: "agreement_",
        clientId: 42,
        originalFileName: "contract.PDF",
      }),
    ).toBe("agreement_42.pdf");
  });

  it("formats UTC epoch milliseconds as a numeric string", () => {
    const at = new Date("2025-06-26T10:30:00.123Z");
    expect(clientDocumentEpochMs(at)).toBe("1750933800123");
  });

  it("builds new upload file names with epoch-ms timestamp", () => {
    const at = new Date("2025-06-26T10:30:00.123Z");
    const name = buildNewClientDocumentFileName({
      prefix: "agreement_",
      clientId: 6059,
      originalFileName: "agreement.pdf",
      at,
    });
    expect(name).toBe("agreement_6059_1750933800123.pdf");
  });
});
