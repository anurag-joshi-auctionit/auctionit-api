import { beforeEach, describe, expect, it, vi } from "vitest";
import { auctionDateIsoForInstant } from "@auctionit/lib/lot-schedule";
import { AuctionsValidationMessages } from "@auctionit/messages/auctions";
import { normalizeDisplayOrderKey } from "../lib/auction-lot-display-order.js";
import type { ParsedAuctionLotImportRow } from "../lib/auction-lot-import-parse.js";

const importRowData = {
  lotNumber: "L1",
  materialLiftingDays: 1,
  plantLocation: "A",
  materialLocation: "B",
  gstPercentage: 5 as const,
  tcsPercentage: 1,
  startBidPrice: 100,
  bidLimit: 200,
  bidIncrement: 10,
  lotStartTime: "10:00:00",
  lotEndTime: "12:00:00",
  loadingScope: "buyer" as const,
  displayOrder: 1,
  remark: "r",
  itemId: 1,
  quantity: 1,
  uom: "MT",
  benchmarkMaterial: null as string | null,
  materialName: "Scrap",
  materialDescription: null as string | null,
};

function row(
  rowNumber: number,
  overrides: Partial<typeof importRowData> = {},
): ParsedAuctionLotImportRow {
  return {
    rowNumber,
    data: { ...importRowData, ...overrides },
  };
}

function existingLot(
  id: number,
  displayOrder: number,
  opts?: { isActive?: boolean; lotNumber?: string },
) {
  const key = normalizeDisplayOrderKey(displayOrder);
  return [
    key,
    {
      id,
      displayOrderKey: key,
      isActive: opts?.isActive ?? true,
      lotNumber: opts?.lotNumber ?? `L${id}`,
    },
  ] as const;
}

const {
  parseAuctionLotImportXlsxBufferMock,
  pgBulkInsertLotsMock,
  pgBulkUpdateLotsMock,
  pgLoadExistingLotsByDisplayOrderMock,
  pgWithdrawLotsMock,
  pgLoadUomCodeMapMock,
  pgLoadPlantLocationNameMapMock,
  pgLoadMaterialLocationNameMapMock,
  pgLoadBenchmarkComboLabelMapMock,
  pgLoadClientItemIdSetMock,
  createLotImportStagingSessionMock,
  pgLoadClientItemMatchCorpusMock,
  matchMaterialNamesMock,
} = vi.hoisted(() => ({
  parseAuctionLotImportXlsxBufferMock: vi.fn(),
  pgBulkInsertLotsMock: vi.fn(),
  pgBulkUpdateLotsMock: vi.fn(),
  pgLoadExistingLotsByDisplayOrderMock: vi.fn(),
  pgWithdrawLotsMock: vi.fn(),
  pgLoadUomCodeMapMock: vi.fn(),
  pgLoadPlantLocationNameMapMock: vi.fn(),
  pgLoadMaterialLocationNameMapMock: vi.fn(),
  pgLoadBenchmarkComboLabelMapMock: vi.fn(),
  pgLoadClientItemIdSetMock: vi.fn(),
  createLotImportStagingSessionMock: vi.fn(),
  pgLoadClientItemMatchCorpusMock: vi.fn(),
  matchMaterialNamesMock: vi.fn(),
}));

vi.mock("../lib/parse-auction-lot-import-buffer.js", () => ({
  parseAuctionLotImportXlsxBuffer: (...args: unknown[]) =>
    parseAuctionLotImportXlsxBufferMock(...args),
}));

vi.mock("./auction-lot-import-staging.service.js", () => ({
  createLotImportStagingSession: (...args: unknown[]) =>
    createLotImportStagingSessionMock(...args),
  deleteLotImportStagingSession: vi.fn(),
  loadStagingPayloadForConfirm: vi.fn(),
}));

vi.mock("./auction-lot-item-match.service.js", () => ({
  pgLoadClientItemMatchCorpus: (...args: unknown[]) =>
    pgLoadClientItemMatchCorpusMock(...args),
  matchMaterialNames: (...args: unknown[]) => matchMaterialNamesMock(...args),
}));

vi.mock("./auctions-pg.service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./auctions-pg.service.js")>();
  return {
    ...actual,
    pgBulkInsertLots: (...args: unknown[]) => pgBulkInsertLotsMock(...args),
    pgBulkUpdateLots: (...args: unknown[]) => pgBulkUpdateLotsMock(...args),
    pgLoadExistingLotsByDisplayOrder: (...args: unknown[]) =>
      pgLoadExistingLotsByDisplayOrderMock(...args),
    pgWithdrawLots: (...args: unknown[]) => pgWithdrawLotsMock(...args),
    pgLoadUomCodeMap: (...args: unknown[]) => pgLoadUomCodeMapMock(...args),
    pgLoadPlantLocationNameMap: (...args: unknown[]) =>
      pgLoadPlantLocationNameMapMock(...args),
    pgLoadMaterialLocationNameMap: (...args: unknown[]) =>
      pgLoadMaterialLocationNameMapMock(...args),
    pgLoadBenchmarkComboLabelMap: (...args: unknown[]) =>
      pgLoadBenchmarkComboLabelMapMock(...args),
    pgLoadClientItemIdSet: (...args: unknown[]) =>
      pgLoadClientItemIdSetMock(...args),
  };
});

