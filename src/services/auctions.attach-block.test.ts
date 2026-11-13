import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuctionsValidationMessages } from "@auctionit/messages/auctions";

const {
  blockedBidderIdsForClientMock,
  pgGetAuctionClientIdMock,
  pgBidderEmdWalletsMock,
  pgAttachBidderToLotsMock,
  pgActiveMappedLotFlagsMock,
  pgActiveMappedLotsTxMock,
  pgActiveWalletLotIdsTxMock,
  pgReleasedMappedLotIdsMock,
  pgHeldCoveredLotIdsMock,
  pgListLotsMock,
  pgEmdRangesMock,
  pgGetAuctionStatusMock,
  pgAuctionStatsMock,
  parseLotBidderMapImportXlsxBufferMock,
  pgLoadWithdrawnDisplayOrderKeysMock,
  auctionRow,
} = vi.hoisted(() => ({
  auctionRow: { consolidatedEmd: 1000 as number | null },
  blockedBidderIdsForClientMock: vi.fn(),
  pgGetAuctionClientIdMock: vi.fn(),
  pgBidderEmdWalletsMock: vi.fn(),
  pgAttachBidderToLotsMock: vi.fn(),
  pgActiveMappedLotFlagsMock: vi.fn(),
  pgActiveMappedLotsTxMock: vi.fn(),
  pgActiveWalletLotIdsTxMock: vi.fn(),
  pgReleasedMappedLotIdsMock: vi.fn(),
  pgHeldCoveredLotIdsMock: vi.fn(),
  pgListLotsMock: vi.fn(),
  pgEmdRangesMock: vi.fn(),
  pgGetAuctionStatusMock: vi.fn(),
  pgAuctionStatsMock: vi.fn(),
  parseLotBidderMapImportXlsxBufferMock: vi.fn(),
  pgLoadWithdrawnDisplayOrderKeysMock: vi.fn(),
}));

vi.mock("../lib/bidders/blocked-for-client.js", () => ({
  blockedBidderIdsForClient: (...args: unknown[]) =>
    blockedBidderIdsForClientMock(...args),
}));

vi.mock("../lib/parse-lot-bidder-map-import-buffer.js", () => ({
  parseLotBidderMapImportXlsxBuffer: (...args: unknown[]) =>
    parseLotBidderMapImportXlsxBufferMock(...args),
}));

vi.mock("./auctions-pg.service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./auctions-pg.service.js")>();
  return {
    ...actual,
    pgGetAuctionClientId: (...args: unknown[]) =>
      pgGetAuctionClientIdMock(...args),
    pgBidderEmdWallets: (...args: unknown[]) => pgBidderEmdWalletsMock(...args),
    pgAttachBidderToLots: (...args: unknown[]) =>
      pgAttachBidderToLotsMock(...args),
    pgActiveMappedLotFlags: (...args: unknown[]) =>
      pgActiveMappedLotFlagsMock(...args),
    pgActiveMappedLotsTx: (...args: unknown[]) =>
      pgActiveMappedLotsTxMock(...args),
    pgActiveWalletLotIdsTx: (...args: unknown[]) =>
      pgActiveWalletLotIdsTxMock(...args),
    pgReleasedMappedLotIds: (...args: unknown[]) =>
      pgReleasedMappedLotIdsMock(...args),
    pgHeldCoveredLotIds: (...args: unknown[]) =>
      pgHeldCoveredLotIdsMock(...args),
    pgListLots: (...args: unknown[]) => pgListLotsMock(...args),
    pgEmdRanges: (...args: unknown[]) => pgEmdRangesMock(...args),
    pgGetAuctionStatus: (...args: unknown[]) =>
      pgGetAuctionStatusMock(...args),
    pgAuctionStats: (...args: unknown[]) => pgAuctionStatsMock(...args),
    pgLoadWithdrawnDisplayOrderKeys: (...args: unknown[]) =>
      pgLoadWithdrawnDisplayOrderKeysMock(...args),
  };
});

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.limit = vi.fn(async () => [
        { auctionId: 1, consolidatedEmd: auctionRow.consolidatedEmd, status: "published" },
      ]);
      return chain;
    }),
    // Satisfies EmdBlocksService.alreadyBlockedForBidders, called by the
    // Attach Bidders preview for the operator's "already blocked" context.
    execute: vi.fn(async () => ({ rows: [] })),
  },
}));

