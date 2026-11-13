import { AuctionsValidationMessages } from "@auctionit/messages/auctions";
import { describe, expect, it } from "vitest";
import {
  createAuctionSchema,
  lotCorrectionSchema,
  patchAuctionSchema,
  reopenLotsCorrectionSchema,
} from "./schemas.js";

const createBase = {
  clientId: 1,
  auctionNumber: "A-1",
  auctionType: "Forward",
  emdAmount: null,
  auctionDate: "2026-08-21",
  publishedAt: "2026-08-21T10:00:00.000Z",
  isNoBidExtension: false,
  isStartBidPricePlusIncrement: false,
  isSealedBid: false,
  ipAddressRestrictionEnabled: false,
  isRankBased: false,
};

describe("lotCorrectionSchema update_lot", () => {
  it("accepts a full valid update", () => {
    expect(
      lotCorrectionSchema.safeParse({
        type: "update_lot",
        winnerBidderId: 10,
        winningAmount: 100,
        quantity: 1.5,
      }).success,
    ).toBe(true);
  });

  it("accepts omitted optional fields", () => {
    expect(
      lotCorrectionSchema.safeParse({ type: "update_lot" }).success,
    ).toBe(true);
  });

  it("rejects zero winnerBidderId with required message", () => {
    const parsed = lotCorrectionSchema.safeParse({
      type: "update_lot",
      winnerBidderId: 0,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message)).toContain(
        AuctionsValidationMessages.WINNER_BIDDER_REQUIRED,
      );
    }
  });

  it("accepts zero winningAmount for service-level bid validation", () => {
    expect(
      lotCorrectionSchema.safeParse({
        type: "update_lot",
        winningAmount: 0,
      }).success,
    ).toBe(true);
  });

  it("accepts zero quantity for service-level validation", () => {
    expect(
      lotCorrectionSchema.safeParse({
        type: "update_lot",
        winningAmount: 0,
        quantity: 0,
      }).success,
    ).toBe(true);
  });
});

describe("createAuctionSchema no-bid extension pair", () => {
  it("accepts both zero", () => {
    expect(
      createAuctionSchema.safeParse({
        ...createBase,
        noBidExtensionCountMax: 0,
        noBidExtensionInterval: 0,
      }).success,
    ).toBe(true);
  });

  it("rejects mixed zero and non-zero", () => {
    const parsed = createAuctionSchema.safeParse({
      ...createBase,
      noBidExtensionCountMax: 0,
      noBidExtensionInterval: 10,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message)).toContain(
        AuctionsValidationMessages.AUTO_INCREMENT_PAIR,
      );
    }
  });
});

describe("patchAuctionSchema no-bid extension pair", () => {
  it("rejects when only one of the pair is sent", () => {
    const parsed = patchAuctionSchema.safeParse({
      noBidExtensionCountMax: 3,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message)).toContain(
        AuctionsValidationMessages.AUTO_INCREMENT_PAIR,
      );
    }
  });

  it("accepts a valid pair", () => {
    expect(
      patchAuctionSchema.safeParse({
        noBidExtensionCountMax: 3,
        noBidExtensionInterval: 5,
      }).success,
    ).toBe(true);
  });

  it("rejects clientId — client is immutable after create", () => {
    const parsed = patchAuctionSchema.safeParse({
      clientId: 99,
      isRankBased: true,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message)).toContain(
        AuctionsValidationMessages.CLIENT_CANNOT_CHANGE,
      );
    }
  });
});

describe("reopenLotsCorrectionSchema pricing rules", () => {
  const reopenBase = {
    lots: [
      {
        lotId: 1,
        lotEndTime: "15:00:00",
        lotNumber: "L1",
        bidIncrement: 10,
        quantity: 0,
        uomCode: "MT",
      },
    ],
  };

  it("accepts zero quantity", () => {
    expect(reopenLotsCorrectionSchema.safeParse(reopenBase).success).toBe(true);
  });

  it("strips stagger / no-bid settings — reopened lots ignore them", () => {
    const parsed = reopenLotsCorrectionSchema.safeParse({
      ...reopenBase,
      isStaggered: true,
      noBidExtensionCountMax: 3,
      noBidExtensionInterval: 0,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data)).toEqual(["lots"]);
    }
  });

  it("rejects an empty lots list", () => {
    const parsed = reopenLotsCorrectionSchema.safeParse({ lots: [] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message)).toContain(
        AuctionsValidationMessages.REOPEN_LOTS_REQUIRED,
      );
    }
  });

  it("rejects zero bidIncrement", () => {
    const parsed = reopenLotsCorrectionSchema.safeParse({
      ...reopenBase,
      lots: [{ ...reopenBase.lots[0]!, bidIncrement: 0 }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects zero startBidPrice when provided", () => {
    const parsed = reopenLotsCorrectionSchema.safeParse({
      ...reopenBase,
      lots: [{ ...reopenBase.lots[0]!, startBidPrice: 0 }],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some(
          (i) =>
            i.message ===
            AuctionsValidationMessages.START_BID_PRICE_MUST_BE_POSITIVE,
        ),
      ).toBe(true);
    }
  });
});

describe("createAuctionSchema / patchAuctionSchema sealed-bid window", () => {
  const sealedBase = {
    ...createBase,
    noBidExtensionCountMax: 0,
    noBidExtensionInterval: 0,
    isSealedBid: true,
    sealedBidDate: "2026-08-21T00:00:00.000Z",
    sealedBidStartTime: "10:00",
    sealedBidEndTime: "14:30",
  };

  function messages(r: { success: boolean; error?: { issues: { message: string }[] } }) {
    return r.success ? [] : r.error!.issues.map((i) => i.message);
  }

  it("accepts a full window and normalizes HH:mm to HH:mm:ss", () => {
    const parsed = createAuctionSchema.safeParse(sealedBase);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sealedBidStartTime).toBe("10:00:00");
      expect(parsed.data.sealedBidEndTime).toBe("14:30:00");
    }
  });

  it("requires date, start and end when sealed-bid is on", () => {
    const msgs = messages(
      createAuctionSchema.safeParse({
        ...sealedBase,
        sealedBidDate: null,
        sealedBidStartTime: "",
        sealedBidEndTime: undefined,
      }),
    );
    expect(msgs).toEqual(
      expect.arrayContaining([
        AuctionsValidationMessages.SEALED_BID_DATE_REQUIRED,
        AuctionsValidationMessages.SEALED_BID_START_TIME_REQUIRED,
        AuctionsValidationMessages.SEALED_BID_END_TIME_REQUIRED,
      ]),
    );
  });

  it("rejects end at or before start", () => {
    expect(
      messages(
        createAuctionSchema.safeParse({ ...sealedBase, sealedBidEndTime: "10:00" }),
      ),
    ).toContain(AuctionsValidationMessages.SEALED_BID_END_BEFORE_START);
  });

  it("does not require a window when sealed-bid is off", () => {
    expect(
      createAuctionSchema.safeParse({ ...sealedBase, isSealedBid: false, sealedBidDate: null })
        .success,
    ).toBe(true);
  });
});
