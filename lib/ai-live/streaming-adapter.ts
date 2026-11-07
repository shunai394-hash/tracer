/**
 * Provider-neutral contract between TRACER's control plane and an external
 * long-running streaming worker. This module contains types only: it does not
 * start processes, access credentials, or publish a live stream.
 *
 * Keep the worker outside Vercel request lifetimes. Destination credentials
 * must be injected by the worker at runtime and must never enter job payloads.
 */
export type AiLiveStreamState =
  | "idle"
  | "starting"
  | "live"
  | "reconnecting"
  | "stopping"
  | "stopped"
  | "failed";

export type AiLiveStopReason =
  | "operator_requested"
  | "stale_product_facts"
  | "inventory_unverified"
  | "speech_provider_failed"
  | "stream_destination_rejected"
  | "worker_shutdown"
  | "unknown";

export type AiLiveProgramSegment = {
  id: string;
  productId: string;
  scriptText: string;
  /** Only an approved, current TRACER product fact package may be attached. */
  factsVersion: string;
  factsVerifiedAt: string;
  audioAssetId?: string;
  bgmAssetId?: string;
};

export type AiLiveStreamJob = {
  streamId: string;
  /** Logical destination name only; never include a stream key or RTMP URL. */
  destination: string;
  /** Opaque reference resolved by the worker from its secret store. */
  destinationSecretRef: string;
  /** A finite, operator-approved run window. No implicit unattended 24/7 loop. */
  maxRuntimeSeconds: number;
  segments: AiLiveProgramSegment[];
};

export type AiLiveStreamHealth = {
  streamId: string;
  state: AiLiveStreamState;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  reconnectCount: number;
  currentSegmentId: string | null;
  stopReason: AiLiveStopReason | null;
  /** Safe diagnostic code only. Must not contain URLs, tokens, or viewer data. */
  errorCode: string | null;
};

export type AiLiveStreamAdapter = {
  start(job: AiLiveStreamJob): Promise<AiLiveStreamHealth>;
  stop(streamId: string, reason: AiLiveStopReason): Promise<AiLiveStreamHealth>;
  getHealth(streamId: string): Promise<AiLiveStreamHealth>;
};
