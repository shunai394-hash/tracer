import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { fetchBaseItemsSnapshot, isBaseConfigured } from "@/lib/channels/base";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Authenticated, read-only product backup export.
 * It deliberately excludes orders and customer data and never logs product payloads.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  if (!isBaseConfigured()) {
    return NextResponse.json(
      { ok: false, error: "BASE_OAUTH_CONFIG_INCOMPLETE" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const snapshot = await fetchBaseItemsSnapshot({ itemPageLimit: 100, itemMaxPages: 20 });
    const visible = snapshot.items.filter((item) =>
      item.visible === true || item.visible === 1 || item.visible === "1",
    ).length;
    const hidden = snapshot.items.filter((item) =>
      item.visible === false || item.visible === 0 || item.visible === "0",
    ).length;
    const backup = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      source: "BASE /items read-only snapshot",
      complete: snapshot.complete,
      pages: snapshot.pages,
      itemCount: snapshot.items.length,
      visibleCount: visible,
      hiddenCount: hidden,
      unknownVisibilityCount: snapshot.items.length - visible - hidden,
      items: snapshot.items,
    };
    const date = backup.generatedAt.slice(0, 10);
    return new Response(JSON.stringify(backup, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="tracer-base-products-${date}.json"`,
        "Cache-Control": "no-store, private",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "BASE_ITEMS_SNAPSHOT_FAILED";
    const stage = message.split(":")[0].slice(0, 100);
    const status = Number(message.match(/HTTP_(\d{3})/)?.[1] ?? 0) || null;
    console.error("[TRACER BASE SNAPSHOT EXPORT FAILED]", { stage, status });
    return NextResponse.json(
      { ok: false, error: stage, complete: false },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
