import { describe, expect, it } from "vitest";
import {
  equalLengthPriorPeriod,
  formatDashboardPeriodLabel,
  inclusiveDaySpan,
  inclusiveMonthSpan,
  percentChange,
  resolveMaterialSeriesGrain,
} from "./prior-period.js";

describe("inclusiveDaySpan", () => {
  it("counts inclusive calendar days", () => {
    expect(inclusiveDaySpan("2026-06-01", "2026-06-30")).toBe(30);
    expect(inclusiveDaySpan("2026-06-15", "2026-06-15")).toBe(1);
  });
});

describe("inclusiveMonthSpan", () => {
  it("counts inclusive calendar months", () => {
    expect(inclusiveMonthSpan("2025-01-01", "2025-12-31")).toBe(12);
    expect(inclusiveMonthSpan("2025-01-15", "2025-01-20")).toBe(1);
    expect(inclusiveMonthSpan("2024-01-01", "2026-12-31")).toBe(36);
  });
});

describe("resolveMaterialSeriesGrain", () => {
  it("uses month for ranges up to 18 months", () => {
    expect(
      resolveMaterialSeriesGrain({ from: "2025-01-01", to: "2025-12-31" }),
    ).toBe("month");
    expect(
      resolveMaterialSeriesGrain({ from: "2024-07-01", to: "2025-12-31" }),
    ).toBe("month");
  });

  it("uses quarter for ranges up to 36 months", () => {
    expect(
      resolveMaterialSeriesGrain({ from: "2023-01-01", to: "2025-12-31" }),
    ).toBe("quarter");
  });

  it("uses year beyond 36 months", () => {
    expect(
      resolveMaterialSeriesGrain({ from: "2022-01-01", to: "2025-12-31" }),
    ).toBe("year");
  });
});

describe("equalLengthPriorPeriod", () => {
  it("returns the equal-length window before from", () => {
    expect(equalLengthPriorPeriod({ from: "2026-06-01", to: "2026-06-30" })).toEqual({
      from: "2026-05-02",
      to: "2026-05-31",
    });
  });

  it("handles single-day ranges", () => {
    expect(equalLengthPriorPeriod({ from: "2026-06-15", to: "2026-06-15" })).toEqual({
      from: "2026-06-14",
      to: "2026-06-14",
    });
  });
});

describe("formatDashboardPeriodLabel", () => {
  it("formats DD MMM YYYY – DD MMM YYYY", () => {
    expect(
      formatDashboardPeriodLabel({ from: "2026-05-02", to: "2026-05-31" }),
    ).toBe("02 May 2026 – 31 May 2026");
  });
});

describe("percentChange", () => {
  it("handles zero baselines", () => {
    expect(percentChange(0, 0)).toBe(0);
    expect(percentChange(10, 0)).toBe(100);
    expect(percentChange(-5, 0)).toBe(-100);
  });

  it("computes relative change", () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(75, 100)).toBe(-25);
  });
});
