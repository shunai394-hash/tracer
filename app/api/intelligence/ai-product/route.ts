import { NextResponse } from "next/server";
import { analyzeProductWithAi } from "@/lib/ai/product-intelligence";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      title?: string;
      description?: string | null;
      category?: string | null;
      price?: number | null;
      currency?: string | null;
      source?: string | null;
      reviews?: Array<{ text: string; rating?: number | null }>;
    };

    if (!body.title?.trim()) {
      return NextResponse.json({ ok: false, error: "title is required" }, { status: 400 });
    }

    const analysis = await analyzeProductWithAi({
      title: body.title.trim(),
      description: body.description,
      category: body.category,
      price: body.price,
      currency: body.currency,
      source: body.source,
      reviews: body.reviews,
    });

    return NextResponse.json({ ok: true, analysis });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "AI analysis failed" },
      { status: 500 },
    );
  }
}
