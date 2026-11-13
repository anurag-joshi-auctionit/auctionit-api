import { describe, expect, it } from "vitest";
import {
  buildAuctionDocumentFileName,
  buildCatalogueFileName,
  buildTncFileName,
} from "./auction-document-naming.js";

describe("auction-document-naming", () => {
  it("builds stable 1:1 names with auctionId before clientId", () => {
    expect(
      buildAuctionDocumentFileName({
        prefix: "catalogue_",
        auctionId: 123,
        clientId: 456,
        originalFileName: "upload.PDF",
      }),
    ).toBe("catalogue_123_456.pdf");
  });

  it("builds catalogue and tnc helpers the same way", () => {
    expect(
      buildCatalogueFileName({
        auctionId: 10,
        clientId: 20,
        originalFileName: "c.docx",
      }),
    ).toBe("catalogue_10_20.docx");
    expect(
      buildTncFileName({
        auctionId: 10,
        clientId: 20,
        originalFileName: "t.pdf",
      }),
    ).toBe("tnc_10_20.pdf");
  });
});
