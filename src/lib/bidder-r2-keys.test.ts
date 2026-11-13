import { describe, expect, it } from "vitest";
import { buildBidderR2StorageFileName } from "./bidder-document-naming.js";
import {
  bidderR2ObjectKey,
  bidderR2ObjectKeyForDocument,
  contentTypeForBidderFileName,
  isAllowedBidderDocumentExtension,
} from "./bidder-r2-keys.js";

describe("bidder-r2-keys", () => {
  it("builds storage names as {prefix}{bidderId}.{ext}", () => {
    expect(
      buildBidderR2StorageFileName({
        prefix: "pan_card_",
        bidderId: 101,
        originalFileName: "PANCard_101_202228637799542853414515.jpeg",
      }),
    ).toBe("pan_card_101.jpeg");
  });

  it("maps storage names to flat bidders/ keys", () => {
    expect(bidderR2ObjectKey("cancelled_cheque_42.pdf")).toBe(
      "bidders/cancelled_cheque_42.pdf",
    );
    expect(
      bidderR2ObjectKeyForDocument({
        prefix: "gstin_",
        bidderId: 55,
        originalFileName: "scan.PDF",
      }),
    ).toBe("bidders/gstin_55.pdf");
  });

  it("maps content types from extension", () => {
    expect(contentTypeForBidderFileName("doc.pdf")).toBe("application/pdf");
    expect(contentTypeForBidderFileName("scan.jpg")).toBe("image/jpeg");
  });

  it("allows document and image extensions only", () => {
    expect(isAllowedBidderDocumentExtension("scan.pdf")).toBe(true);
    expect(isAllowedBidderDocumentExtension("photo.JPEG")).toBe(true);
    expect(isAllowedBidderDocumentExtension("sheet.xlsx")).toBe(true);
    expect(isAllowedBidderDocumentExtension("clip.mp4")).toBe(false);
    expect(isAllowedBidderDocumentExtension("archive.zip")).toBe(false);
    expect(isAllowedBidderDocumentExtension("noext")).toBe(false);
  });
});
