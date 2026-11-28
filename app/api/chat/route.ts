import { NextResponse } from "next/server";
import { retrieveChatFacts } from "@/lib/chat/retrieve-context";
import { answerFromFacts } from "@/lib/chat/answer";
import { isMuseVideoRequest, planMuseVideoRequest, type MuseAttachmentKinds } from "@/lib/muse/video-request";
import { enqueueMuseRenderJob, failQueuedMuseRenderJob, manifestAssetsMatch, uploadDeclaredMuseAsset, validateMuseAssetPaths, validateMuseManifest } from "@/lib/muse/render-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: Record<string, unknown>, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

const TYPE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "audio/mpeg": "mp3",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

type PreparedAttachment = {
  role: "image" | "voice" | "bgm" | "lipsync";
  contentType: string;
  relativePath: string;
  bytes: Uint8Array;
};

function queueUnavailableMessage() {
  return "動画キューに登録できませんでした。完成にはしていません。NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY、非公開バケット tracer-muse-render、マイグレーション 20261128110000_create_ai_live_muse_render_jobs、MUSE_RENDER_WORKER_TOKEN、起動中の Colab ワーカーを確認してください。セリフ音声の生成にはスタジオの FISH_AUDIO_API_KEY が必要です。";
}

function prepareAttachments(value: unknown): { ok: true; items: PreparedAttachment[] } | { ok: false; message: string } {
  if (value == null) return { ok: true, items: [] };
  if (!Array.isArray(value)) return { ok: false, message: "添付データの形式が不正です。" };
  if (value.length > 4) return { ok: false, message: "添付は4件までです。" };
  const items: PreparedAttachment[] = [];
  let audioCount = 0;
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, message: "添付データの形式が不正です。" };
    const record = entry as Record<string, unknown>;
    const contentType = typeof record.contentType === "string" ? record.contentType.toLowerCase().split(";")[0].trim() : "";
    const extension = TYPE_EXT[contentType];
    const base64 = typeof record.dataBase64 === "string" ? record.dataBase64.replace(/\s/g, "") : "";
    if (!extension || !base64 || base64.length > 11_000_000) {
      return { ok: false, message: "添付はPNG、JPEG、WebP、MP3、MP4、WebMで、1件8MB以下にしてください。" };
    }
    const bytes = Buffer.from(base64, "base64");
    if (bytes.byteLength < 1 || bytes.byteLength > 8 * 1024 * 1024) {
      return { ok: false, message: "添付は1件8MB以下にしてください。大きい口パク動画は専用スタジオから同じMuseキューへ送ってください。" };
    }
    let role: PreparedAttachment["role"];
    if (contentType.startsWith("image/")) role = "image";
    else if (contentType.startsWith("video/")) role = "lipsync";
    else if (record.role === "bgm" || audioCount > 0) role = "bgm";
    else role = "voice";
    if (contentType.startsWith("audio/")) audioCount += 1;
    const relativePath = role === "image"
      ? `scene-1.${extension}`
      : role === "voice"
        ? "narration.mp3"
        : role === "bgm"
          ? "bgm.mp3"
          : `lipsync.${extension}`;
    if (items.some((item) => item.role === role)) return { ok: false, message: "同じ種類の添付が重複しています。" };
    items.push({ role, contentType, relativePath, bytes });
  }
  return { ok: true, items };
}

function kindsOf(items: PreparedAttachment[]): MuseAttachmentKinds {
  return {
    image: items.some((item) => item.role === "image"),
    voice: items.some((item) => item.role === "voice"),
    bgm: items.some((item) => item.role === "bgm"),
    lipsync: items.some((item) => item.role === "lipsync"),
  };
}

