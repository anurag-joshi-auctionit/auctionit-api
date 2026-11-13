import { describe, expect, it } from "vitest";
import {
  endOfTermMonth,
  firstOfCurrentMonthIST,
  isFromMonthOnOrAfterPaymentMonth,
  normalizeToFirst,
  periodFromPaymentDate,
  periodFromStartMonth,
} from "./period.js";

describe("normalizeToFirst", () => {
  it("snaps mid-month payment to the 1st", () => {
    expect(normalizeToFirst("2026-07-23")).toBe("2026-07-01");
  });

  it("leaves an already-first date unchanged", () => {
    expect(normalizeToFirst("2026-01-01")).toBe("2026-01-01");
  });
});

describe("endOfTermMonth", () => {
  it("annual (12): Jul → end of Jun next year", () => {
    expect(endOfTermMonth("2026-07-01", 12)).toBe("2027-06-30");
  });

  it("annual from January ends Dec same year", () => {
    expect(endOfTermMonth("2026-01-01", 12)).toBe("2026-12-31");
  });

  it("annual from December ends Nov next year", () => {
    expect(endOfTermMonth("2026-12-01", 12)).toBe("2027-11-30");
  });

  it("one month ends end of from month", () => {
    expect(endOfTermMonth("2026-02-01", 1)).toBe("2026-02-28");
  });

  it("leap February one-month term", () => {
    expect(endOfTermMonth("2024-02-01", 1)).toBe("2024-02-29");
  });
});

describe("periodFromPaymentDate", () => {
  it("annual: payment 23 Jul 2026 → 1 Jul 2026 through 30 Jun 2027", () => {
    expect(periodFromPaymentDate("2026-07-23", 12)).toEqual({
      fromDate: "2026-07-01",
      toDate: "2027-06-30",
    });
  });

  it("uses payment month only, ignoring day", () => {
    expect(periodFromPaymentDate("2026-07-01", 12)).toEqual(
      periodFromPaymentDate("2026-07-31", 12),
    );
  });
});

describe("periodFromStartMonth", () => {
  it("snaps mid-month from to the 1st then applies plan months", () => {
    expect(periodFromStartMonth("2026-09-15", 12)).toEqual({
      fromDate: "2026-09-01",
      toDate: "2027-08-31",
    });
  });
});

describe("isFromMonthOnOrAfterPaymentMonth", () => {
  it("allows from month equal to payment month", () => {
    expect(
      isFromMonthOnOrAfterPaymentMonth("2026-09-01", "2026-09-23"),
    ).toBe(true);
  });

  it("allows from month after payment month", () => {
    expect(
      isFromMonthOnOrAfterPaymentMonth("2026-10-01", "2026-09-23"),
    ).toBe(true);
  });

  it("rejects from month before payment month", () => {
    expect(
      isFromMonthOnOrAfterPaymentMonth("2026-08-01", "2026-09-23"),
    ).toBe(false);
  });
});

describe("firstOfCurrentMonthIST", () => {
  it("returns YYYY-MM-01 for a fixed IST instant", () => {
    // 2026-09-11 10:00 UTC is still 2026-09-11 in IST (+5:30)
    expect(firstOfCurrentMonthIST(new Date("2026-09-11T10:00:00.000Z"))).toBe(
      "2026-09-01",
    );
  });
});
