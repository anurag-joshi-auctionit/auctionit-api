import { describe, expect, it } from "vitest";
import { normalizeSubscriptionTransactionId } from "./transaction-id.js";

describe("normalizeSubscriptionTransactionId", () => {
  it("lowercases and strips internal whitespace", () => {
    expect(normalizeSubscriptionTransactionId("Ab C 123")).toBe("abc123");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeSubscriptionTransactionId("  TXN-9  ")).toBe("txn-9");
  });

  it("collapses tabs and newlines", () => {
    expect(normalizeSubscriptionTransactionId("a\tb\nc")).toBe("abc");
  });

  it("returns empty for whitespace-only input", () => {
    expect(normalizeSubscriptionTransactionId("   ")).toBe("");
  });
});
