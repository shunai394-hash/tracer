const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
const ALLOWED_PRIVACY = new Set(["private", "unlisted", "public"]);

function required(value, name, max = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("youtube_live_invalid_" + name);
  return value.trim();
}
function safeId(value, name) {
  const id = required(value, name, 256);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("youtube_live_invalid_" + name);
  return id;
}
function safeResource(payload, field) {
  if (!payload || typeof payload !== "object" || typeof payload.id !== "string" || !payload.id) {
    throw new Error("youtube_live_api_invalid_" + field + "_response");
  }
  return payload;
}

/**
 * Official YouTube Live Streaming API orchestration.
 * persistStreamSecret must store RTMP ingest credentials in a secret manager
 * and return only an opaque reference. Raw stream keys never appear in output.
 * The caller starts its encoder, checks streamStatus=active, then explicitly
 * calls startBroadcast({ confirmEncoderActive: true }).
 */
export function createYouTubeLiveBroadcastManager({
  accessTokenProvider,
  persistStreamSecret,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  if (typeof accessTokenProvider !== "function" || typeof persistStreamSecret !== "function" ||
      typeof fetchImpl !== "function") throw new Error("youtube_live_access_token_secret_store_and_fetch_required");

  async function request(path, { method = "GET", query = {}, body, signal } = {}) {
    const token = await accessTokenProvider({ signal });
    if (typeof token !== "string" || token.length < 20 || token.length > 8192) {
      throw new Error("youtube_live_access_token_unavailable");
    }
    const url = new URL(YOUTUBE_API_BASE + path);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const response = await fetchImpl(url, {
      method,
      headers: {
        authorization: "Bearer " + token,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      ...(signal ? { signal } : {}),
    });
    if (!response?.ok) throw new Error("youtube_live_api_http_" + (Number.isInteger(response?.status) ? response.status : 0));
    try { return await response.json(); }
    catch { throw new Error("youtube_live_api_invalid_json"); }
  }

  async function deleteResource(path, id, signal) {
    try { await request(path, { method: "DELETE", query: { id }, signal }); }
    catch { /* Best-effort cleanup; never mask the primary error. */ }
  }

  async function getStream(streamId, signal) {
    const payload = await request("/liveStreams", {
      query: { part: "id,snippet,cdn,status,contentDetails", id: safeId(streamId, "stream_id") }, signal,
    });
    const stream = payload?.items?.[0];
    if (!stream || stream.id !== streamId) throw new Error("youtube_live_stream_not_found");
    return {
      id: stream.id,
      title: typeof stream.snippet?.title === "string" ? stream.snippet.title : null,
      streamStatus: typeof stream.status?.streamStatus === "string" ? stream.status.streamStatus : "unknown",
      healthStatus: typeof stream.status?.healthStatus?.status === "string" ? stream.status.healthStatus.status : null,
    };
  }

  async function getBroadcast(broadcastId, signal) {
    const payload = await request("/liveBroadcasts", {
      query: { part: "id,snippet,status,contentDetails", id: safeId(broadcastId, "broadcast_id") }, signal,
    });
    const broadcast = payload?.items?.[0];
    if (!broadcast || broadcast.id !== broadcastId) throw new Error("youtube_live_broadcast_not_found");
    return {
      id: broadcast.id,
      title: typeof broadcast.snippet?.title === "string" ? broadcast.snippet.title : null,
      lifeCycleStatus: typeof broadcast.status?.lifeCycleStatus === "string" ? broadcast.status.lifeCycleStatus : "unknown",
      liveChatId: typeof broadcast.snippet?.liveChatId === "string" ? broadcast.snippet.liveChatId : null,
      boundStreamId: typeof broadcast.contentDetails?.boundStreamId === "string" ? broadcast.contentDetails.boundStreamId : null,
    };
  }

  return {
    async createBroadcast({ title, description = "", privacyStatus = "unlisted", scheduledStartTime, signal } = {}) {
      const cleanTitle = required(title, "title", 100);
      if (typeof description !== "string" || description.length > 5000) throw new Error("youtube_live_invalid_description");
      if (!ALLOWED_PRIVACY.has(privacyStatus)) throw new Error("youtube_live_invalid_privacy_status");
      const startAt = scheduledStartTime == null ? new Date(now() + 120_000).toISOString() : new Date(scheduledStartTime).toISOString();
      if (!Number.isFinite(Date.parse(startAt)) || Date.parse(startAt) < now() + 30_000) {
        throw new Error("youtube_live_start_time_must_be_future");
      }

      let streamId = null;
      let broadcastId = null;
      try {
        const streamPayload = await request("/liveStreams", {
          method: "POST",
          query: { part: "snippet,cdn,contentDetails" },
          body: {
            snippet: { title: cleanTitle + " - ingest" },
            cdn: { ingestionType: "rtmp", resolution: "variable", frameRate: "variable" },
            contentDetails: { isReusable: false },
          },
          signal,
        });
        const stream = safeResource(streamPayload, "stream");
        streamId = safeId(stream.id, "stream_id");
        const ingest = stream.cdn?.ingestionInfo;
        const ingestionAddress = typeof ingest?.ingestionAddress === "string" ? ingest.ingestionAddress : "";
        const streamName = typeof ingest?.streamName === "string" ? ingest.streamName : "";
        if (!/^rtmps?:\/\//i.test(ingestionAddress) || ingestionAddress.length > 2048 ||
            !streamName || streamName.length > 1024) throw new Error("youtube_live_ingest_details_missing");

        const secretRef = await persistStreamSecret({ platform: "youtube", streamId, ingestionAddress, streamName });
        if (typeof secretRef !== "string" || !secretRef.trim() || secretRef.length > 256) {
          throw new Error("youtube_live_secret_store_did_not_return_reference");
        }

        const broadcastPayload = await request("/liveBroadcasts", {
          method: "POST",
          query: { part: "snippet,status,contentDetails" },
          body: {
            snippet: { title: cleanTitle, description, scheduledStartTime: startAt },
            status: { privacyStatus },
            contentDetails: {
              enableAutoStart: false, enableAutoStop: false, enableDvr: true,
              enableEmbed: true, enableMonitorStream: false, recordFromStart: true,
              startWithSlate: false,
            },
          },
          signal,
        });
        const broadcast = safeResource(broadcastPayload, "broadcast");
        broadcastId = safeId(broadcast.id, "broadcast_id");

        const boundPayload = await request("/liveBroadcasts/bind", {
          method: "POST",
          query: { part: "id,snippet,status,contentDetails", id: broadcastId, streamId },
          signal,
        });
        const bound = safeResource(boundPayload, "bound_broadcast");
        return {
          broadcastId, streamId, title: cleanTitle, privacyStatus,
          scheduledStartTime: startAt, streamSecretRef: secretRef,
          lifeCycleStatus: typeof bound.status?.lifeCycleStatus === "string" ? bound.status.lifeCycleStatus : "created",
          liveChatId: typeof bound.snippet?.liveChatId === "string" ? bound.snippet.liveChatId : null,
        };
      } catch (error) {
        if (broadcastId) await deleteResource("/liveBroadcasts", broadcastId, signal);
        if (streamId) await deleteResource("/liveStreams", streamId, signal);
        throw error;
      }
    },

    async getStatus({ broadcastId, streamId, signal } = {}) {
      const [broadcast, stream] = await Promise.all([getBroadcast(broadcastId, signal), getStream(streamId, signal)]);
      if (broadcast.boundStreamId && broadcast.boundStreamId !== stream.id) {
        throw new Error("youtube_live_broadcast_stream_binding_mismatch");
      }
      return { broadcast, stream };
    },

    async startBroadcast({ broadcastId, streamId, confirmEncoderActive = false, signal } = {}) {
      if (confirmEncoderActive !== true) throw new Error("youtube_live_encoder_confirmation_required");
      const current = await this.getStatus({ broadcastId, streamId, signal });
      if (current.broadcast.boundStreamId !== current.stream.id) throw new Error("youtube_live_broadcast_not_bound_to_requested_stream");
      if (current.stream.streamStatus !== "active") throw new Error("youtube_live_ingest_stream_not_active");
      if (current.broadcast.lifeCycleStatus !== "ready") throw new Error("youtube_live_broadcast_not_ready");
      const payload = await request("/liveBroadcasts/transition", {
        method: "POST",
        query: { part: "id,snippet,status,contentDetails", id: broadcastId, broadcastStatus: "live" },
        signal,
      });
      const broadcast = safeResource(payload, "broadcast");
      return {
        broadcastId: broadcast.id,
        lifeCycleStatus: typeof broadcast.status?.lifeCycleStatus === "string" ? broadcast.status.lifeCycleStatus : "unknown",
        liveChatId: typeof broadcast.snippet?.liveChatId === "string" ? broadcast.snippet.liveChatId : null,
      };
    },

    async completeBroadcast({ broadcastId, signal } = {}) {
      const current = await getBroadcast(broadcastId, signal);
      if (!["live", "liveStarting", "testing", "testStarting", "ready"].includes(current.lifeCycleStatus)) {
        throw new Error("youtube_live_broadcast_cannot_be_completed_from_current_state");
      }
      const payload = await request("/liveBroadcasts/transition", {
        method: "POST",
        query: { part: "id,snippet,status", id: broadcastId, broadcastStatus: "complete" },
        signal,
      });
      const broadcast = safeResource(payload, "completed_broadcast");
      return {
        broadcastId: broadcast.id,
        lifeCycleStatus: typeof broadcast.status?.lifeCycleStatus === "string" ? broadcast.status.lifeCycleStatus : "unknown",
      };
    },
  };
}
