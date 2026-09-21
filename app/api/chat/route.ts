import { NextResponse } from "next/server";
import { retrieveChatFacts } from "@/lib/chat/retrieve-context";
import { answerFromFacts } from "@/lib/chat/answer";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { message?: string };
    const message = typeof body.message === "string" ? body.message.trim() : "";

    if (!message) {
      return NextResponse.json(
        { ok: false, error: "メッセージが空です" },
        { status: 400 },
      );
    }

    const facts = await retrieveChatFacts(message);
    const result = await answerFromFacts(facts);

    return NextResponse.json({
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
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "チャットを処理できませんでした",
      },
      { status: 500 },
    );
  }
}
