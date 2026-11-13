import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const selectMock = vi.fn();
const insertMock = vi.fn();
const fetchRateMock = vi.fn();

vi.mock("../db/index.js", () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
  },
}));

vi.mock("../lib/fx/frankfurter.js", () => ({
  fetchRate: (...args: unknown[]) => fetchRateMock(...args),
  fetchRateRange: vi.fn(),
}));

const {
  fxRatesService,
  FxRateUnavailableError,
  isCachedRateCurrent,
} = await import("./fx-rates.service.js");

function cachedRate(row: { rateDate: string; rate: string } | null) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(async () => (row ? [row] : []));
  selectMock.mockReturnValue(chain);
}

function acceptInserts() {
  const values = vi.fn(() => ({ onConflictDoUpdate: vi.fn(async () => undefined) }));
  insertMock.mockReturnValue({ values });
  return values;
}

describe("isCachedRateCurrent", () => {
  it("accepts the same day", () => {
    expect(isCachedRateCurrent("2026-05-15", "2026-05-15")).toBe(true);
  });

  it("accepts the Friday rate for Saturday and Sunday", () => {
    expect(isCachedRateCurrent("2026-05-15", "2026-05-16")).toBe(true);
    expect(isCachedRateCurrent("2026-05-15", "2026-05-17")).toBe(true);
  });

  it("rejects an older rate on a weekday", () => {
    expect(isCachedRateCurrent("2026-05-15", "2026-05-18")).toBe(false);
    expect(isCachedRateCurrent("2026-05-13", "2026-05-14")).toBe(false);
  });
});

describe("fxRatesService.getRateToInr", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    selectMock.mockReset();
    insertMock.mockReset();
    fetchRateMock.mockReset();
  });

  it("returns rate 1 for INR without touching the cache or the API", async () => {
    await expect(fxRatesService.getRateToInr("INR", "2026-05-15")).resolves.toEqual({
      rate: "1.000000",
      rateDate: null,
    });
    expect(selectMock).not.toHaveBeenCalled();
    expect(fetchRateMock).not.toHaveBeenCalled();
  });

  it("uses a cached rate for the same day", async () => {
    cachedRate({ rateDate: "2026-05-15", rate: "95.970000" });
    await expect(fxRatesService.getRateToInr("USD", "2026-05-15")).resolves.toEqual({
      rate: "95.970000",
      rateDate: "2026-05-15",
    });
    expect(fetchRateMock).not.toHaveBeenCalled();
  });

  it("uses Friday's cached rate on a Saturday", async () => {
    cachedRate({ rateDate: "2026-05-15", rate: "95.970000" });
    await expect(fxRatesService.getRateToInr("USD", "2026-05-16")).resolves.toEqual({
      rate: "95.970000",
      rateDate: "2026-05-15",
    });
    expect(fetchRateMock).not.toHaveBeenCalled();
  });

  it("fetches and caches when the cache is stale", async () => {
    cachedRate({ rateDate: "2026-05-15", rate: "95.970000" });
    const values = acceptInserts();
    fetchRateMock.mockResolvedValue({ rateDate: "2026-05-18", rate: 96.35 });

    await expect(fxRatesService.getRateToInr("USD", "2026-05-18")).resolves.toEqual({
      rate: "96.350000",
      rateDate: "2026-05-18",
    });
    expect(fetchRateMock).toHaveBeenCalledWith("USD", "INR", "2026-05-18");
    expect(values).toHaveBeenCalledWith([
      expect.objectContaining({
        base: "USD",
        quote: "INR",
        rateDate: "2026-05-18",
        rate: "96.350000",
      }),
    ]);
  });

  it("falls back to a cached rate within the staleness window when the API fails", async () => {
    cachedRate({ rateDate: "2026-05-15", rate: "95.970000" });
    fetchRateMock.mockRejectedValue(new Error("network down"));

    await expect(fxRatesService.getRateToInr("USD", "2026-05-19")).resolves.toEqual({
      rate: "95.970000",
      rateDate: "2026-05-15",
    });
  });

  it("throws FxRateUnavailableError when the API fails and the cache is too old", async () => {
    cachedRate({ rateDate: "2026-04-01", rate: "93.000000" });
    fetchRateMock.mockRejectedValue(new Error("network down"));

    await expect(
      fxRatesService.getRateToInr("USD", "2026-05-19"),
    ).rejects.toBeInstanceOf(FxRateUnavailableError);
  });

  it("throws FxRateUnavailableError when the API fails and nothing is cached", async () => {
    cachedRate(null);
    fetchRateMock.mockRejectedValue(new Error("network down"));

    await expect(
      fxRatesService.getRateToInr("USD", "2026-05-19"),
    ).rejects.toBeInstanceOf(FxRateUnavailableError);
  });
});
