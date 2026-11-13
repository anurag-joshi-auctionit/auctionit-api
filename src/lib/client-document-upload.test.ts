import { describe, expect, it } from "vitest";
import {
  resolveClientDocumentStorage,
  resolveClientDocumentStorageFileName,
  resolveNewClientDocumentStorage,
} from "./client-document-upload.js";

describe("client-document-upload", () => {
  it("resolves overwrite-style storage names from type prefix and client id", () => {
    const resolved = resolveClientDocumentStorage({
      prefix: "agreement_",
      clientId: 5693,
      originalFileName: "Agreement_1268_2023111638090639077542288.pdf",
    });
    expect(resolved.storageFileName).toBe("agreement_5693.pdf");
    expect(resolved.s3Key).toBe("clients/agreement_5693.pdf");
  });

  it("resolves epoch-ms storage names for live uploads", () => {
    const at = new Date("2025-06-26T10:30:00.123Z");
    const resolved = resolveNewClientDocumentStorage({
      prefix: "agreement_",
      clientId: 42,
      originalFileName: "scan.pdf",
      at,
    });
    expect(resolved.storageFileName).toBe("agreement_42_1750933800123.pdf");
    expect(resolved.s3Key).toBe("clients/agreement_42_1750933800123.pdf");
  });

  it("resolves a canonical storage file name to R2 keys", () => {
    const resolved = resolveClientDocumentStorageFileName(
      "agreement_3136_1719398400123.pdf",
    );
    expect(resolved.storageFileName).toBe(
      "agreement_3136_1719398400123.pdf",
    );
    expect(resolved.s3Key).toBe("clients/agreement_3136_1719398400123.pdf");
  });
});
