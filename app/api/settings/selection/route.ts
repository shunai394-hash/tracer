import { requireCronAuth } from "@/lib/security/cron-auth";
import { NextResponse } from "next/server";
import {
  getSelectionSettings,
  saveSelectionSettings,
} from "@/lib/intelligence/selection-settings-store";
import { parseSelectionSettings } from "@/lib/intelligence/selection-config";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;
  try {
    const settings = await getSelectionSettings();
    return NextResponse.json({ ok: true, settings });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const settings = await saveSelectionSettings(parseSelectionSettings(body));
    return NextResponse.json({ ok: true, settings });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 400 },
    );
  }
}
