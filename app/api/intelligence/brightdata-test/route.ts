import { searchGoogleProducts } from "@/lib/sources/brightdata/client";

export const runtime = "nodejs";

export async function GET() {
  try {
    const result = await searchGoogleProducts("wireless earbuds");

    return Response.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
