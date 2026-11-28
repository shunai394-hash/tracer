import { NextResponse } from "next/server";
import { readChatMuseRenderJob } from "@/lib/muse/render-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: Record<string, unknown>, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

const STATUS_LABEL: Record<string, string> = {
  queued: "キューで待機中",
  processing: "制作中",
  succeeded: "完成",
  failed: "失敗",
};

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ ok: false, error: "ジョブIDが不正です。" }, 400);
  try {
    const job = await readChatMuseRenderJob(id);
    if (!job) return json({ ok: false, error: "動画ジョブが見つかりません。" }, 404);
    const finished = job.status === "succeeded" && Boolean(job.outputVideoUrl);
    const status = finished ? "succeeded" : job.status === "succeeded" ? "processing" : job.status;
    return json({
      ok: true,
      museVideo: {
        jobId: job.id,
        status,
        attemptCount: job.attemptCount,
        outputVideoUrl: finished ? job.outputVideoUrl : null,
        errorMessage: job.errorMessage,
        label: finished ? "完成" : (STATUS_LABEL[status] ?? status),
      },
    });
  } catch {
    return json({ ok: false, error: "動画ジョブの状態を確認できません。" }, 503);
  }
}
