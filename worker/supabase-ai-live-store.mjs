const TABLE = "ai_live_worker_streams";

function cleanBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("supabase_url_must_use_https");
  }
  return url.toString().replace(/\/$/, "");
}

function validateStreamRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("invalid_stream_record");
  if (typeof record.streamId !== "string" || !/^[A-Za-z0-9_-]{8,96}$/.test(record.streamId)) throw new Error("invalid_stream_id");
  if (!["youtube_live", "tiktok_live"].includes(record.destination)) throw new Error("invalid_destination");
  if (!["starting", "live", "reconnecting", "stopped", "failed"].includes(record.status)) throw new Error("invalid_status");
  if (!record.jobPayload || typeof record.jobPayload !== "object" || Array.isArray(record.jobPayload)) throw new Error("invalid_job_payload");
  const forbidden = /^(?:rtmpUrl|streamKey|stream_key|accessToken|access_token|cookie|destinationUrl|destination_url)$/i;
  const scan = (value) => {
    if (!value || typeof value !== "object") return false;
    return Object.entries(value).some(([key, child]) => forbidden.test(key) || scan(child));
  };
  if (scan(record.jobPayload)) throw new Error("credentials_must_not_be_persisted");
  if (!Number.isInteger(record.activeSegmentIndex) || record.activeSegmentIndex < 0) throw new Error("invalid_segment_index");
  if (!Number.isInteger(record.reconnectCount) || record.reconnectCount < 0) throw new Error("invalid_reconnect_count");
  if (typeof record.jobFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(record.jobFingerprint)) throw new Error("invalid_job_fingerprint");
}

function toRow(record) {
  validateStreamRecord(record);
  return {
    stream_id: record.streamId,
    destination: record.destination,
    status: record.status,
    adapter_mode: record.adapterMode || "fake",
    job_fingerprint: record.jobFingerprint,
    job_payload: record.jobPayload,
    active_segment_index: record.activeSegmentIndex,
    active_product_id: record.activeProductId || null,
    reconnect_count: record.reconnectCount,
    heartbeat_at: record.heartbeatAt || null,
    lease_owner: record.leaseOwner || null,
    lease_expires_at: record.leaseExpiresAt || null,
    started_at: record.startedAt,
    stopped_at: record.stoppedAt || null,
    stop_reason: record.stopReason || null,
    updated_at: record.updatedAt || new Date().toISOString(),
  };
}

export function createSupabaseAiLiveStore({ url, serviceRoleKey, fetchImpl = fetch } = {}) {
  if (!url || !serviceRoleKey || serviceRoleKey.length < 20) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  const baseUrl = cleanBaseUrl(url);
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
    });
    const text = await response.text();
    if (!response.ok) throw new Error("ai_live_store_http_" + response.status);
    return text ? JSON.parse(text) : null;
  }

  return {
    async upsert(record) {
      const rows = await request("?on_conflict=stream_id&select=stream_id,status,updated_at", {
        method: "POST",
        body: toRow(record),
        prefer: "resolution=merge-duplicates,return=representation",
      });
      return rows?.[0] || null;
    },
    async get(streamId) {
      if (typeof streamId !== "string" || !/^[A-Za-z0-9_-]{8,96}$/.test(streamId)) throw new Error("invalid_stream_id");
      const rows = await request("?stream_id=eq." + encodeURIComponent(streamId) + "&select=*");
      return rows?.[0] || null;
    },
    async listActive() {
      return request("?status=in.(starting,live,reconnecting)&select=*&order=updated_at.asc");
    },
    async heartbeat(streamId, { owner, segmentIndex, productId, reconnectCount, leaseSeconds = 45, now = new Date() } = {}) {
      if (typeof owner !== "string" || !/^[A-Za-z0-9_-]{8,96}$/.test(owner)) throw new Error("invalid_lease_owner");
      if (!Number.isInteger(segmentIndex) || segmentIndex < 0) throw new Error("invalid_segment_index");
      if (!Number.isInteger(reconnectCount) || reconnectCount < 0) throw new Error("invalid_reconnect_count");
      if (!Number.isInteger(leaseSeconds) || leaseSeconds < 10 || leaseSeconds > 300) throw new Error("invalid_lease_seconds");
      const at = new Date(now).toISOString();
      const expires = new Date(new Date(now).getTime() + leaseSeconds * 1000).toISOString();
      const rows = await request("?stream_id=eq." + encodeURIComponent(streamId) + "&select=stream_id,status,heartbeat_at,lease_expires_at", {
        method: "PATCH",
        body: {
          heartbeat_at: at,
          lease_owner: owner,
          lease_expires_at: expires,
          active_segment_index: segmentIndex,
          active_product_id: productId || null,
          reconnect_count: reconnectCount,
          updated_at: at,
        },
        prefer: "return=representation",
      });
      return rows?.[0] || null;
    },
    async markStopped(streamId, { reason = "operator_requested", now = new Date() } = {}) {
      if (typeof reason !== "string" || !/^[a-z0-9_]{1,64}$/i.test(reason)) throw new Error("invalid_stop_reason");
      const at = new Date(now).toISOString();
      const rows = await request("?stream_id=eq." + encodeURIComponent(streamId) + "&select=stream_id,status,stopped_at", {
        method: "PATCH",
        body: { status: "stopped", stopped_at: at, stop_reason: reason, lease_expires_at: null, updated_at: at },
        prefer: "return=representation",
      });
      return rows?.[0] || null;
    },
  };
}