function applyAttachments(manifest: Record<string, unknown>, items: PreparedAttachment[]) {
  const scenes = manifest.scenes as Array<Record<string, unknown>>;
  if (items.some((item) => item.role === "lipsync")) {
    manifest.lipsyncFile = "lipsync";
    delete manifest.lipSync;
    for (const scene of scenes) {
      delete scene.imageFile;
      delete scene.videoFile;
    }
  } else if (items.some((item) => item.role === "image")) {
    scenes[0].imageFile = "scene-1";
  }
  if (items.some((item) => item.role === "bgm")) manifest.bgm = { volume: 0.18, loop: true };
  if (items.some((item) => item.role === "voice")) scenes[0].narrationAudioReady = true;
  return items.map((item) => item.relativePath);
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { message?: string; attachments?: unknown };
    const message = typeof body.message === "string" ? body.message.trim() : "";

    if (!message) {
      return json({ ok: false, error: "メッセージが空です" }, 400);
    }

    if (isMuseVideoRequest(message)) {
      const prepared = prepareAttachments(body.attachments);
      if (!prepared.ok) return json({ ok: false, error: prepared.message }, 400);
      const plan = planMuseVideoRequest(message, kindsOf(prepared.items));
      if (!plan.ready || !plan.manifest) {
        return json({
          ok: true,
          answer: plan.question,
          intent: "muse_video",
          missing: plan.missing,
          confidence: "needs_input",
          usedData: ["muse-render-queue"],
          links: [{ label: "専用スタジオ", href: "/ai-live-short-drama-studio.html" }],
          museVideo: { status: "needs_input", outputVideoUrl: null },
        });
      }
      const assetPaths = applyAttachments(plan.manifest, prepared.items);
      if (!validateMuseManifest(plan.manifest) || !validateMuseAssetPaths(assetPaths) || !manifestAssetsMatch(plan.manifest, assetPaths)) {
        return json({ ok: false, error: "動画の内容をキューに渡せる形にできませんでした。", intent: "muse_video" }, 400);
      }
      try {
        const created = await enqueueMuseRenderJob({
          manifest: plan.manifest,
          assetPaths,
          requestedBy: "muse-chat",
        });
        const jobId = String(created.job.id);
        try {
          for (const item of prepared.items) {
            await uploadDeclaredMuseAsset(jobId, item.relativePath, item.bytes, item.contentType);
          }
        } catch {
          await failQueuedMuseRenderJob(jobId, "チャットから受け取った素材を保存できませんでした。");
          return json({
            ok: true,
            answer: "素材の保存に失敗したため、制作は失敗です。完成動画はありません。",
            intent: "muse_video",
            missing: plan.missing,
            museVideo: { jobId, status: "failed", outputVideoUrl: null, errorMessage: "素材の保存に失敗しました。" },
          });
        }
        return json({
          ok: true,
          answer: `${plan.question}ジョブIDは ${jobId} です。状態はキューで待機中です。`,
          intent: "muse_video",
          missing: plan.missing,
          confidence: "queued",
          usedData: ["muse-render-queue"],
          links: [{ label: "専用スタジオ", href: "/ai-live-short-drama-studio.html" }],
          museVideo: { jobId, status: "queued", outputVideoUrl: null },
        });
      } catch {
        return json({
          ok: true,
          answer: queueUnavailableMessage(),
          intent: "muse_video",
          missing: ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "MUSE_RENDER_WORKER_TOKEN", "tracer-muse-render"],
          confidence: "unavailable",
          usedData: ["muse-render-queue"],
          museVideo: { status: "unavailable", outputVideoUrl: null },
        });
      }
    }

    const facts = await retrieveChatFacts(message);
    const result = await answerFromFacts(facts);

    return json({
      ok: true,
      answer: result.answer,
      intent: result.intent,
      missing: result.missing,
      confidence: result.confidence,
      usedData: result.usedData,
      links: result.links,
    });
  } catch (error) {
    console.error("[TRACER CHAT ERROR]", error);
    return json({
      ok: false,
      error: error instanceof Error ? error.message : "チャットを処理できませんでした",
    }, 500);
  }
}
