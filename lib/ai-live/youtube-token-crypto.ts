import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

function encryptionKey(): Buffer {
  const encoded = process.env.AI_LIVE_OAUTH_ENCRYPTION_KEY?.trim() ?? "";
  if (!encoded) throw new Error("youtube_token_encryption_not_configured");
  let key: Buffer;
  if (/^[a-f0-9]{64}$/i.test(encoded)) key = Buffer.from(encoded, "hex");
  else {
    key = Buffer.from(encoded, "base64");
    if (key.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
      throw new Error("youtube_token_encryption_key_invalid");
    }
  }
  if (key.byteLength !== 32) throw new Error("youtube_token_encryption_key_invalid");
  return key;
}

export function encryptYouTubeRefreshToken(token: string) {
  if (typeof token !== "string" || token.length < 10 || token.length > 8192) {
    throw new Error("youtube_refresh_token_invalid");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptYouTubeRefreshToken(input: {
  ciphertext: string;
  iv: string;
  authTag: string;
}): string {
  const ciphertext = Buffer.from(input.ciphertext, "base64");
  const iv = Buffer.from(input.iv, "base64");
  const authTag = Buffer.from(input.authTag, "base64");
  if (iv.byteLength !== 12 || authTag.byteLength !== 16 || ciphertext.byteLength < 10 || ciphertext.byteLength > 8192) {
    throw new Error("youtube_token_ciphertext_invalid");
  }
  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  if (plaintext.length < 10 || plaintext.length > 8192) throw new Error("youtube_refresh_token_invalid");
  return plaintext;
}
