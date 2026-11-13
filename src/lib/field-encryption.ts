import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../env.js";

const VERSION_PREFIX = "v1:";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ALGORITHM = "aes-256-gcm";

function encryptionKey(): Buffer {
  const raw =
    process.env.SENSITIVE_DATA_ENCRYPTION_KEY ?? env.SENSITIVE_DATA_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "SENSITIVE_DATA_ENCRYPTION_KEY must be set to encrypt or decrypt bank fields.",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      "SENSITIVE_DATA_ENCRYPTION_KEY must be a base64-encoded 32-byte value.",
    );
  }
  return key;
}

export function encryptField(plain: string | null | undefined): string | null {
  if (plain == null || plain === "") return null;
  const key = encryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, authTag, encrypted]);
  return `${VERSION_PREFIX}${payload.toString("base64")}`;
}

export function decryptField(stored: string | null | undefined): string | null {
  if (stored == null || stored === "") return null;
  if (!stored.startsWith(VERSION_PREFIX)) {
    throw new Error("Unsupported encrypted field format.");
  }
  const key = encryptionKey();
  const payload = Buffer.from(stored.slice(VERSION_PREFIX.length), "base64");
  if (payload.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new Error("Encrypted field payload is too short.");
  }
  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

export function decryptFieldOrNull(
  stored: string | null | undefined,
): string | null {
  if (stored == null || stored === "") return null;
  try {
    return decryptField(stored);
  } catch {
    return null;
  }
}