const { auctionsService } = await import("./auctions.service.js");

const AUCTION_ID = 42;
const CLIENT_ID = 7;
const BIDDER_ID = 100;
const LOT_ID = 5;

function stubPublishedAuctionWithEmd() {
  pgGetAuctionStatusMock.mockResolvedValue("published");
  pgAuctionStatsMock.mockResolvedValue({
    lotEmdSet: true,
    biddersMapped: false,
  });
  pgGetAuctionClientIdMock.mockResolvedValue(CLIENT_ID);
  pgListLotsMock.mockResolvedValue([
    {
      lotId: LOT_ID,
      displayOrder: 1,
      lotNumber: "L1",
      status: "active",
    },
  ]);
  pgEmdRangesMock.mockResolvedValue([
    {
      lotEmdId: 1,
      lotDisplayOrderFrom: 1,
      lotDisplayOrderTo: 1,
      emd: 500,
      displayOrder: 1,
    },
  ]);
  pgBidderEmdWalletsMock.mockResolvedValue([
    {
      bidderId: BIDDER_ID,
      companyName: "Acme Bidding",
      emdAvailable: 10_000,
      isVerified: true,
    },
  ]);
}

describe("Attach bidders — client block gate", () => {
  beforeEach(() => {
    blockedBidderIdsForClientMock.mockReset();
    pgGetAuctionClientIdMock.mockReset();
    pgBidderEmdWalletsMock.mockReset();
    pgAttachBidderToLotsMock.mockReset();
    pgActiveMappedLotFlagsMock.mockReset().mockResolvedValue(new Map());
    pgActiveMappedLotsTxMock.mockReset().mockResolvedValue([]);
    pgActiveWalletLotIdsTxMock.mockReset().mockResolvedValue([]);
    pgReleasedMappedLotIdsMock.mockReset().mockResolvedValue(new Set());
    pgHeldCoveredLotIdsMock.mockReset().mockResolvedValue(new Set());
    pgListLotsMock.mockReset();
    pgEmdRangesMock.mockReset();
    pgGetAuctionStatusMock.mockReset();
    pgAuctionStatsMock.mockReset();
    parseLotBidderMapImportXlsxBufferMock.mockReset();
    pgLoadWithdrawnDisplayOrderKeysMock.mockReset().mockResolvedValue(new Set());
    auctionRow.consolidatedEmd = 1000;
    stubPublishedAuctionWithEmd();
  });

  it("preview marks blocked bidders with attach error", async () => {
    blockedBidderIdsForClientMock.mockResolvedValue(new Set([BIDDER_ID]));

    const { rows } = await auctionsService.lotBidderMapPreview(
      AUCTION_ID,
      [BIDDER_ID],
      [LOT_ID],
    );

    expect(blockedBidderIdsForClientMock).toHaveBeenCalledWith(CLIENT_ID, [
      BIDDER_ID,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.error).toBe(
      AuctionsValidationMessages.BIDDER_BLOCKED_FOR_CLIENT_ATTACH,
    );
  });

  it("preview rejects unverified bidders", async () => {
    blockedBidderIdsForClientMock.mockResolvedValue(new Set());
    pgBidderEmdWalletsMock.mockResolvedValue([
      {
        bidderId: BIDDER_ID,
        companyName: "Acme Bidding",
        emdAvailable: 10_000,
        isVerified: false,
      },
    ]);

    const { rows } = await auctionsService.lotBidderMapPreview(
      AUCTION_ID,
      [BIDDER_ID],
      [LOT_ID],
    );

    expect(rows[0]!.error).toBe(
      AuctionsValidationMessages.BIDDER_NOT_VERIFIED_FOR_ATTACH,
    );
  });

  it("preview leaves non-blocked bidders without error", async () => {
    blockedBidderIdsForClientMock.mockResolvedValue(new Set());

    const { rows } = await auctionsService.lotBidderMapPreview(
      AUCTION_ID,
      [BIDDER_ID],
      [LOT_ID],
    );

    expect(rows[0]!.error).toBeNull();
  });

  it("preview reports the bidder's already-blocked amount and the combined requirement", async () => {
    blockedBidderIdsForClientMock.mockResolvedValue(new Set());
    // Bidder already holds another lot (LOT_ID 6) outside this preview's
    // selection, blocked at 300.
    pgActiveMappedLotsTxMock.mockResolvedValue([
      { lotId: LOT_ID, isEmdWithClient: false, emdReleased: true },
      { lotId: 6, isEmdWithClient: false },
    ]);
    pgListLotsMock.mockResolvedValue([
      { lotId: LOT_ID, displayOrder: 1, lotNumber: "L1", status: "active" },
      { lotId: 6, displayOrder: 2, lotNumber: "L2", status: "active" },
    ]);
    pgEmdRangesMock.mockResolvedValue([
      { lotEmdId: 1, lotDisplayOrderFrom: 1, lotDisplayOrderTo: 1, emd: 500, displayOrder: 1 },
      { lotEmdId: 2, lotDisplayOrderFrom: 2, lotDisplayOrderTo: 2, emd: 300, displayOrder: 2 },
    ]);
    const dbModule = await import("../db/index.js");
    // alreadyBlockedForBidders issues the blocked-amount query then the
    // block-status query, in that order, inside one Promise.all.
    vi.mocked(dbModule.db.execute)
      .mockResolvedValueOnce({ rows: [{ bidder_id: BIDDER_ID, blocked: "300.00" }] } as never)
      .mockResolvedValueOnce({ rows: [{ bidder_id: BIDDER_ID, block_status: "partial" }] } as never);

    const { rows } = await auctionsService.lotBidderMapPreview(
      AUCTION_ID,
      [BIDDER_ID],
      [LOT_ID],
    );

    expect(rows[0]).toMatchObject({
      emdRequired: 500,
      alreadyBlocked: 300,
      combinedEmdRequired: 800,
      emdAmount: 500,
      isEmdWithClient: false,
    });
  });

  it("submit re-blocks an already-attached bidder whose EMD was released at close", async () => {
    blockedBidderIdsForClientMock.mockResolvedValue(new Set());
    pgActiveMappedLotFlagsMock.mockResolvedValue(new Map([[LOT_ID, false]]));
    pgActiveMappedLotsTxMock.mockResolvedValue([
      { lotId: LOT_ID, isEmdWithClient: false },
    ]);
    pgReleasedMappedLotIdsMock.mockResolvedValue(new Set([LOT_ID]));
    pgAttachBidderToLotsMock.mockResolvedValue({
      attachedLotIds: [],
      skippedLotIds: [LOT_ID],
      reblocked: true,
    });

    const result = await auctionsService.submitLotBidderMap(
      AUCTION_ID,
      {
        rows: [
          {
            bidderId: BIDDER_ID,
            lotIds: [LOT_ID],
            isEmdWithClient: false,
          },
        ],
      },
      1,
    );

    expect(result.results[0]).toMatchObject({ error: null });
    expect(pgAttachBidderToLotsMock).toHaveBeenCalledTimes(1);
    expect(pgAttachBidderToLotsMock.mock.calls[0]![3]).toEqual([LOT_ID]);
    expect(result.mapped).toBe(1);
    expect(result.results[0]!.status).toBe("mapped");
  });

  it("submit still skips an already-attached bidder who holds a block", async () => {
    blockedBidderIdsForClientMock.mockResolvedValue(new Set());
    pgActiveMappedLotFlagsMock.mockResolvedValue(new Map([[LOT_ID, false]]));

    const result = await auctionsService.submitLotBidderMap(
      AUCTION_ID,
      {
        rows: [
          {
            bidderId: BIDDER_ID,
            lotIds: [LOT_ID],
            isEmdWithClient: false,
          },
        ],
      },
      1,
    );

    expect(pgAttachBidderToLotsMock).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("submit rejects blocked bidder and does not attach", async () => {
    blockedBidderIdsForClientMock.mockResolvedValue(new Set([BIDDER_ID]));

    const result = await auctionsService.submitLotBidderMap(
      AUCTION_ID,
      {
        rows: [
          {
            bidderId: BIDDER_ID,
            lotIds: [LOT_ID],
            isEmdWithClient: true,
          },
        ],
      },
      1,
    );

    expect(result.mapped).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.results[0]).toEqual({
      bidderId: BIDDER_ID,
      status: "error",
      error: AuctionsValidationMessages.BIDDER_BLOCKED_FOR_CLIENT_ATTACH,
      message: null,
    });
    expect(pgAttachBidderToLotsMock).not.toHaveBeenCalled();
  });

  it("submit attaches when bidder is not blocked for this client", async () => {
    blockedBidderIdsForClientMock.mockResolvedValue(new Set());
    pgAttachBidderToLotsMock.mockResolvedValue({
      attachedLotIds: [LOT_ID],
      skippedLotIds: [],
    });

    const result = await auctionsService.submitLotBidderMap(
      AUCTION_ID,
      {
        rows: [
          {
            bidderId: BIDDER_ID,
            lotIds: [LOT_ID],
            isEmdWithClient: true,
          },
        ],
      },
      1,
    );

    expect(result.mapped).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.results[0]).toEqual({
      bidderId: BIDDER_ID,
      status: "mapped",
      error: null,
      message: null,
    });
    expect(pgAttachBidderToLotsMock).toHaveBeenCalledWith(
      AUCTION_ID,
      CLIENT_ID,
      BIDDER_ID,
      [LOT_ID],
      true,
      1,
      { targetBlockAmount: 0 },
    );
  });

  it("submit skips when bidder is already attached to all selected lots", async () => {
    blockedBidderIdsForClientMock.mockResolvedValue(new Set());
    pgActiveMappedLotFlagsMock.mockResolvedValue(new Map([[LOT_ID, true]]));

    const result = await auctionsService.submitLotBidderMap(
      AUCTION_ID,
      {
        rows: [
          {
            bidderId: BIDDER_ID,
            lotIds: [LOT_ID],
            isEmdWithClient: true,
          },
        ],
      },
      1,
    );

    expect(result.mapped).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.results[0]).toEqual({
      bidderId: BIDDER_ID,
      status: "skipped",
      error: null,
      message:
        AuctionsValidationMessages.BIDDER_ALREADY_ATTACHED_TO_SELECTED_LOTS,
    });
    expect(pgAttachBidderToLotsMock).not.toHaveBeenCalled();
  });

  it("submit blocks the full wallet requirement for a non-client attach, ignoring a stale status/amount", async () => {
    blockedBidderIdsForClientMock.mockResolvedValue(new Set());
    pgAttachBidderToLotsMock.mockResolvedValue({
      attachedLotIds: [LOT_ID],
      skippedLotIds: [],
    });

    await auctionsService.submitLotBidderMap(
      AUCTION_ID,
      {
        rows: [
          {
            bidderId: BIDDER_ID,
            lotIds: [LOT_ID],
            isEmdWithClient: false,
            blockStatus: "P",
            emdAmount: 1,
          } as never,
        ],
      },
      1,
    );

    expect(pgAttachBidderToLotsMock.mock.calls[0]![6]).toEqual({
      targetBlockAmount: 500,
    });
  });

  it("submit flips an attached lot to non-client and moves the block", async () => {
    blockedBidderIdsForClientMock.mockResolvedValue(new Set());
    pgActiveMappedLotFlagsMock.mockResolvedValue(new Map([[LOT_ID, true]]));
    pgActiveMappedLotsTxMock.mockResolvedValue([
      { lotId: LOT_ID, isEmdWithClient: true },
    ]);
    pgAttachBidderToLotsMock.mockResolvedValue({
      attachedLotIds: [],
      skippedLotIds: [],
      updatedLotIds: [LOT_ID],
    });

    const result = await auctionsService.submitLotBidderMap(
      AUCTION_ID,
      { rows: [{ bidderId: BIDDER_ID, lotIds: [LOT_ID], isEmdWithClient: false }] },
      1,
    );

    expect(pgAttachBidderToLotsMock.mock.calls[0]![6]).toEqual({
      targetBlockAmount: 500,
    });
    expect(result.results[0]!.status).toBe("mapped");
  });

  it("submit flips a non-client lot to client with a zero block target", async () => {
    blockedBidderIdsForClientMock.mockResolvedValue(new Set());
    pgActiveMappedLotFlagsMock.mockResolvedValue(new Map([[LOT_ID, false]]));
    pgActiveMappedLotsTxMock.mockResolvedValue([
      { lotId: LOT_ID, isEmdWithClient: false },
    ]);
    pgAttachBidderToLotsMock.mockResolvedValue({
      attachedLotIds: [],
      skippedLotIds: [],
      updatedLotIds: [LOT_ID],
    });

    const result = await auctionsService.submitLotBidderMap(
      AUCTION_ID,
      { rows: [{ bidderId: BIDDER_ID, lotIds: [LOT_ID], isEmdWithClient: true }] },
      1,
    );

    expect(pgAttachBidderToLotsMock.mock.calls[0]![6]).toEqual({
      targetBlockAmount: 0,
    });
    expect(result.results[0]!.status).toBe("mapped");
  });

  it("submit errors when the wallet cannot cover the full block", async () => {
    blockedBidderIdsForClientMock.mockResolvedValue(new Set());
    pgBidderEmdWalletsMock.mockResolvedValue([
      { bidderId: BIDDER_ID, companyName: "Acme", emdAvailable: 100, isVerified: true },
    ]);

    const result = await auctionsService.submitLotBidderMap(
      AUCTION_ID,
      { rows: [{ bidderId: BIDDER_ID, lotIds: [LOT_ID], isEmdWithClient: false }] },
      1,
    );

    expect(result.results[0]!.status).toBe("error");
    expect(result.results[0]!.error).toMatch(/insufficient/i);
    expect(pgAttachBidderToLotsMock).not.toHaveBeenCalled();
  });

  describe("per-lot EMD ranges (R1 lots 1-2 = 1,000; R2 lot 3 = 2,000; R3 lots 4-7 = 3,000; R4 lot 8 = 5,000; cap 10,000)", () => {
    // Lot ids equal their display orders.
    function stubFourRanges() {
      auctionRow.consolidatedEmd = 10_000;
      pgListLotsMock.mockResolvedValue(
        [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
          lotId: n,
          displayOrder: n,
          lotNumber: `L${n}`,
          status: "active",
        })),
      );
      pgEmdRangesMock.mockResolvedValue([
        { lotEmdId: 1, lotDisplayOrderFrom: 1, lotDisplayOrderTo: 2, emd: 1_000, displayOrder: 1 },
        { lotEmdId: 2, lotDisplayOrderFrom: 3, lotDisplayOrderTo: 3, emd: 2_000, displayOrder: 2 },
        { lotEmdId: 3, lotDisplayOrderFrom: 4, lotDisplayOrderTo: 7, emd: 3_000, displayOrder: 3 },
        { lotEmdId: 4, lotDisplayOrderFrom: 8, lotDisplayOrderTo: 8, emd: 5_000, displayOrder: 4 },
      ]);
      // Bidder holds wallet-blocked lots 1, 3, 4.
      pgActiveMappedLotsTxMock.mockResolvedValue(
        [1, 3, 4].map((lotId) => ({ lotId, isEmdWithClient: false })),
      );
    }

    it("preview shows 4,000 for lots 1,4 while the bidder's total block after attach stays 6,000", async () => {
      blockedBidderIdsForClientMock.mockResolvedValue(new Set());
      stubFourRanges();

      const { rows } = await auctionsService.lotBidderMapPreview(
        AUCTION_ID,
        [BIDDER_ID],
        [1, 4],
      );

      expect(rows[0]).toMatchObject({ emdRequired: 4_000, combinedEmdRequired: 6_000 });
    });

    it("does not charge a range already held for a won lot again when attaching another lot", async () => {
      blockedBidderIdsForClientMock.mockResolvedValue(new Set());
      stubFourRanges();
      // Lot 1's range (R1) is held from before the reopen; the bidder picks lot 4.
      pgHeldCoveredLotIdsMock.mockResolvedValue(new Set([1, 2]));
      pgActiveMappedLotsTxMock.mockResolvedValue([
        { lotId: 1, isEmdWithClient: false, emdReleased: false },
      ]);
      pgActiveMappedLotFlagsMock.mockResolvedValue(new Map());
      pgAttachBidderToLotsMock.mockResolvedValue({
        attachedLotIds: [4],
        skippedLotIds: [],
      });

      await auctionsService.submitLotBidderMap(
        AUCTION_ID,
        { rows: [{ bidderId: BIDDER_ID, lotIds: [4], isEmdWithClient: false }] },
        1,
      );

      // R3 only (3,000), not R1 + R3 (4,000): lot 1's 1,000 is already held.
      expect(pgAttachBidderToLotsMock.mock.calls[0]![6]).toEqual({ targetBlockAmount: 3_000 });
    });

    it("preview shows no EMD for picked lots in a range already held", async () => {
      blockedBidderIdsForClientMock.mockResolvedValue(new Set());
      stubFourRanges();
      pgHeldCoveredLotIdsMock.mockResolvedValue(new Set([1, 2]));
      pgActiveMappedLotsTxMock.mockResolvedValue([
        { lotId: 1, isEmdWithClient: false, emdReleased: false },
      ]);

      const { rows } = await auctionsService.lotBidderMapPreview(
        AUCTION_ID,
        [BIDDER_ID],
        [1, 4],
      );

      expect(rows[0]).toMatchObject({ emdRequired: 3_000, combinedEmdRequired: 3_000 });
    });

    it("switching lots 1,4 to EMD with client moves the block to lot 3's 2,000", async () => {
      blockedBidderIdsForClientMock.mockResolvedValue(new Set());
      stubFourRanges();
      pgActiveMappedLotFlagsMock.mockResolvedValue(
        new Map([
          [1, false],
          [4, false],
        ]),
      );
      pgAttachBidderToLotsMock.mockResolvedValue({
        attachedLotIds: [],
        skippedLotIds: [],
        updatedLotIds: [1, 4],
      });

      const result = await auctionsService.submitLotBidderMap(
        AUCTION_ID,
        { rows: [{ bidderId: BIDDER_ID, lotIds: [1, 4], isEmdWithClient: true }] },
        1,
      );

      expect(pgAttachBidderToLotsMock.mock.calls[0]![6]).toEqual({ targetBlockAmount: 2_000 });
      expect(result.results[0]!.status).toBe("mapped");
    });

    it("re-submitting lots 1,4 as wallet lots is a no-op", async () => {
      blockedBidderIdsForClientMock.mockResolvedValue(new Set());
      stubFourRanges();
      pgActiveMappedLotFlagsMock.mockResolvedValue(
        new Map([
          [1, false],
          [4, false],
        ]),
      );

      const result = await auctionsService.submitLotBidderMap(
        AUCTION_ID,
        { rows: [{ bidderId: BIDDER_ID, lotIds: [1, 4], isEmdWithClient: false }] },
        1,
      );

      expect(result.skipped).toBe(1);
      expect(pgAttachBidderToLotsMock).not.toHaveBeenCalled();
    });
  });

  it("import marks blocked bidder rows invalid", async () => {
    blockedBidderIdsForClientMock.mockResolvedValue(new Set([BIDDER_ID]));
    parseLotBidderMapImportXlsxBufferMock.mockResolvedValue({
      headerError: null,
      rows: [
        {
          rowNumber: 2,
          bidderId: BIDDER_ID,
          bidderName: "Acme Bidding",
          lotDisplayOrders: [1],
          emdDisplayOrders: [1],
          isEmdWithClientRaw: "y",
          blockStatusRaw: "",
          emdAmount: null,
        },
      ],
    });

    const { rows } = await auctionsService.importLotBidderMap(
      AUCTION_ID,
      Buffer.from("xlsx"),
    );

    expect(blockedBidderIdsForClientMock).toHaveBeenCalledWith(CLIENT_ID, [
      BIDDER_ID,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.error).toContain(
      AuctionsValidationMessages.BIDDER_BLOCKED_FOR_CLIENT_ATTACH,
    );
  });

  it("import allows bidder blocked only for another client", async () => {
    // Helper already scoped to auction client — empty set means not blocked here.
    blockedBidderIdsForClientMock.mockResolvedValue(new Set());
    parseLotBidderMapImportXlsxBufferMock.mockResolvedValue({
      headerError: null,
      rows: [
        {
          rowNumber: 2,
          bidderId: BIDDER_ID,
          bidderName: "Acme Bidding",
          lotDisplayOrders: [1],
          emdDisplayOrders: [1],
          isEmdWithClientRaw: "y",
          blockStatusRaw: "",
          emdAmount: null,
        },
      ],
    });

    const { rows } = await auctionsService.importLotBidderMap(
      AUCTION_ID,
      Buffer.from("xlsx"),
    );

    expect(rows[0]!.error).toBeNull();
  });
});
