import { auditProductDisplayQuality } from "@/lib/intelligence/product-display-quality";
import { requireCronAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  try {
    const audit = await auditProductDisplayQuality();
    return Response.json(audit, {
      status: audit.status === "PASS" ? 200 : 503,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown audit error";
    return Response.json(
      {
        status: "BLOCKED",
        publishableNow: false,
        reasons: ["audit_failed"],
        error: message,
      },
      { status: 500 },
    );
  }
}
