import { describe, expect, it } from "vitest";
import { decryptField, encryptField } from "./field-encryption.js";

// 32-byte key encoded as base64 for tests.
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

describe("field-encryption", () => {
  it("round-trips plaintext", () => {
    process.env.SENSITIVE_DATA_ENCRYPTION_KEY = TEST_KEY;
    const plain = "HDFC0001234";
    const stored = encryptField(plain);
    expect(stored).toMatch(/^v1:/);
    expect(stored).not.toBe(plain);
    expect(decryptField(stored)).toBe(plain);
  });

  it("returns null for empty values", () => {
    process.env.SENSITIVE_DATA_ENCRYPTION_KEY = TEST_KEY;
    expect(encryptField(null)).toBeNull();
    expect(encryptField("")).toBeNull();
    expect(decryptField(null)).toBeNull();
  });

  it("rejects tampered ciphertext", () => {
    process.env.SENSITIVE_DATA_ENCRYPTION_KEY = TEST_KEY;
    const stored = encryptField("secret");
    if (!stored) throw new Error("expected ciphertext");
    const buf = Buffer.from(stored.slice(3), "base64");
    buf[buf.length - 1] ^= 0xff;
    const tampered = `v1:${buf.toString("base64")}`;
    expect(() => decryptField(tampered)).toThrow();
  });
});
