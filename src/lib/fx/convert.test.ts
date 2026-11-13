import { describe, expect, it } from "vitest";
import { convertToInr, formatRate } from "./convert.js";

describe("convertToInr", () => {
  it("multiplies price by rate and rounds to paise", () => {
    expect(convertToInr("9013.08", "95.970000")).toBe("864985.29");
    expect(convertToInr(13445, 94.49)).toBe("1270418.05");
  });

  it("rounds half away from zero like Postgres round(numeric, 2)", () => {
    // 0.01 * 0.5 = 0.005 → 0.01
    expect(convertToInr("0.01", "0.5")).toBe("0.01");
    // 1.25 * 1.1 = 1.375 → 1.38
    expect(convertToInr("1.25", "1.1")).toBe("1.38");
  });

  it("is exact where float multiplication drifts", () => {
    // 1.01 * 99.5 = 100.495 exactly, but 100.49499999999999 as a float
    expect(convertToInr("1.01", "99.5")).toBe("100.50");
    expect(convertToInr("0.10", "3")).toBe("0.30");
  });

  it("leaves INR prices unchanged at rate 1", () => {
    expect(convertToInr("668736.87", "1")).toBe("668736.87");
    expect(convertToInr(0, 1)).toBe("0.00");
  });
});

describe("formatRate", () => {
  it("formats to six decimals", () => {
    expect(formatRate(95.97)).toBe("95.970000");
    expect(formatRate(1)).toBe("1.000000");
    expect(formatRate("83.1234567")).toBe("83.123457");
  });
});
