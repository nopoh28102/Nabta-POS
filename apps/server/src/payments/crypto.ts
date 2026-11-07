import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

export interface EncryptedValue {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

function encryptionKey(raw: string | undefined): Buffer {
  if (!raw) throw new Error("NABTA_PAYMENT_ENCRYPTION_KEY is required before saving payment credentials");
  const key = Buffer.from(raw, "base64url");
  if (key.length !== 32) throw new Error("NABTA_PAYMENT_ENCRYPTION_KEY must be a 32-byte base64url value");
  return key;
}

export function encryptPaymentSecret(value: string, keyMaterial: string | undefined): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(keyMaterial), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { version: 1, iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") };
}

export function decryptPaymentSecret(value: EncryptedValue, keyMaterial: string | undefined): string {
  if (value.version !== 1) throw new Error("Unsupported payment secret encryption version");
  const decipher = createDecipheriv(ALGORITHM, encryptionKey(keyMaterial), Buffer.from(value.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64url")), decipher.final()]).toString("utf8");
}
