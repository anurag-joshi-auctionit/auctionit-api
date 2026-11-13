import { describe, expect, it } from "vitest";
import {
  bidderDocumentEpochMs,
  BIDDER_DOCUMENT_TYPE_CANCELLED_CHEQUE,
  buildBidderR2StorageFileName,
  buildNewBidderDocumentFileName,
  bidderDocumentFileNameHasPrefix,
  legacyBidderDocumentTypePrefix,
  pendingCancelledChequeToLiveFileName,
} from "./bidder-document-naming.js";

describe("bidder-document-naming", () => {
  it("maps legacy document type ids to prefixes", () => {
    expect(legacyBidderDocumentTypePrefix(1)).toBe("pan_card_");
    expect(legacyBidderDocumentTypePrefix(4)).toBe("cancelled_cheque_");
    expect(BIDDER_DOCUMENT_TYPE_CANCELLED_CHEQUE).toBe(4);
  });

  it("detects existing prefix", () => {
    expect(
      bidderDocumentFileNameHasPrefix(
        "pan_card_101_1782719623402.jpeg",
        "pan_card_",
      ),
    ).toBe(true);
    expect(
      bidderDocumentFileNameHasPrefix("custom_101_1_123.jpg", "pan_card_"),
    ).toBe(false);
  });

  it("builds R2 storage file names from type prefix and bidder id", () => {
    expect(
      buildBidderR2StorageFileName({
        prefix: "cancelled_cheque_",
        bidderId: 42,
        originalFileName: "cheque.JPG",
      }),
    ).toBe("cancelled_cheque_42.jpg");
  });

  it("formats UTC epoch milliseconds as a numeric string", () => {
    const at = new Date("2025-06-26T10:30:00.123Z");
    expect(bidderDocumentEpochMs(at)).toBe("1750933800123");
  });

  it("builds new upload file names with epoch-ms timestamp", () => {
    const at = new Date("2025-06-26T10:30:00.123Z");
    const name = buildNewBidderDocumentFileName({
      prefix: "excel_",
      bidderId: 6059,
      originalFileName: "report.xls",
      at,
    });
    expect(name).toBe("excel_6059_1750933800123.xls");
  });

  it("renames pending cancelled-cheque files to the live prefix", () => {
    expect(
      pendingCancelledChequeToLiveFileName(
        "cancelled_cheque_pending_42_1750933800123.jpg",
      ),
    ).toBe("cancelled_cheque_42_1750933800123.jpg");
    expect(
      pendingCancelledChequeToLiveFileName("cancelled_cheque_42_1.jpg"),
    ).toBe("cancelled_cheque_42_1.jpg");
  });
});
