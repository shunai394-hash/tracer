import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorizedAdminToken(request: Request): boolean {
  const expected = process.env.TRACER_ADMIN_TOKEN;
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.slice(0, 7).toLowerCase() === "bearer " ? authorization.slice(7).trim() : "";
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}
function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
async function authorize(request: Request) {
  if (authorizedAdminToken(request)) return null;
  return await requireAutomationAuth(request);
}
function projectKey(title: string, episode: number) {
  return title.normalize("NFKC").trim().toLocaleLowerCase("ja-JP").replace(/\s+/g, " ").slice(0, 100) + "::" + episode;
}
function validProject(value: unknown): value is Record<string, unknown> & { title: string; genre: string; characters: unknown[]; lines: unknown[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return typeof data.title === "string" && data.title.trim().length > 0 && data.title.length <= 100
    && typeof data.genre === "string" && data.genre.length <= 60
    && Array.isArray(data.characters) && data.characters.length <= 30
    && Array.isArray(data.lines) && data.lines.length <= 300;
}
export async function GET(request: Request) {
  const authError = await authorize(request);
  if (authError) return authError;
  const url = new URL(request.url);
  const title = (url.searchParams.get("title") || "").trim();
  const episode = Number(url.searchParams.get("episode") || 1);
  if (!title || title.length > 100 || !Number.isInteger(episode) || episode < 1 || episode > 999) return json({ ok: false, error: "invalid_project_key" }, 400);
  try {
    const db = createSupabaseAdminClient();
    const { data, error } = await db.from("ai_live_drama_projects").select("title,episode_number,genre,project_data,updated_at").eq("project_key", projectKey(title, episode)).maybeSingle();
    if (error) throw error;
    if (!data) return json({ ok: false, error: "project_not_found", message: "サーバーに保存された作品シートがありません。" }, 404);
    return json({ ok: true, project: data.project_data, title: data.title, episode: data.episode_number, genre: data.genre, updatedAt: data.updated_at });
  } catch {
    return json({ ok: false, error: "project_registry_unavailable", message: "作品シート共通台帳を読み込めません。" }, 503);
  }
}
export async function POST(request: Request) {
  const authError = await authorize(request);
  if (authError) return authError;
  let input: Record<string, unknown>;
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) return json({ ok: false, error: "invalid_json_object" }, 400);
    input = value as Record<string, unknown>;
  } catch { return json({ ok: false, error: "invalid_json" }, 400); }
  const project = input.project;
  const episode = Number(input.episode || 1);
  if (!validProject(project) || !Number.isInteger(episode) || episode < 1 || episode > 999) return json({ ok: false, error: "invalid_project", message: "作品タイトル・話数・人物・セリフを確認してください。" }, 400);
  try {
    const db = createSupabaseAdminClient();
    const key = projectKey(project.title, episode);
    const { error } = await db.from("ai_live_drama_projects").upsert({
      project_key: key,
      title: project.title.trim(),
      episode_number: episode,
      genre: project.genre,
      project_data: project,
      updated_at: new Date().toISOString(),
    }, { onConflict: "project_key" });
    if (error) throw error;
    return json({ ok: true, title: project.title, episode, message: "作品シートをTRACER共通台帳に保存しました。" });
  } catch {
    return json({ ok: false, error: "project_save_failed", message: "作品シートをサーバーに保存できませんでした。" }, 503);
  }
}
