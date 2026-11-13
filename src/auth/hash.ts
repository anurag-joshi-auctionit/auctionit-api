import bcrypt from "bcryptjs";
import { createHash, timingSafeEqual } from "node:crypto";

const COST = 10;

/**
 * `bcrypt` — bcrypt of the plaintext (every write).
 * `bcrypt_md5` — bcrypt of a legacy MD5 hex, from `db:upgrade-md5-passwords`;
 *   upgraded to `bcrypt` on the user's next successful login.
 * `md5` — legacy unsalted MD5; still verified so a row the upgrade missed
 *   can't lock its user out, but never written.
 */
export type PasswordAlgo = "md5" | "bcrypt_md5" | "bcrypt";

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

function md5Hex(plain: string): string {
  return createHash("md5").update(plain, "utf8").digest("hex");
}

export async function hashPasswordForStorage(
  plain: string,
): Promise<{ hash: string; algo: PasswordAlgo }> {
  return { hash: await hashPassword(plain), algo: "bcrypt" };
}

/** Wraps a stored legacy MD5 hex in bcrypt (algo `bcrypt_md5`). */
export function wrapMd5Hash(md5hex: string): Promise<string> {
  return bcrypt.hash(md5hex.toLowerCase(), COST);
}

export async function verifyPassword(
  plain: string,
  hash: string,
  algo: PasswordAlgo,
): Promise<boolean> {
  if (algo === "bcrypt") return bcrypt.compare(plain, hash);
  if (algo === "bcrypt_md5") return bcrypt.compare(md5Hex(plain), hash);
  return verifyMd5(plain, hash);
}

function verifyMd5(plain: string, hash: string): boolean {
  const computed = md5Hex(plain);
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(hash.toLowerCase(), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
