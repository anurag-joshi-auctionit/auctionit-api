import {
  createDecipheriv,
  createHash,
} from "node:crypto";
import { env } from "../env.js";

function tripleDesKey(securityKey: string): Buffer {
  const md5 = createHash("md5").update(securityKey, "utf8").digest();
  return Buffer.concat([md5, md5.subarray(0, 8)]);
}

/**
 * Decrypts a legacy TripleDES-ECB bank field from AuctionIT 5.0.
 * Returns the original value when decryption fails (plain-text backfill rows).
 */
export function decryptLegacyBankField(cipher: string | null | undefined): string | null {
  if (cipher == null || cipher === "") return null;
  try {
    const key = tripleDesKey(env.LEGACY_BANK_ENCRYPTION_KEY);
    const decipher = createDecipheriv("des-ede3", key, null);
    let decrypted = decipher.update(cipher, "base64", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    return cipher;
  }
}
