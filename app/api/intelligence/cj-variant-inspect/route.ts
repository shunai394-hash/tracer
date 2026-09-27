import { NextResponse } from "next/server";
import {
  CJConfigError,
  CJRequestError,
  fetchCJProductVariants,
} from "@/lib/sources/cj/client";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const pid = searchParams.get("pid")?.trim();

  if (!pid) {
    return NextResponse.json(
      {
        ok: false,
        error: "pid is required",
      },
      { status: 400 },
    );
  }

  try {
    const variants = await fetchCJProductVariants(pid);

    return NextResponse.json({
      ok: true,
      pid,
      count: variants.length,
      variants,
    });
  } catch (error) {
    if (error instanceof CJConfigError) {
      return NextResponse.json(
        {
          ok: false,
          code: error.code,
          error: error.message,
        },
        { status: 503 },
      );
    }

    if (error instanceof CJRequestError) {
      return NextResponse.json(
        {
          ok: false,
          code: error.code,
          error: error.message,
        },
        { status: 502 },
      );
    }

    console.error("[cj-variant-inspect] unexpected error", error);

    return NextResponse.json(
      {
        ok: false,
        error: "Unexpected CJ variant inspection failure",
      },
      { status: 500 },
    );
  }
}
