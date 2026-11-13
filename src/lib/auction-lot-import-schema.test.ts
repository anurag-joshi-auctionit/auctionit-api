import { AuctionsValidationMessages } from "@auctionit/messages/auctions";
import { describe, expect, it } from "vitest";
import { parseAuctionLotImportSheetRows } from "./auction-lot-import-parse.js";
import { auctionLotImportRowSchema, refineBidIncrementVsPrice, refineBidLimitVsStartPrice } from "./auction-lot-import-schema.js";
import { auctionLotWriteSchema } from "./auction-lot-write-schema.js";

describe("auctionLotWriteSchema", () => {
  const base = {
    lotNumber: "L1",
    materialLiftingDays: 7,
    plantLocationId: 1,
    materialLocationId: 2,
    gstPercentage: 18,
    tcsPercentage: 1,
    startBidPrice: 100,
    bidLimit: 200,
    bidIncrement: 10,
    lotStartTime: "2026-07-10T10:00:00.000Z",
    lotEndTime: "2026-07-10T12:00:00.000Z",
    loadingScope: "Buyer",
    displayOrder: 1.5,
    remark: "ok",
    itemId: 9,
    quantity: 12.5,
    uomCode: "MT",
    benchmarkMaterialLocationId: 3,
    materialName: "Scrap",
  };

  it("accepts Buyer loading scope and GST enum", () => {
    const parsed = auctionLotWriteSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.loadingScope).toBe("buyer");
      expect(parsed.data.gstPercentage).toBe(18);
      expect(parsed.data.materialDescription).toBeNull();
      expect(parsed.data.lotStartTime).toBe("10:00:00");
      expect(parsed.data.lotEndTime).toBe("12:00:00");
    }
  });

  it("accepts null materialLiftingDays and benchmarkMaterialLocationId", () => {
    const parsed = auctionLotWriteSchema.safeParse({
      ...base,
      materialLiftingDays: null,
      benchmarkMaterialLocationId: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts null materialLocationId", () => {
    const parsed = auctionLotWriteSchema.safeParse({
      ...base,
      materialLocationId: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts zero materialLiftingDays", () => {
    const parsed = auctionLotWriteSchema.safeParse({
      ...base,
      materialLiftingDays: 0,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects invalid GST", () => {
    const parsed = auctionLotWriteSchema.safeParse({
      ...base,
      gstPercentage: 7,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts null loading scope", () => {
    const parsed = auctionLotWriteSchema.safeParse({
      ...base,
      loadingScope: null,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.loadingScope).toBeNull();
    }
  });

  it("treats empty loading scope as null", () => {
    const parsed = auctionLotWriteSchema.safeParse({
      ...base,
      loadingScope: "",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.loadingScope).toBeNull();
    }
  });

  it("rejects invalid loading scope with a user-facing message", () => {
    const parsed = auctionLotWriteSchema.safeParse({
      ...base,
      loadingScope: "both",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.flatten().fieldErrors.loadingScope).toEqual([
        AuctionsValidationMessages.LOADING_SCOPE_INVALID,
      ]);
    }
  });

  it("allows a bid increment arbitrarily far above start bid price", () => {
    const parsed = auctionLotWriteSchema.safeParse({
      ...base,
      startBidPrice: 1000,
      bidLimit: 2_000_000,
      bidIncrement: 1_000_000,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects zero bid increment", () => {
    const parsed = auctionLotWriteSchema.safeParse({
      ...base,
      bidIncrement: 0,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.flatten().fieldErrors.bidIncrement).toEqual([
        AuctionsValidationMessages.BID_STEP_MUST_BE_POSITIVE("Bid Increment"),
      ]);
    }
  });

  it("rejects zero startBidPrice", () => {
    const parsed = auctionLotWriteSchema.safeParse({
      ...base,
      startBidPrice: 0,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.flatten().fieldErrors.startBidPrice).toEqual([
        AuctionsValidationMessages.START_BID_PRICE_MUST_BE_POSITIVE,
      ]);
    }
  });

  it("rejects equal lot start and end times", () => {
    const parsed = auctionLotWriteSchema.safeParse({
      ...base,
      lotStartTime: "10:00:00",
      lotEndTime: "10:00:00",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.flatten().fieldErrors.lotEndTime).toEqual([
        AuctionsValidationMessages.LOT_END_TIME_BEFORE_START,
      ]);
    }
  });

  it("rejects bidLimit equal to startBidPrice for forward auctions", () => {
    const parsed = auctionLotWriteSchema.safeParse({
      ...base,
      startBidPrice: 100,
      bidLimit: 100,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.flatten().fieldErrors.bidLimit).toEqual([
        AuctionsValidationMessages.BID_LIMIT_VS_START_BID_PRICE_FORWARD,
      ]);
    }
  });

  it("accepts zero quantity", () => {
    const parsed = auctionLotWriteSchema.safeParse({
      ...base,
      quantity: 0,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects null quantity", () => {
    const parsed = auctionLotWriteSchema.safeParse({
      ...base,
      quantity: null,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.flatten().fieldErrors.quantity).toEqual([
        AuctionsValidationMessages.QUANTITY_REQUIRED,
      ]);
    }
  });

  it("rejects negative quantity", () => {
    const parsed = auctionLotWriteSchema.safeParse({
      ...base,
      quantity: -1,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.flatten().fieldErrors.quantity).toEqual([
        AuctionsValidationMessages.QUANTITY_MUST_BE_NON_NEGATIVE,
      ]);
    }
  });
});

const importBase = {
  lotNumber: "L1",
  materialLiftingDays: 1,
  plantLocation: "A",
  materialLocation: "B",
  gstPercentage: 5,
  tcsPercentage: 1,
  startBidPrice: 100,
  bidLimit: 200,
  bidIncrement: 10,
  lotStartTime: "10:00:00",
  lotEndTime: "12:00:00",
  loadingScope: "buyer",
  displayOrder: 1,
  remark: "r",
  itemId: 1,
  quantity: 1,
  uom: "MT",
  benchmarkMaterial: "X@@Y",
  materialName: "Scrap",
  materialDescription: null as string | null,
};

describe("auctionLotImportRowSchema", () => {
  it("accepts null itemId when materialName is present", () => {
    const parsed = auctionLotImportRowSchema.safeParse({
      ...importBase,
      itemId: null,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.itemId).toBeNull();
    }
  });

  it("requires material name", () => {
    const parsed = auctionLotImportRowSchema.safeParse({
      ...importBase,
      materialName: "",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts empty remark", () => {
    const parsed = auctionLotImportRowSchema.safeParse({
      ...importBase,
      remark: "",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.remark).toBe("");
    }
  });

  it("rejects equal lot times", () => {
    const parsed = auctionLotImportRowSchema.safeParse({
      ...importBase,
      lotStartTime: "10:00:00",
      lotEndTime: "10:00:00",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.flatten().fieldErrors.lotEndTime).toEqual([
        AuctionsValidationMessages.LOT_END_TIME_BEFORE_START,
      ]);
    }
  });

  it("rejects bidLimit equal to startBidPrice for forward auctions", () => {
    expect(
      refineBidLimitVsStartPrice(
        { startBidPrice: 100, bidLimit: 100 },
        "forward",
      ),
    ).toBe(AuctionsValidationMessages.BID_LIMIT_VS_START_BID_PRICE_FORWARD);
  });

  it("normalizes ISO times before cross-field compare", () => {
    const parsed = auctionLotImportRowSchema.safeParse({
      ...importBase,
      lotStartTime: "2026-07-10T10:00:00.000Z",
      lotEndTime: "2026-07-10T12:00:00.000Z",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.lotStartTime).toBe("10:00:00");
      expect(parsed.data.lotEndTime).toBe("12:00:00");
    }
  });

  it("rejects bidLimit below startBidPrice for forward auctions", () => {
    const parsed = auctionLotImportRowSchema.safeParse({
      ...importBase,
      startBidPrice: 200,
      bidLimit: 100,
    });
    // Schema no longer enforces direction; refineBidLimitVsStartPrice does.
    expect(parsed.success).toBe(true);
    expect(
      refineBidLimitVsStartPrice(
        { startBidPrice: 200, bidLimit: 100 },
        "forward",
      ),
    ).toBeTruthy();
  });

  it("rejects bidLimit at or above startBidPrice for reverse auctions", () => {
    expect(
      refineBidLimitVsStartPrice(
        { startBidPrice: 200, bidLimit: 200 },
        "reverse",
      ),
    ).toBeTruthy();
    expect(
      refineBidLimitVsStartPrice(
        { startBidPrice: 200, bidLimit: 100 },
        "reverse",
      ),
    ).toBeNull();
  });

  it("allows a bid increment arbitrarily far above start bid price on import refine", () => {
    expect(
      refineBidIncrementVsPrice(
        {
          startBidPrice: 1000,
          bidIncrement: 1_000_000,
        },
        "forward",
      ),
    ).toBeNull();
    expect(
      refineBidIncrementVsPrice(
        {
          startBidPrice: 1000,
          bidIncrement: 1_000_000,
        },
        "reverse",
      ),
    ).toBeNull();
  });

  it("rejects lotEndTime before lotStartTime", () => {
    const parsed = auctionLotImportRowSchema.safeParse({
      ...importBase,
      lotStartTime: "12:00:00",
      lotEndTime: "10:00:00",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects lotEndTime equal to lotStartTime", () => {
    const parsed = auctionLotImportRowSchema.safeParse({
      ...importBase,
      lotStartTime: "12:00:00",
      lotEndTime: "12:00:00",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts 24h HH:mm on both start and end", () => {
    const parsed = auctionLotImportRowSchema.safeParse({
      ...importBase,
      lotStartTime: "13:00",
      lotEndTime: "13:30",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.lotStartTime).toBe("13:00:00");
      expect(parsed.data.lotEndTime).toBe("13:30:00");
    }
  });

  it("accepts AM/PM on start only (end stays 24h)", () => {
    const parsed = auctionLotImportRowSchema.safeParse({
      ...importBase,
      lotStartTime: "1:00 PM",
      lotEndTime: "13:30",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.lotStartTime).toBe("13:00:00");
      expect(parsed.data.lotEndTime).toBe("13:30:00");
    }
  });

  it("accepts AM/PM on end only (start stays 24h) — reported gap", () => {
    const parsed = auctionLotImportRowSchema.safeParse({
      ...importBase,
      lotStartTime: "13:00",
      lotEndTime: "1:30PM",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.lotStartTime).toBe("13:00:00");
      expect(parsed.data.lotEndTime).toBe("13:30:00");
    }
  });

  it("accepts AM/PM on both start and end", () => {
    const parsed = auctionLotImportRowSchema.safeParse({
      ...importBase,
      lotStartTime: "1:00PM",
      lotEndTime: "1:30 PM",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.lotStartTime).toBe("13:00:00");
      expect(parsed.data.lotEndTime).toBe("13:30:00");
    }
  });

  it.each([
    ["startBidPrice", 0],
    ["bidLimit", 0],
    ["displayOrder", 0],
    ["bidIncrement", 0],
  ] as const)("rejects zero for %s", (field, value) => {
    const parsed = auctionLotImportRowSchema.safeParse({
      ...importBase,
      [field]: value,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts zero quantity", () => {
    const parsed = auctionLotImportRowSchema.safeParse({
      ...importBase,
      quantity: 0,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects negative quantity", () => {
    const parsed = auctionLotImportRowSchema.safeParse({
      ...importBase,
      quantity: -1,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.flatten().fieldErrors.quantity).toEqual([
        AuctionsValidationMessages.QUANTITY_MUST_BE_NON_NEGATIVE,
      ]);
    }
  });

  it("rejects zero startBidPrice with message constant", () => {
    const parsed = auctionLotImportRowSchema.safeParse({
      ...importBase,
      startBidPrice: 0,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.flatten().fieldErrors.startBidPrice).toEqual([
        AuctionsValidationMessages.START_BID_PRICE_MUST_BE_POSITIVE,
      ]);
    }
  });

  it("rejects zero bidIncrement via refine with direction label", () => {
    expect(
      refineBidIncrementVsPrice(
        { startBidPrice: 1000, bidIncrement: 0 },
        "forward",
      ),
    ).toBe(
      AuctionsValidationMessages.BID_STEP_MUST_BE_POSITIVE("Bid Increment"),
    );
    expect(
      refineBidIncrementVsPrice(
        { startBidPrice: 1000, bidIncrement: 0 },
        "reverse",
      ),
    ).toBe(
      AuctionsValidationMessages.BID_STEP_MUST_BE_POSITIVE("Bid Decrement"),
    );
  });

  it("accepts zero tcsPercentage", () => {
    const parsed = auctionLotImportRowSchema.safeParse({
      ...importBase,
      tcsPercentage: 0,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts zero materialLiftingDays", () => {
    const parsed = auctionLotImportRowSchema.safeParse({
      ...importBase,
      materialLiftingDays: 0,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts null materialLiftingDays and benchmarkMaterial", () => {
    const parsed = auctionLotImportRowSchema.safeParse({
      ...importBase,
      materialLiftingDays: null,
      benchmarkMaterial: null,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.materialLiftingDays).toBeNull();
      expect(parsed.data.benchmarkMaterial).toBeNull();
    }
  });

  it("accepts empty benchmarkMaterial as null", () => {
    const parsed = auctionLotImportRowSchema.safeParse({
      ...importBase,
      benchmarkMaterial: "",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.benchmarkMaterial).toBeNull();
    }
  });

  it("accepts null materialLocation", () => {
    const parsed = auctionLotImportRowSchema.safeParse({
      ...importBase,
      materialLocation: null,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.materialLocation).toBeNull();
    }
  });

  it("accepts empty materialLocation as null", () => {
    const parsed = auctionLotImportRowSchema.safeParse({
      ...importBase,
      materialLocation: "",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.materialLocation).toBeNull();
    }
  });

  it("rejects materialName over max length", () => {
    const parsed = auctionLotImportRowSchema.safeParse({
      ...importBase,
      materialName: "x".repeat(501),
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects remark over max length", () => {
    const parsed = auctionLotImportRowSchema.safeParse({
      ...importBase,
      remark: "x".repeat(201),
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects materialDescription over max length", () => {
    const parsed = auctionLotImportRowSchema.safeParse({
      ...importBase,
      materialDescription: "x".repeat(1001),
    });
    expect(parsed.success).toBe(false);
  });
});

describe("parseAuctionLotImportSheetRows", () => {
  const camelHeaders = [
    "lotNumber",
    "materialLiftingDays",
    "plantLocation",
    "materialLocation",
    "gstPercentage",
    "tcsPercentage",
    "startBidPrice",
    "bidLimit",
    "bidIncrement",
    "lotStartTime",
    "lotEndTime",
    "loadingScope",
    "displayOrder",
    "remark",
    "itemId",
    "quantity",
    "uom",
    "benchmarkMaterial",
    "materialName",
    "materialDescription",
  ];

  it("parses camelCase headers and optional material description", () => {
    const matrix = [
      camelHeaders,
      [
        "LOT-1",
        5,
        "Hisar",
        "Hisar",
        18,
        1,
        1000,
        2000,
        50,
        45848.5,
        45848.75,
        "Seller",
        1.0,
        "",
        "Pipe@@42",
        10,
        "MT",
        "Billet@@Ex Rourkela",
        "Mix",
        "",
      ],
    ];

    const result = parseAuctionLotImportSheetRows(matrix);
    expect(result.rowErrors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.data.itemId).toBe(42);
    expect(result.rows[0]?.data.loadingScope).toBe("seller");
    expect(result.rows[0]?.data.materialDescription).toBeNull();
    expect(result.rows[0]?.data.remark).toBe("");
  });

  it("defaults empty loading scope to buyer", () => {
    const matrix = [
      camelHeaders,
      [
        "LOT-2",
        5,
        "Hisar",
        "Hisar",
        18,
        1,
        1000,
        2000,
        50,
        "10:00:00",
        "12:00:00",
        "",
        1.0,
        "",
        "Pipe@@42",
        10,
        "MT",
        "Billet@@Ex Rourkela",
        "Mix",
        "",
      ],
    ];

    const result = parseAuctionLotImportSheetRows(matrix);
    expect(result.rowErrors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.data.loadingScope).toBe("buyer");
  });

  it("allows empty materialLiftingDays and benchmarkMaterial", () => {
    const matrix = [
      camelHeaders,
      [
        "LOT-3",
        "",
        "Hisar",
        "Hisar",
        18,
        1,
        1000,
        2000,
        50,
        "10:00:00",
        "12:00:00",
        "Seller",
        1.0,
        "",
        "Pipe@@42",
        10,
        "MT",
        "",
        "Mix",
        "",
      ],
    ];

    const result = parseAuctionLotImportSheetRows(matrix);
    expect(result.rowErrors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.data.materialLiftingDays).toBeNull();
    expect(result.rows[0]?.data.benchmarkMaterial).toBeNull();
  });

  it("allows empty materialLocation", () => {
    const matrix = [
      camelHeaders,
      [
        "LOT-3b",
        5,
        "Hisar",
        "",
        18,
        1,
        1000,
        2000,
        50,
        "10:00:00",
        "12:00:00",
        "Seller",
        1.0,
        "",
        "Pipe@@42",
        10,
        "MT",
        "",
        "Mix",
        "",
      ],
    ];

    const result = parseAuctionLotImportSheetRows(matrix);
    expect(result.rowErrors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.data.materialLocation).toBeNull();
  });

  it("allows blank itemId when materialName is filled", () => {
    const matrix = [
      camelHeaders,
      [
        "LOT-5",
        5,
        "Hisar",
        "Hisar",
        18,
        1,
        1000,
        2000,
        50,
        "10:00:00",
        "12:00:00",
        "Seller",
        1.0,
        "",
        "",
        10,
        "MT",
        "",
        "Mix Scrap",
        "",
      ],
    ];

    const result = parseAuctionLotImportSheetRows(matrix);
    expect(result.rowErrors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.data.itemId).toBeNull();
    expect(result.rows[0]?.data.materialName).toBe("Mix Scrap");
  });

  it("rejects empty tcsPercentage", () => {
    const matrix = [
      camelHeaders,
      [
        "LOT-4",
        5,
        "Hisar",
        "Hisar",
        18,
        "",
        1000,
        2000,
        50,
        "10:00:00",
        "12:00:00",
        "Seller",
        1.0,
        "",
        "Pipe@@42",
        10,
        "MT",
        "Billet@@Ex Rourkela",
        "Mix",
        "",
      ],
    ];

    const result = parseAuctionLotImportSheetRows(matrix);
    expect(result.rows).toHaveLength(0);
    expect(result.rowErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldErrors: expect.objectContaining({
            tcsPercentage: expect.arrayContaining([
              expect.stringMatching(/required/i),
            ]),
          }),
        }),
      ]),
    );
  });
});