const { auctionLotImportService } = await import(
  "./auction-lot-import.service.js"
);

function expectImported(
  outcome: Awaited<
    ReturnType<typeof auctionLotImportService.runImportFromBuffer>
  >,
) {
  expect(outcome.kind).toBe("imported");
  if (outcome.kind !== "imported") {
    throw new Error("expected imported outcome");
  }
  return outcome.result;
}

describe("AuctionLotImportService upsert by display order", () => {
  beforeEach(() => {
    parseAuctionLotImportXlsxBufferMock.mockReset();
    pgBulkInsertLotsMock.mockReset();
    pgBulkUpdateLotsMock.mockReset();
    pgLoadExistingLotsByDisplayOrderMock.mockReset();
    pgWithdrawLotsMock.mockReset();
    pgLoadUomCodeMapMock.mockReset();
    pgLoadPlantLocationNameMapMock.mockReset();
    pgLoadMaterialLocationNameMapMock.mockReset();
    pgLoadBenchmarkComboLabelMapMock.mockReset();
    pgLoadClientItemIdSetMock.mockReset();
    createLotImportStagingSessionMock.mockReset();
    pgLoadClientItemMatchCorpusMock.mockReset();
    matchMaterialNamesMock.mockReset();

    pgLoadUomCodeMapMock.mockResolvedValue(new Map([["MT", 1]]));
    pgLoadPlantLocationNameMapMock.mockResolvedValue(new Map([["a", 10]]));
    pgLoadMaterialLocationNameMapMock.mockResolvedValue(new Map([["b", 20]]));
    pgLoadBenchmarkComboLabelMapMock.mockResolvedValue(new Map());
    pgLoadClientItemIdSetMock.mockResolvedValue(new Set([1]));
    pgLoadExistingLotsByDisplayOrderMock.mockResolvedValue(new Map());
    pgWithdrawLotsMock.mockResolvedValue(0);
    pgBulkInsertLotsMock.mockResolvedValue(undefined);
    pgBulkUpdateLotsMock.mockResolvedValue(undefined);
    createLotImportStagingSessionMock.mockResolvedValue("staging-test-id");
    pgLoadClientItemMatchCorpusMock.mockResolvedValue([]);
    matchMaterialNamesMock.mockReturnValue(new Map());
  });

  it("rejects an empty spreadsheet (headers only / no data rows)", async () => {
    parseAuctionLotImportXlsxBufferMock.mockResolvedValue({
      rows: [],
      rowErrors: [],
    });

    await expect(
      auctionLotImportService.runImportFromBuffer(
        1,
        1,
        Buffer.from(""),
        1,
        "2099-06-15",
      ),
    ).rejects.toThrow(AuctionsValidationMessages.LOT_IMPORT_SPREADSHEET_EMPTY);

    expect(pgBulkInsertLotsMock).not.toHaveBeenCalled();
    expect(pgBulkUpdateLotsMock).not.toHaveBeenCalled();
    expect(pgWithdrawLotsMock).not.toHaveBeenCalled();
  });

  it("updates an active lot matched by display order (lot number may change)", async () => {
    parseAuctionLotImportXlsxBufferMock.mockResolvedValue({
      rows: [row(2, { lotNumber: "L9", quantity: 50, displayOrder: 1 })],
      rowErrors: [],
    });
    pgLoadExistingLotsByDisplayOrderMock.mockResolvedValue(
      new Map([existingLot(10, 1, { lotNumber: "L1" })]),
    );

    const result = expectImported(
      await auctionLotImportService.runImportFromBuffer(
        1,
        1,
        Buffer.from(""),
        1,
        "2099-06-15",
      ),
    );

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(pgBulkInsertLotsMock).not.toHaveBeenCalled();
    expect(pgBulkUpdateLotsMock).toHaveBeenCalledTimes(1);
    const updated = pgBulkUpdateLotsMock.mock.calls[0]?.[2] as {
      lotId: number;
      lotNumber: string;
      quantity: number;
    }[];
    expect(updated[0]?.lotId).toBe(10);
    expect(updated[0]?.lotNumber).toBe("L9");
    expect(updated[0]?.quantity).toBe(50);
    expect(pgWithdrawLotsMock).not.toHaveBeenCalled();
  });

  it("inserts a new display order", async () => {
    parseAuctionLotImportXlsxBufferMock.mockResolvedValue({
      rows: [row(2, { lotNumber: "NEW", displayOrder: 2 })],
      rowErrors: [],
    });
    pgLoadExistingLotsByDisplayOrderMock.mockResolvedValue(
      new Map([existingLot(10, 1)]),
    );

    const result = expectImported(
      await auctionLotImportService.runImportFromBuffer(
        1,
        1,
        Buffer.from(""),
        1,
        "2099-06-15",
      ),
    );

    expect(result.imported).toBe(1);
    expect(pgBulkUpdateLotsMock).not.toHaveBeenCalled();
    expect(pgBulkInsertLotsMock).toHaveBeenCalledTimes(1);
    // Active order 1 missing from file → withdraw
    expect(pgWithdrawLotsMock).toHaveBeenCalledWith(1, [10], 1);
  });

  it("skips rows that match a withdrawn display order (portal sticky)", async () => {
    parseAuctionLotImportXlsxBufferMock.mockResolvedValue({
      rows: [row(2, { lotNumber: "L1", displayOrder: 1, quantity: 99 })],
      rowErrors: [],
    });
    pgLoadExistingLotsByDisplayOrderMock.mockResolvedValue(
      new Map([existingLot(10, 1, { isActive: false })]),
    );

    const result = expectImported(
      await auctionLotImportService.runImportFromBuffer(
        1,
        1,
        Buffer.from(""),
        1,
        "2099-06-15",
      ),
    );

    expect(result.imported).toBe(0);
    expect(result.withdrawn).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issues).toEqual([
      {
        rowNumber: 2,
        kind: "skipped",
        reason: AuctionsValidationMessages.IMPORT_ROW_SKIPPED_WITHDRAWN,
      },
    ]);
    expect(pgBulkUpdateLotsMock).not.toHaveBeenCalled();
    expect(pgBulkInsertLotsMock).not.toHaveBeenCalled();
    expect(pgWithdrawLotsMock).not.toHaveBeenCalled();
  });

  it("withdraws active lots whose display order is missing from the file", async () => {
    parseAuctionLotImportXlsxBufferMock.mockResolvedValue({
      rows: [row(2, { lotNumber: "A", displayOrder: 1 })],
      rowErrors: [],
    });
    pgLoadExistingLotsByDisplayOrderMock.mockResolvedValue(
      new Map([
        existingLot(10, 1, { lotNumber: "A" }),
        existingLot(20, 2, { lotNumber: "B" }),
        existingLot(30, 3, { isActive: false, lotNumber: "C" }),
      ]),
    );
    pgWithdrawLotsMock.mockResolvedValue(1);

    const result = expectImported(
      await auctionLotImportService.runImportFromBuffer(
        1,
        1,
        Buffer.from(""),
        1,
        "2099-06-15",
      ),
    );

    expect(result.imported).toBe(1);
    expect(result.withdrawn).toBe(1);
    expect(pgWithdrawLotsMock).toHaveBeenCalledWith(1, [20], 1);
  });

  it("errors on unknown UOM for an existing display order instead of updating", async () => {
    parseAuctionLotImportXlsxBufferMock.mockResolvedValue({
      rows: [row(2, { lotNumber: "L1", uom: "NOPE" })],
      rowErrors: [],
    });
    pgLoadExistingLotsByDisplayOrderMock.mockResolvedValue(
      new Map([existingLot(10, 1)]),
    );

    const result = expectImported(
      await auctionLotImportService.runImportFromBuffer(
        1,
        1,
        Buffer.from(""),
        1,
        "2099-06-15",
      ),
    );

    expect(result.imported).toBe(0);
    expect(result.withdrawn).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.issues[0]?.kind).toBe("error");
    expect(pgBulkUpdateLotsMock).not.toHaveBeenCalled();
  });

  it("rejects rows when auction date is in the past", async () => {
    parseAuctionLotImportXlsxBufferMock.mockResolvedValue({
      rows: [row(2, { lotNumber: "L1", lotStartTime: "10:00:00" })],
      rowErrors: [],
    });

    const result = expectImported(
      await auctionLotImportService.runImportFromBuffer(
        1,
        1,
        Buffer.from(""),
        1,
        "2020-01-01",
      ),
    );

    expect(result.imported).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.issues[0]?.reason).toContain(
      AuctionsValidationMessages.LOT_TIMES_REQUIRE_FUTURE_AUCTION_DATE,
    );
    expect(pgBulkInsertLotsMock).not.toHaveBeenCalled();
  });

  it("rejects rows whose lot end is not after now on today's auction date", async () => {
    parseAuctionLotImportXlsxBufferMock.mockResolvedValue({
      rows: [
        row(2, {
          lotNumber: "L1",
          lotStartTime: "00:01:00",
          lotEndTime: "00:02:00",
        }),
      ],
      rowErrors: [],
    });

    const result = expectImported(
      await auctionLotImportService.runImportFromBuffer(
        1,
        1,
        Buffer.from(""),
        1,
        auctionDateIsoForInstant(),
      ),
    );

    expect(result.imported).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.issues[0]?.fieldErrors?.lotEndTime).toEqual([
      AuctionsValidationMessages.LOT_END_TIME_MUST_BE_FUTURE,
    ]);
    expect(pgBulkInsertLotsMock).not.toHaveBeenCalled();
  });

  it("keeps the later in-file duplicate lot number", async () => {
    parseAuctionLotImportXlsxBufferMock.mockResolvedValue({
      rows: [
        row(2, { lotNumber: "L1", quantity: 1, displayOrder: 1 }),
        row(3, { lotNumber: "L1", quantity: 99, displayOrder: 1 }),
      ],
      rowErrors: [],
    });
    pgLoadExistingLotsByDisplayOrderMock.mockResolvedValue(
      new Map([existingLot(10, 1)]),
    );

    const result = expectImported(
      await auctionLotImportService.runImportFromBuffer(
        1,
        1,
        Buffer.from(""),
        1,
        "2099-06-15",
      ),
    );

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    const updated = pgBulkUpdateLotsMock.mock.calls[0]?.[2] as {
      quantity: number;
      rowNumber: number;
    }[];
    expect(updated[0]?.quantity).toBe(99);
    expect(updated[0]?.rowNumber).toBe(3);
  });

  it("rejects reclaiming a lot number from a lot withdrawn in the same import", async () => {
    parseAuctionLotImportXlsxBufferMock.mockResolvedValue({
      rows: [row(2, { lotNumber: "EXISTING", displayOrder: 2 })],
      rowErrors: [],
    });
    pgLoadExistingLotsByDisplayOrderMock.mockResolvedValue(
      new Map([existingLot(10, 1, { lotNumber: "EXISTING" })]),
    );

    const result = expectImported(
      await auctionLotImportService.runImportFromBuffer(
        1,
        1,
        Buffer.from(""),
        1,
        "2099-06-15",
      ),
    );

    expect(result.imported).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rowNumber: 2,
          kind: "error",
          reason: AuctionsValidationMessages.LOT_NUMBER_ALREADY_EXISTS,
        }),
      ]),
    );
    expect(pgBulkInsertLotsMock).not.toHaveBeenCalled();
    // Still withdraws the omitted active display order
    expect(pgWithdrawLotsMock).toHaveBeenCalledWith(1, [10], 1);
  });

  it("rejects reclaiming a lot number from a previously withdrawn lot", async () => {
    parseAuctionLotImportXlsxBufferMock.mockResolvedValue({
      rows: [row(2, { lotNumber: "C", displayOrder: 2 })],
      rowErrors: [],
    });
    pgLoadExistingLotsByDisplayOrderMock.mockResolvedValue(
      new Map([
        existingLot(10, 1, { lotNumber: "A" }),
        existingLot(30, 3, { isActive: false, lotNumber: "C" }),
      ]),
    );

    const result = expectImported(
      await auctionLotImportService.runImportFromBuffer(
        1,
        1,
        Buffer.from(""),
        1,
        "2099-06-15",
      ),
    );

    expect(result.imported).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.issues[0]).toEqual(
      expect.objectContaining({
        rowNumber: 2,
        kind: "error",
        reason: AuctionsValidationMessages.LOT_NUMBER_ALREADY_EXISTS,
      }),
    );
    expect(pgBulkInsertLotsMock).not.toHaveBeenCalled();
  });

  it("stages valid blank-itemId rows while keeping failed rows in needsReview", async () => {
    parseAuctionLotImportXlsxBufferMock.mockResolvedValue({
      rows: [
        row(2, {
          lotNumber: "OK",
          itemId: null,
          materialName: "Scrap Mix",
          displayOrder: 1,
        }),
        row(3, {
          lotNumber: "BAD",
          itemId: null,
          plantLocation: "Unknown Plant",
          displayOrder: 2,
        }),
      ],
      rowErrors: [],
    });

    const outcome = await auctionLotImportService.runImportFromBuffer(
      1,
      1,
      Buffer.from(""),
      1,
      "2099-06-15",
    );

    expect(outcome.kind).toBe("needsReview");
    if (outcome.kind !== "needsReview") {
      throw new Error("expected needsReview outcome");
    }
    expect(outcome.review.parsed).toBe(1);
    expect(outcome.review.failed).toBe(1);
    expect(createLotImportStagingSessionMock).toHaveBeenCalledTimes(1);
    expect(pgBulkInsertLotsMock).not.toHaveBeenCalled();
  });
});
