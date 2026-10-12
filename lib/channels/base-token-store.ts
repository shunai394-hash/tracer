import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const PROVIDER = "base";
const ALGORITHM = "aes-256-gcm";

function encryptionKey(): Buffer {
  const raw = process.env.BASE_TOKEN_ENCRYPTION_KEY?.trim() ?? "";
  if (!/^[a-fA-F0-9]{64}$/.test(raw)) {
    throw new Error("BASE_TOKEN_ENCRYPTION_KEY_MUST_BE_32_BYTE_HEX");
  }
  return Buffer.from(raw, "hex");
}

function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString("base64url")).join(".");
}

function decrypt(value: string): string {
  const [ivPart, tagPart, ciphertextPart, extra] = value.split(".");
  if (!ivPart || !tagPart || !ciphertextPart || extra) {
    throw new Error("BASE_STORED_REFRESH_TOKEN_FORMAT_INVALID");
  }
  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export async function readStoredBaseRefreshToken(): Promise<string | null> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("integration_secret_store")
    .select("encrypted_value")
    .eq("provider", PROVIDER)
    .eq("secret_name", "refresh_token")
    .maybeSingle();
  if (error) throw new Error("BASE_REFRESH_TOKEN_STORE_READ_FAILED");
  if (!data?.encrypted_value) return null;
  return decrypt(String(data.encrypted_value));
}

export async function storeBaseRefreshToken(token: string): Promise<void> {
  if (!token.trim()) throw new Error("BASE_REFRESH_TOKEN_EMPTY");
  const admin = createSupabaseAdminClient();
  const { error } = await admin.from("integration_secret_store").upsert({
    provider: PROVIDER,
    secret_name: "refresh_token",
    encrypted_value: encrypt(token.trim()),
    updated_at: new Date().toISOString(),
  }, { onConflict: "provider,secret_name" });
  if (error) throw new Error("BASE_REFRESH_TOKEN_STORE_WRITE_FAILED");
}
