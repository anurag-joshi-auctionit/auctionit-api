import { describe, expect, it } from "vitest";
import { castImportTimeOfDay } from "./date.js";

describe("castImportTimeOfDay", () => {
  it.each([
    ["13:00", "13:00:00"],
    ["13:30", "13:30:00"],
    ["13:00:00", "13:00:00"],
    ["9:05", "09:05:00"],
  ] as const)("parses 24h %s → %s", (input, expected) => {
    expect(castImportTimeOfDay(input)).toBe(expected);
  });

  it.each([
    ["1:00 PM", "13:00:00"],
    ["1:00PM", "13:00:00"],
    ["1:30 pm", "13:30:00"],
    ["12:00 AM", "00:00:00"],
    ["12:00PM", "12:00:00"],
    ["1:00:00 p.m.", "13:00:00"],
  ] as const)("parses defensive 12h %s → %s", (input, expected) => {
    expect(castImportTimeOfDay(input)).toBe(expected);
  });

  it("parses Excel time serial for 13:00", () => {
    expect(castImportTimeOfDay(13 / 24)).toBe("13:00:00");
  });

  it("parses Excel time serial for 13:30", () => {
    expect(castImportTimeOfDay(13.5 / 24)).toBe("13:30:00");
  });

  it("returns null for invalid strings", () => {
    expect(castImportTimeOfDay("not-a-time")).toBeNull();
    expect(castImportTimeOfDay("25:00")).toBeNull();
    expect(castImportTimeOfDay("")).toBeNull();
  });
});
