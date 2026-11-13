import { beforeEach, describe, expect, it, vi } from "vitest";
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
}));

vi.mock("../lib/parse-auction-lot-import-buffer.js", () => ({
  parseAuctionLotImportXlsxBuffer: (...args: unknown[]) =>
    parseAuctionLotImportXlsxBufferMock(...args),
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

describe("AuctionLotImportService display order conflicts", () => {
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

    pgLoadUomCodeMapMock.mockResolvedValue(new Map([["MT", 1]]));
    pgLoadPlantLocationNameMapMock.mockResolvedValue(new Map([["a", 10]]));
    pgLoadMaterialLocationNameMapMock.mockResolvedValue(new Map([["b", 20]]));
    pgLoadBenchmarkComboLabelMapMock.mockResolvedValue(new Map());
    pgLoadClientItemIdSetMock.mockResolvedValue(new Set([1]));
    pgLoadExistingLotsByDisplayOrderMock.mockResolvedValue(new Map());
    pgWithdrawLotsMock.mockResolvedValue(0);
    pgBulkInsertLotsMock.mockResolvedValue(undefined);
    pgBulkUpdateLotsMock.mockResolvedValue(undefined);
  });

  it("updates the active lot when display order already exists", async () => {
    parseAuctionLotImportXlsxBufferMock.mockResolvedValue({
      rows: [row(2, { lotNumber: "NEW", displayOrder: 5 })],
      rowErrors: [],
    });
    const key = normalizeDisplayOrderKey(5);
    pgLoadExistingLotsByDisplayOrderMock.mockResolvedValue(
      new Map([
        [
          key,
          {
            id: 99,
            displayOrderKey: key,
            isActive: true,
            lotNumber: "OLD",
          },
        ],
      ]),
    );

    const outcome = await auctionLotImportService.runImportFromBuffer(
      1,
      1,
      Buffer.from(""),
      1,
      "2099-06-15",
    );
    expect(outcome.kind).toBe("imported");
    if (outcome.kind !== "imported") throw new Error("expected imported");
    const result = outcome.result;

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(pgBulkInsertLotsMock).not.toHaveBeenCalled();
    expect(pgBulkUpdateLotsMock).toHaveBeenCalledTimes(1);
    const updated = pgBulkUpdateLotsMock.mock.calls[0]?.[2] as {
      lotId: number;
      lotNumber: string;
    }[];
    expect(updated[0]?.lotId).toBe(99);
    expect(updated[0]?.lotNumber).toBe("NEW");
  });

  it("skips when display order belongs to a withdrawn lot", async () => {
    parseAuctionLotImportXlsxBufferMock.mockResolvedValue({
      rows: [row(2, { lotNumber: "NEW", displayOrder: 5 })],
      rowErrors: [],
    });
    const key = normalizeDisplayOrderKey(5);
    pgLoadExistingLotsByDisplayOrderMock.mockResolvedValue(
      new Map([
        [
          key,
          {
            id: 99,
            displayOrderKey: key,
            isActive: false,
            lotNumber: "OLD",
          },
        ],
      ]),
    );

    const outcome = await auctionLotImportService.runImportFromBuffer(
      1,
      1,
      Buffer.from(""),
      1,
      "2099-06-15",
    );
    expect(outcome.kind).toBe("imported");
    if (outcome.kind !== "imported") throw new Error("expected imported");
    const result = outcome.result;

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issues[0]?.reason).toBe(
      AuctionsValidationMessages.IMPORT_ROW_SKIPPED_WITHDRAWN,
    );
    expect(pgBulkInsertLotsMock).not.toHaveBeenCalled();
    expect(pgBulkUpdateLotsMock).not.toHaveBeenCalled();
  });

  it("imports only one row when two share a display order in-file", async () => {
    parseAuctionLotImportXlsxBufferMock.mockResolvedValue({
      rows: [
        row(2, { lotNumber: "A", displayOrder: 3 }),
        row(3, { lotNumber: "B", displayOrder: 3 }),
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
    expect(outcome.kind).toBe("imported");
    if (outcome.kind !== "imported") throw new Error("expected imported");
    const result = outcome.result;

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(
      result.issues.find((issue) => issue.kind === "skipped")?.reason,
    ).toBe(AuctionsValidationMessages.DUPLICATE_DISPLAY_ORDER_IN_FILE(3));
    expect(
      result.issues.find((issue) => issue.kind === "uploaded")?.rowNumber,
    ).toBe(3);
    expect(pgBulkInsertLotsMock).toHaveBeenCalledTimes(1);
    const inserted = pgBulkInsertLotsMock.mock.calls[0]?.[2] as {
      lotNumber: string;
    }[];
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.lotNumber).toBe("B");
  });
});
