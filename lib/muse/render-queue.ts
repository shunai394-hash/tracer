import { randomUUID } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const MUSE_RENDER_BUCKET = "tracer-muse-render";
const PRESETS = new Set(["fade-up", "soft-zoom", "slide-left", "pop", "fade"]);
const ASPECTS = new Set(["16:9", "9:16", "1:1"]);
const SCENE_ASSET = /^scene-[1-9][0-9]*$/;

export function validateMuseManifest(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  if (manifest.format !== "muse-motion-manifest" || manifest.version !== 1 || !Array.isArray(manifest.scenes)) return false;
  if (manifest.scenes.length < 1 || manifest.scenes.length > 120) return false;
  if (manifest.aspect !== undefined && (typeof manifest.aspect !== "string" || !ASPECTS.has(manifest.aspect))) return false;
  if (manifest.lipsyncFile !== undefined && manifest.lipsyncFile !== "lipsync") return false;
  if (manifest.lipSync !== undefined) {
    const lipSync = manifest.lipSync;
    if (!lipSync || typeof lipSync !== "object" || Array.isArray(lipSync)) return false;
    if ((lipSync as { engine?: unknown }).engine !== "musetalk") return false;
  }
  if (manifest.bgm !== undefined && manifest.bgm !== null && (typeof manifest.bgm !== "object" || Array.isArray(manifest.bgm))) return false;
  let total = 0;
  for (const scene of manifest.scenes) {
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) return false;
    const item = scene as Record<string, unknown>;
    const duration = item.durationSeconds;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0.5 || duration > 60) return false;
    if (typeof item.motionPreset !== "string" || !PRESETS.has(item.motionPreset)) return false;
    if (typeof item.title !== "string" || item.title.length > 120 || typeof item.text !== "string" || item.text.length > 500) return false;
    const imageFile = item.imageFile;
    const videoFile = item.videoFile;
    if (imageFile !== undefined && (typeof imageFile !== "string" || !SCENE_ASSET.test(imageFile))) return false;
    if (videoFile !== undefined && (typeof videoFile !== "string" || !SCENE_ASSET.test(videoFile))) return false;
    if (imageFile && videoFile) return false;
    total += duration;
  }
  return total <= 900;
}

export function validateMuseAssetPaths(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 122 && value.every((path) =>
    typeof path === "string" && path.length <= 240 && /^[a-zA-Z0-9][a-zA-Z0-9/_-]*\.(mp3|png|jpg|jpeg|webp|mp4|webm)$/i.test(path) &&
    !path.includes("..") && !path.startsWith("/") && !path.includes("//")
  );
}

export function manifestAssetsMatch(manifest: Record<string, unknown>, paths: string[]): boolean {
  if (manifest.lipsyncFile === "lipsync" && !paths.some((path) => /^lipsync\.(mp4|webm)$/i.test(path))) return false;
  const lipSync = manifest.lipSync as { engine?: unknown } | undefined;
  if (lipSync?.engine === "musetalk" && manifest.lipsyncFile !== "lipsync") {
    const scenes = manifest.scenes as Array<Record<string, unknown>>;
    if (!scenes.some((scene) => typeof scene.imageFile === "string")) return false;
  }
  const scenes = manifest.scenes as Array<Record<string, unknown>>;
  return scenes.every((scene) => {
    if (typeof scene.imageFile === "string" && !paths.some((path) => path.startsWith(`${scene.imageFile}.`))) return false;
    if (typeof scene.videoFile === "string" && !paths.some((path) => path.startsWith(`${scene.videoFile}.`))) return false;
    return true;
  });
}

export async function enqueueMuseRenderJob(input: {
  manifest: Record<string, unknown>;
  assetPaths: string[];
  requestedBy: string;
}) {
  const db = createSupabaseAdminClient();
  const id = randomUUID();
  const uploadPaths = input.assetPaths.map((path) => `${id}/${path}`);
  const { data, error } = await db.from("ai_live_muse_render_jobs").insert({
    id,
    manifest: input.manifest,
    asset_paths: uploadPaths,
    requested_by: input.requestedBy,
  }).select("id,status,requested_by,created_at").single();
  if (error) throw error;
  return { job: data, bucket: MUSE_RENDER_BUCKET, uploadPaths };
}

export async function uploadDeclaredMuseAsset(jobId: string, relativePath: string, bytes: Uint8Array, contentType: string) {
  const db = createSupabaseAdminClient();
  const { error } = await db.storage.from(MUSE_RENDER_BUCKET).upload(`${jobId}/${relativePath}`, bytes, {
    contentType,
    upsert: false,
  });
  if (error) throw error;
}

export async function failQueuedMuseRenderJob(jobId: string, message: string) {
  const db = createSupabaseAdminClient();
  await db.from("ai_live_muse_render_jobs").update({
    status: "failed",
    error_message: message.slice(0, 1000),
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", jobId).eq("status", "queued");
}

export async function readChatMuseRenderJob(jobId: string) {
  const db = createSupabaseAdminClient();
  const { data, error } = await db.from("ai_live_muse_render_jobs")
    .select("id,status,error_message,output_path,attempt_count,requested_by")
    .eq("id", jobId)
    .eq("requested_by", "muse-chat")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  let outputVideoUrl: string | null = null;
  if (data.status === "succeeded" && data.output_path) {
    const signed = await db.storage.from(MUSE_RENDER_BUCKET).createSignedUrl(data.output_path, 60 * 60);
    if (signed.error) throw signed.error;
    outputVideoUrl = signed.data.signedUrl;
  }
  return {
    id: data.id as string,
    status: data.status as string,
    attemptCount: data.attempt_count as number,
    errorMessage: data.status === "failed" ? (data.error_message as string | null) : null,
    outputVideoUrl,
  };
}
