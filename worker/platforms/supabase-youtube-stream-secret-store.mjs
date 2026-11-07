import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";

const TABLE = "ai_live_stream_secrets";
const ALGORITHM = "aes-256-gcm";

function parseKey(value) {
  const encoded = typeof value === "string" ? value.trim() : "";
  if (!encoded) throw new Error("ai_live_stream_secret_encryption_key_required");
  let key;
  if (/^[a-f0-9]{64}$/i.test(encoded)) key = Buffer.from(encoded, "hex");
  else {
    key = Buffer.from(encoded, "base64");
    if (key.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
      throw new Error("ai_live_stream_secret_encryption_key_invalid");
    }
  }
  if (key.byteLength !== 32) throw new Error("ai_live_stream_secret_encryption_key_invalid");
  return key;
}

function encrypt(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    auth_tag: cipher.getAuthTag().toString("base64"),
  };
}

function decrypt(row, key) {
  const iv = Buffer.from(row.iv, "base64");
  const tag = Buffer.from(row.auth_tag, "base64");
  const ciphertext = Buffer.from(row.ciphertext, "base64");
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 2 || ciphertext.length > 8192) {
    throw new Error("ai_live_stream_secret_ciphertext_invalid");
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  const value = JSON.parse(plain);
  if (typeof value.ingestionAddress !== "string" || typeof value.streamName !== "string") {
    throw new Error("ai_live_stream_secret_payload_invalid");
  }
  return value;
}

function cleanBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("ai_live_stream_secret_supabase_url_must_use_https");
  }
  return url.toString().replace(/\/$/, "");
}

/**
 * Durable YouTube RTMP secret store. Only AES-256-GCM ciphertext is persisted.
 * Raw ingest details are returned only by resolve() to the FFmpeg publisher.
 */
export function createSupabaseYouTubeStreamSecretStore({
  url,
  serviceRoleKey,
  encryptionKey,
  fetchImpl = fetch,
  idFactory = randomUUID,
} = {}) {
  if (!url || typeof serviceRoleKey !== "string" || serviceRoleKey.length < 20 ||
      typeof fetchImpl !== "function" || typeof idFactory !== "function") {
    throw new Error("ai_live_stream_secret_store_configuration_required");
  }
  const baseUrl = cleanBaseUrl(url);
  const key = parseKey(encryptionKey);
  const endpoint = baseUrl + "/rest/v1/" + TABLE;

  async function request(path, { method = "GET", body, prefer } = {}) {
    const response = await fetchImpl(endpoint + path, {
      method,
      headers: {
        apikey: serviceRoleKey,
        authorization: "Bearer " + serviceRoleKey,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        ...(prefer ? { prefer } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
    });
    if (!response.ok) throw new Error("ai_live_stream_secret_store_http_" + response.status);
    const raw = await response.text();
    return raw ? JSON.parse(raw) : null;
  }

  return {
    async persistStreamSecret({ platform, streamId, ingestionAddress, streamName } = {}) {
      if (platform !== "youtube" || typeof streamId !== "string" ||
          !/^[A-Za-z0-9_-]{1,256}$/.test(streamId) ||
          typeof ingestionAddress !== "string" || !/^rtmps?:\/\//i.test(ingestionAddress) ||
          ingestionAddress.length > 2048 || typeof streamName !== "string" ||
          !streamName.trim() || streamName.length > 1024) {
        throw new Error("ai_live_stream_secret_input_invalid");
      }
      const id = idFactory();
      if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) {
        throw new Error("ai_live_stream_secret_reference_invalid");
      }
      const encrypted = encrypt({ ingestionAddress, streamName }, key);
      const rows = await request("?on_conflict=id&select=id", {
        method: "POST",
        body: { id, platform, stream_id: streamId, ...encrypted },
        prefer: "return=representation",
      });
      if (!rows?.[0]?.id) throw new Error("ai_live_stream_secret_persist_failed");
      return rows[0].id;
    },
    async resolveStreamSecret({ destination, secretRef } = {}) {
      if (destination !== "youtube_live" || typeof secretRef !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(secretRef)) {
        throw new Error("ai_live_stream_secret_reference_invalid");
      }
      const rows = await request("?id=eq." + encodeURIComponent(secretRef) +
        "&platform=eq.youtube&select=id,ciphertext,iv,auth_tag");
      if (!rows?.[0] || rows[0].id !== secretRef) throw new Error("ai_live_stream_secret_not_found");
      const value = decrypt(rows[0], key);
      return {
        outputUrl: value.ingestionAddress.replace(/\/+$/, "") + "/" + value.streamName,
      };
    },
    async deleteStreamSecret(secretRef) {
      if (typeof secretRef !== "string" || !/^[0-9a-f-]{36}$/i.test(secretRef)) {
        throw new Error("ai_live_stream_secret_reference_invalid");
      }
      await request("?id=eq." + encodeURIComponent(secretRef) + "&platform=eq.youtube", {
        method: "DELETE",
      });
      return { deleted: true };
    },
  };
}
