import { requireCronAuth } from "@/lib/security/cron-auth";
﻿import { searchGoogleProducts } from "@/lib/sources/brightdata/client";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;
  try {
    const result = await searchGoogleProducts("wireless earbuds");

    return Response.json({
      ok: true,
      query: result.query,
      productCount: result.products.length,
      firstProducts: result.products.slice(0, 3),
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
