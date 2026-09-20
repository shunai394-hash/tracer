import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const APIFY_ACTOR = "clockworks~tiktok-scraper";
const APIFY_API = "https://api.apify.com/v2";

type TikTokItem = {
  text?: string;
  desc?: string;
  playCount?: number | string;
  diggCount?: number | string;
  shareCount?: number | string;
  commentCount?: number | string;
  collectCount?: number | string;
  webVideoUrl?: string;
  videoWebUrl?: string;
  authorMeta?: {
    name?: string;
    nickName?: string;
  };
};

function toNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

async function waitForRun(
  token: string,
  runId: string,
): Promise<{ status: string; datasetId: string | null }> {
  const maxAttempts = 60;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetch(
      `${APIFY_API}/actor-runs/${encodeURIComponent(runId)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
      },
    );

    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `Apify run status request failed: ${response.status} ${text}`,
      );
    }

    const result = JSON.parse(text);
    const status = result?.data?.status ?? "UNKNOWN";
    const datasetId = result?.data?.defaultDatasetId ?? null;

    if (status === "SUCCEEDED") {
      return { status, datasetId };
    }

    if (
      status === "FAILED" ||
      status === "ABORTED" ||
      status === "TIMED-OUT"
    ) {
      throw new Error(`Apify run failed with status: ${status}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  throw new Error("Apify run did not finish within the timeout");
}

export async function POST(request: Request) {
  try {
    const token = process.env.APIFY_API_TOKEN?.trim();

    if (!token) {
      return NextResponse.json(
        { ok: false, error: "APIFY_API_TOKEN is not configured" },
        { status: 500 },
      );
    }

    const body = await request.json().catch(() => ({}));

    const searchQuery =
      typeof body.searchQuery === "string" ? body.searchQuery.trim() : "";

    if (!searchQuery) {
      return NextResponse.json(
        { ok: false, error: "searchQuery is required" },
        { status: 400 },
      );
    }

    const runResponse = await fetch(
      `${APIFY_API}/acts/${APIFY_ACTOR}/runs?token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          searchQueries: [searchQuery],
          searchSection: "/video",
          resultsPerPage: 10,
          videoSearchSorting: "MOST_LIKED",
          videoSearchDateFilter: "PAST_WEEK",
          scrapeRelatedSearchWords: true,
          shouldDownloadVideos: false,
          shouldDownloadCovers: false,
          shouldDownloadAvatars: false,
          shouldDownloadMusicCovers: false,
          downloadSubtitlesOptions: "NEVER_DOWNLOAD_SUBTITLES",
          aiVideoDescription: false,
          aiVideoSummary: false,
          commentsPerPost: 0,
          proxyCountryCode: "JP",
        }),
      },
    );

    const runText = await runResponse.text();

    if (!runResponse.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: `Apify request failed: ${runResponse.status}`,
          details: runText,
        },
        { status: 502 },
      );
    }

    const runResult = JSON.parse(runText);
    const runId = runResult?.data?.id;

    if (!runId) {
      throw new Error("Apify did not return a runId");
    }

    const run = await waitForRun(token, runId);

    if (!run.datasetId) {
      throw new Error("Apify run completed without a datasetId");
    }

    const datasetResponse = await fetch(
      `${APIFY_API}/datasets/${encodeURIComponent(run.datasetId)}/items?clean=true&limit=10`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
      },
    );

    const datasetText = await datasetResponse.text();

    if (!datasetResponse.ok) {
      throw new Error(
        `Apify dataset request failed: ${datasetResponse.status} ${datasetText}`,
      );
    }

    const items = JSON.parse(datasetText) as TikTokItem[];

    const videos = Array.isArray(items) ? items : [];

    const totalPlayCount = videos.reduce(
      (sum, item) => sum + toNumber(item.playCount),
      0,
    );

    const totalDiggCount = videos.reduce(
      (sum, item) => sum + toNumber(item.diggCount),
      0,
    );

    const totalShareCount = videos.reduce(
      (sum, item) => sum + toNumber(item.shareCount),
      0,
    );

    const totalCommentCount = videos.reduce(
      (sum, item) => sum + toNumber(item.commentCount),
      0,
    );

    const totalCollectCount = videos.reduce(
      (sum, item) => sum + toNumber(item.collectCount),
      0,
    );

    const supabase = createSupabaseAdminClient();

    const sourceResult = await supabase
      .from("sources")
      .select("id")
      .eq("name", "TikTok")
      .maybeSingle();

    if (sourceResult.error) {
      throw new Error(
        `Failed to find TikTok source: ${sourceResult.error.message}`,
      );
    }

    let sourceId: string;

    if (sourceResult.data) {
      sourceId = sourceResult.data.id;
    } else {
      const insertSource = await supabase
        .from("sources")
        .insert({
          name: "TikTok",
          source_type: "social",
          base_url: "https://www.tiktok.com",
          provider: "apify",
        })
        .select("id")
        .single();

      if (insertSource.error) {
        throw new Error(
          `Failed to create TikTok source: ${insertSource.error.message}`,
        );
      }

      sourceId = insertSource.data.id;
    }

    const topVideos = videos.slice(0, 10).map((item) => ({
      url: item.webVideoUrl ?? item.videoWebUrl ?? null,
      text: item.text ?? item.desc ?? null,
      play_count: toNumber(item.playCount),
      digg_count: toNumber(item.diggCount),
      share_count: toNumber(item.shareCount),
      comment_count: toNumber(item.commentCount),
      collect_count: toNumber(item.collectCount),
      author: item.authorMeta?.name ?? item.authorMeta?.nickName ?? null,
    }));

    const { data: observation, error: observationError } = await supabase
      .from("demand_observations")
      .insert({
        product_id: null,
        source_id: sourceId,
        signal_type: "social_mentions",
        value: totalPlayCount,
        unit: "views",
        observed_at: new Date().toISOString(),
        metadata: {
          query: searchQuery,
          original_query: searchQuery,
          provider: "tiktok_apify",
          source_url: "https://www.tiktok.com",
          run_id: runId,
          dataset_id: run.datasetId,
          result_count: videos.length,
          total_play_count: totalPlayCount,
          total_digg_count: totalDiggCount,
          total_share_count: totalShareCount,
          total_comment_count: totalCommentCount,
          total_collect_count: totalCollectCount,
          video_search_sorting: "MOST_LIKED",
          video_search_date_filter: "PAST_WEEK",
          proxy_country: "JP",
          videos: topVideos,
        },
      })
      .select("id")
      .single();

    if (observationError) {
      throw new Error(
        `Failed to insert TikTok demand observation: ${observationError.message}`,
      );
    }

    return NextResponse.json({
      ok: true,
      actor: APIFY_ACTOR,
      searchQuery,
      runId,
      status: run.status,
      datasetId: run.datasetId,
      observationId: observation.id,
      resultCount: videos.length,
      totalPlayCount,
      totalDiggCount,
      totalShareCount,
      totalCommentCount,
      totalCollectCount,
      signalType: "social_mentions",
    });
  } catch (error) {
    console.error("[TRACER TIKTOK API ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

