import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const GOOGLE_TRENDS_RSS =
  "https://trends.google.com/trending/rss?geo=JP";

const SOURCE_NAME = "Google Trends";
const SOURCE_TYPE = "search";
const PROVIDER = "manual";

type TrendItem = {
  title: string;
  traffic: number | null;
  publishedAt: string | null;
};

function parseTraffic(value: string | null): number | null {
  if (!value) return null;

  const normalized = value.trim().toLowerCase();

  const match = normalized.match(
    /^([\d,.]+)\s*([kmb])?\+?$/
  );

  if (!match) return null;

  const base = Number(match[1].replace(/,/g, ""));

  if (!Number.isFinite(base)) return null;

  const suffix = match[2];

  if (suffix === "k") return base * 1_000;
  if (suffix === "m") return base * 1_000_000;
  if (suffix === "b") return base * 1_000_000_000;

  return base;
}

function extractTag(xml: string, tag: string): string | null {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const match = xml.match(
    new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "i")
  );

  if (!match) return null;

  return match[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function extractItems(xml: string): TrendItem[] {
  const items: TrendItem[] = [];

  const itemMatches = xml.match(
    /<item\b[^>]*>[\s\S]*?<\/item>/gi
  ) ?? [];

  for (const item of itemMatches) {
    const title = extractTag(item, "title");

    if (!title) continue;

    const traffic = parseTraffic(
      extractTag(item, "ht:approx_traffic")
    );

    const publishedAt =
      extractTag(item, "pubDate") ??
      extractTag(item, "ht:picture");

    items.push({
      title,
      traffic,
      publishedAt,
    });
  }

  return items;
}

export async function collectGoogleTrendsDemand() {
  const response = await fetch(GOOGLE_TRENDS_RSS, {
    headers: {
      "User-Agent": "TRACER/1.0 Demand Intelligence",
      Accept: "application/rss+xml, application/xml, text/xml",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      `Google Trends request failed: ${response.status} ${response.statusText}`
    );
  }

  const bytes = await response.arrayBuffer();
  const xml = new TextDecoder("utf-8").decode(bytes);
  const trends = extractItems(xml);

  if (trends.length === 0) {
    throw new Error("Google Trends returned no trend items");
  }

  const supabase = createSupabaseAdminClient();

  const sourceResult = await supabase
    .from("sources")
    .select("id")
    .eq("name", SOURCE_NAME)
    .maybeSingle();

  if (sourceResult.error) {
    throw new Error(
      `Failed to find Google Trends source: ${sourceResult.error.message}`
    );
  }

  let sourceId: string;

  if (sourceResult.data) {
    sourceId = sourceResult.data.id;
  } else {
    const insertResult = await supabase
      .from("sources")
      .insert({
        name: SOURCE_NAME,
        source_type: SOURCE_TYPE,
        base_url: "https://trends.google.com",
        provider: PROVIDER,
      })
      .select("id")
      .single();

    if (insertResult.error) {
      throw new Error(
        `Failed to create Google Trends source: ${insertResult.error.message}`
      );
    }

    sourceId = insertResult.data.id;
  }

  let inserted = 0;

  for (const trend of trends) {
    console.log("[google-trends-title]", JSON.stringify(trend.title));
    const { error } = await supabase
      .from("demand_observations")
      .insert({
        product_id: null,
        source_id: sourceId,
        signal_type: "search_volume",
        value: trend.traffic,
        unit: "searches_approx",
        observed_at: new Date().toISOString(),
        metadata: {
          query: trend.title,
          original_query: trend.title,
          country: "JP",
          provider: "google_trends",
          source_url: GOOGLE_TRENDS_RSS,
          published_at: trend.publishedAt,
        },
      });

    if (error) {
      throw new Error(
        `Failed to insert demand observation for "${trend.title}": ${error.message}`
      );
    }

    inserted += 1;
  }

  return {
    sourceId,
    fetched: trends.length,
    inserted,
  };
}







