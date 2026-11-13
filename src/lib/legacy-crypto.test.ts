import { createCipheriv, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptLegacyBankField } from "./legacy-crypto.js";

function tripleDesKey(securityKey: string): Buffer {
  const md5 = createHash("md5").update(securityKey, "utf8").digest();
  return Buffer.concat([md5, md5.subarray(0, 8)]);
}

function encryptLegacyTripleDes(plain: string, securityKey = "MyComplexKey"): string {
  const key = tripleDesKey(securityKey);
  const cipher = createCipheriv("des-ede3", key, null);
  let encrypted = cipher.update(plain, "utf8", "base64");
  encrypted += cipher.final("base64");
  return encrypted;
}

describe("legacy-crypto", () => {
  it("decrypts TripleDES bank fields", () => {
    const plain = "123456789012";
    const cipher = encryptLegacyTripleDes(plain);
    expect(decryptLegacyBankField(cipher)).toBe(plain);
  });

  it("returns original value when not valid ciphertext", () => {
    expect(decryptLegacyBankField("HDFC Bank")).toBe("HDFC Bank");
  });
});
