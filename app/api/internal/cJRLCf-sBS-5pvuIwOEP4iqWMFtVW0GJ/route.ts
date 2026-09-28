import { GET as runMarketSourcing } from "@/app/api/cron/market-sourcing/route";

export const runtime = "nodejs";
export const maxDuration = 60;

const TOKEN = "cJRLCf-sBS-5pvuIwOEP4iqWMFtVW0GJ";

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("token") !== TOKEN) {
    return Response.json({ ok: false }, { status: 404 });
  }

  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${process.env.CRON_SECRET ?? ""}`);
  return runMarketSourcing(new Request(request.url, {
    method: "GET",
    headers,
  }));
}
