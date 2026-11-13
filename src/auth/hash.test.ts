import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  hashPasswordForStorage,
  verifyPassword,
  wrapMd5Hash,
} from "./hash.js";

const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

describe("password hashing", () => {
  it("stores new passwords as bcrypt", async () => {
    const { hash, algo } = await hashPasswordForStorage("secret");
    expect(algo).toBe("bcrypt");
    expect(hash).toMatch(/^\$2[aby]\$10\$/);
    expect(await verifyPassword("secret", hash, "bcrypt")).toBe(true);
    expect(await verifyPassword("wrong", hash, "bcrypt")).toBe(false);
  });

  it("verifies a bcrypt-wrapped MD5 hash, including uppercase legacy hex", async () => {
    const wrapped = await wrapMd5Hash(md5("secret").toUpperCase());
    expect(await verifyPassword("secret", wrapped, "bcrypt_md5")).toBe(true);
    expect(await verifyPassword("wrong", wrapped, "bcrypt_md5")).toBe(false);
  });

  it("still verifies a legacy MD5 row", async () => {
    expect(await verifyPassword("secret", md5("secret"), "md5")).toBe(true);
    expect(await verifyPassword("wrong", md5("secret"), "md5")).toBe(false);
  });
});
