import { describe, expect, it } from "vitest";
import {
  resolveBidderDocumentStorage,
  resolveBidderDocumentStorageFileName,
  resolveNewBidderDocumentStorage,
} from "./bidder-document-upload.js";

describe("bidder-document-upload", () => {
  it("resolves overwrite-style storage names from type prefix and bidder id", () => {
    const resolved = resolveBidderDocumentStorage({
      prefix: "pan_card_",
      bidderId: 5693,
      originalFileName: "PANCard_1268_2023111638090639077542288.jpg",
    });
    expect(resolved.storageFileName).toBe("pan_card_5693.jpg");
    expect(resolved.s3Key).toBe("bidders/pan_card_5693.jpg");
  });

  it("resolves epoch-ms storage names for live uploads", () => {
    const at = new Date("2025-06-26T10:30:00.123Z");
    const resolved = resolveNewBidderDocumentStorage({
      prefix: "gstin_",
      bidderId: 42,
      originalFileName: "scan.pdf",
      at,
    });
    expect(resolved.storageFileName).toBe("gstin_42_1750933800123.pdf");
    expect(resolved.s3Key).toBe("bidders/gstin_42_1750933800123.pdf");
  });

  it("resolves a canonical storage file name to R2 keys", () => {
    const resolved = resolveBidderDocumentStorageFileName(
      "cancelled_cheque_3136_1719398400123.jpg",
    );
    expect(resolved.storageFileName).toBe(
      "cancelled_cheque_3136_1719398400123.jpg",
    );
    expect(resolved.s3Key).toBe(
      "bidders/cancelled_cheque_3136_1719398400123.jpg",
    );
  });
});
