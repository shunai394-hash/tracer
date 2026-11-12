export type ResidentDestination = "loopback" | "youtube" | "tiktok";

type Env = Record<string, string | undefined>;

export type DestinationApproval = {
  destination: ResidentDestination | null;
  officiallyApproved: boolean;
  secretPresent: boolean;
  rtmpAllowed: boolean;
};

function clean(value: string | undefined): string {
  return value?.trim() || "";
}

function rtmpEndpoint(value: string): { host: string; port: number } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "rtmp:" && url.protocol !== "rtmps:") return null;
    const port = url.port ? Number(url.port) : url.protocol === "rtmps:" ? 443 : 1935;
    if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host: url.hostname, port };
  } catch {
    return null;
  }
}

function secretValue(value: string): boolean {
  return value.length >= 8 && value.length <= 2048 && !/\s/.test(value) && !value.includes("://");
}

export function officialApprovalFromEnv(env: Env, destination: ResidentDestination): boolean {
  if (destination === "loopback") return true;
  if (destination === "youtube") return env.TRACER_AI_LIVE_YOUTUBE_APPROVED === "approved";
  return env.TRACER_AI_LIVE_TIKTOK_APPROVED === "approved";
}

/** True only when a destination secret is present. The secret value is not returned. */
export function platformSecretConfigured(env: Env, destination: ResidentDestination): boolean {
  if (destination === "loopback") return false;
  if (destination === "youtube") {
    return secretValue(clean(env.YOUTUBE_STREAM_KEY)) && rtmpEndpoint(clean(env.YOUTUBE_RTMP_URL)) !== null;
  }
  return secretValue(clean(env.TIKTOK_STREAM_KEY)) && rtmpEndpoint(clean(env.TIKTOK_RTMP_URL)) !== null;
}

export function destinationApprovalView(destination: ResidentDestination | null, env: Env): DestinationApproval {
  if (!destination) {
    return { destination: null, officiallyApproved: false, secretPresent: false, rtmpAllowed: false };
  }
  const officiallyApproved = officialApprovalFromEnv(env, destination);
  const secretPresent = platformSecretConfigured(env, destination);
  return {
    destination,
    officiallyApproved,
    secretPresent,
    rtmpAllowed: false,
  };
}

export type SocketConnect = (host: string, port: number) => { destroy?: () => void };

/**
 * This revision never opens a destination socket.
 * Approval and a secret are recorded, but the broadcast adapter is not implemented,
 * so connectImpl is ignored for both unapproved and approved destinations.
 * The stream key is not read into the result.
 */
export function openDestinationSocket(input: {
  destination: ResidentDestination;
  env: Env;
  connectImpl?: SocketConnect;
}): { opened: false; reason: string } {
  void input.connectImpl;
  if (input.destination === "loopback") return { opened: false, reason: "loopback_has_no_rtmp" };
  const approval = destinationApprovalView(input.destination, input.env);
  if (!approval.officiallyApproved || !approval.secretPresent) {
    return {
      opened: false,
      reason: input.destination === "youtube" ? "youtube_approval_required" : "tiktok_approval_required",
    };
  }
  return { opened: false, reason: "destination_adapter_not_implemented" };
}
