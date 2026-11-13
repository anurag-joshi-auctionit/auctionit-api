import { describe, expect, it } from "vitest";
import {
  buildLotConfirmationPdfFilename,
  buildLotConfirmationPdfS3Key,
  LOT_CONFIRMATION_R2_FOLDER,
} from "./lot-confirmation-r2-keys.js";

describe("lot confirmation R2 keys", () => {
  it("uses a stable bidder-and-auction key under auctions/lot-confirmations", () => {
    expect(
      buildLotConfirmationPdfFilename({ bidderId: 12, auctionId: 88 }),
    ).toBe("lot-confirmation-letter-12-88.pdf");
    expect(buildLotConfirmationPdfS3Key({ bidderId: 12, auctionId: 88 })).toBe(
      `${LOT_CONFIRMATION_R2_FOLDER}/lot-confirmation-letter-12-88.pdf`,
    );
    expect(LOT_CONFIRMATION_R2_FOLDER).toBe("auctions/lot-confirmations");
  });
});
