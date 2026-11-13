import { describe, expect, it } from "vitest";
import { legacyAvailFlagToIsActive } from "./legacy-flags.js";

describe("legacy-flags", () => {
  it("maps AvailFlag 1 to active", () => {
    expect(legacyAvailFlagToIsActive(1)).toBe(true);
  });

  it("maps AvailFlag 0 to inactive", () => {
    expect(legacyAvailFlagToIsActive(0)).toBe(false);
  });

  it("defaults null to active", () => {
    expect(legacyAvailFlagToIsActive(null)).toBe(true);
    expect(legacyAvailFlagToIsActive(undefined)).toBe(true);
  });
});
