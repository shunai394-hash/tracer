import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type NewProductItem = {
  source_name: string;
  source_url: string;
  external_id: string | null;
  title: string;
  description: string | null;
  product_url: string | null;
  image_url: string | null;
  category: string;
  published_at: string | null;
  launch_date: string | null;
  raw_data: Record<string, unknown>;
};

type FeedConfig = {
  name: string;
  url: string;
};

const FEEDS: FeedConfig[] = [
  {
    name: "Yanko Design",
    url: "https://www.yankodesign.com/feed/",
  },
  {
    name: "Designboom",
    url: "https://www.designboom.com/feed/",
  },
  {
    name: "TechRadar",
    url: "https://www.techradar.com/rss",
  },
];


function repairMojibake(value: string | null): string | null {
  if (!value) return value;

  let current = value;

  for (let i = 0; i < 3; i++) {
    if (!/[ÃÂâ]/.test(current)) {
      break;
    }

    try {
      const bytes = Uint8Array.from(
        Array.from(current, (char) => char.charCodeAt(0) & 0xff),
      );

      const repaired = new TextDecoder("utf-8", {
        fatal: true,
      }).decode(bytes);

      if (repaired === current) {
        break;
      }

      current = repaired;
    } catch {
      break;
    }
  }

  return current
    .replace(/â€™/g, "’")
    .replace(/â€˜/g, "‘")
    .replace(/â€œ/g, "“")
    .replace(/â€�/g, "”")
    .replace(/â€“/g, "–")
    .replace(/â€”/g, "—")
    .replace(/â€¦/g, "…")
    .replace(/Â£/g, "£")
    .replace(/Â©/g, "©")
    .replace(/Â®/g, "®");
}
function decodeXml(value: string): string {
  const decoded = value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCodePoint(Number(n)),
    )
    .replace(/<[^>]+>/g, "")
    .trim();

  return repairMojibake(decoded) ?? decoded;
}

function tagValue(xml: string, tag: string): string | null {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const match = xml.match(
    new RegExp(
      `<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`,
      "i",
    ),
  );

  return match ? decodeXml(match[1]) : null;
}

function attributeValue(
  xml: string,
  tag: string,
  attribute: string,
): string | null {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedAttribute = attribute.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );

  const match = xml.match(
    new RegExp(
      `<${escapedTag}\\b[^>]*\\b${escapedAttribute}=["']([^"']+)["']`,
      "i",
    ),
  );

  return match ? decodeXml(match[1]) : null;
}

function classify(title: string, description: string): string {
  const text = `${title} ${description}`.toLowerCase();

  if (
    /\b(ai|artificial intelligence|machine learning|generative ai|chatgpt|llm)\b/i.test(
      text,
    )
  ) {
    return "ai";
  }

  if (
    /\b(robot|robotics|humanoid|drone|autonomous)\b/i.test(text)
  ) {
    return "robotics";
  }

  if (
    /\b(ar|vr|mixed reality|virtual reality|augmented reality|meta quest)\b/i.test(
      text,
    )
  ) {
    return "ar-vr";
  }

  if (
    /\b(future|upcoming|launch|launches|prototype|concept|coming soon)\b/i.test(
      text,
    )
  ) {
    return "future";
  }

  return "gadgets";
}

function extractItems(
  xml: string,
  feed: FeedConfig,
): NewProductItem[] {
  const blocks =
    xml.match(/<(item|entry)\b[^>]*>[\s\S]*?<\/\1>/gi) ?? [];

  const items: NewProductItem[] = [];

  for (const block of blocks) {
    const title = tagValue(block, "title");

    if (!title) continue;

    const description =
      tagValue(block, "description") ??
      tagValue(block, "content:encoded") ??
      tagValue(block, "summary") ??
      null;

    const productUrl =
      tagValue(block, "link") ??
      attributeValue(block, "link", "href");

    const imageUrl =
      attributeValue(block, "media:content", "url") ??
      attributeValue(block, "media:thumbnail", "url") ??
      attributeValue(block, "enclosure", "url");

    const publishedAt =
      tagValue(block, "pubDate") ??
      tagValue(block, "published") ??
      tagValue(block, "updated") ??
      null;

    const externalId =
      tagValue(block, "guid") ??
      tagValue(block, "id") ??
      productUrl ??
      null;

    const cleanDescription = description ? repairMojibake(description.slice(0, 5000)) : null;

    items.push({
      source_name: feed.name,
      source_url: feed.url,
      external_id: externalId,
      title: repairMojibake(title) ?? title,
      description: cleanDescription,
      product_url: productUrl,
      image_url: imageUrl,
      category: classify(title, cleanDescription ?? ""),
      published_at: publishedAt,
      launch_date: null,
      raw_data: {
        feed: feed.url,
      },
    });
  }

  return items;
}

async function fetchFeed(feed: FeedConfig): Promise<NewProductItem[]> {
  const response = await fetch(feed.url, {
    headers: {
      "User-Agent": "TRACER/1.0 New Product Intelligence",
      Accept: "application/rss+xml, application/xml, text/xml",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      `${feed.name} request failed: ${response.status} ${response.statusText}`,
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());

  const contentType =
    response.headers.get("content-type") ?? "";

  const headerCharset =
    contentType.match(/charset=["']?([^;"'\s]+)/i)?.[1] ?? null;

  const utf8Xml = new TextDecoder("utf-8", {
    fatal: false,
  }).decode(bytes);

  const xmlCharset =
    utf8Xml.match(
      /<\?xml[^>]+encoding=["']([^"']+)["']/i,
    )?.[1] ?? null;

  const charset =
    headerCharset ??
    xmlCharset ??
    "utf-8";

  let xml: string;

  try {
    xml = new TextDecoder(charset).decode(bytes);
  } catch {
    xml = utf8Xml;
  }

  return extractItems(xml, feed);
}

export async function collectNewProducts() {
  const allItems: NewProductItem[] = [];
  const errors: string[] = [];

  for (const feed of FEEDS) {
    try {
      const items = await fetchFeed(feed);
      allItems.push(...items);
    } catch (error) {
      errors.push(
        `${feed.name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (allItems.length === 0) {
    throw new Error(
      errors.length > 0
        ? errors.join("; ")
        : "No new product items were collected",
    );
  }

  const supabase = createSupabaseAdminClient();

  const rows = allItems.map((item) => ({
    source_name: item.source_name,
    source_url: item.source_url,
    external_id: item.external_id,
    title: repairMojibake(item.title) ?? item.title,
    description: repairMojibake(item.description),
    product_url: item.product_url,
    image_url: item.image_url,
    category: item.category,
    published_at: item.published_at
      ? new Date(item.published_at).toISOString()
      : null,
    launch_date: item.launch_date,
    raw_data: item.raw_data,
  }));

  const { data, error } = await supabase
    .from("tracer_new_products")
    .upsert(rows, {
      onConflict: "source_name,external_id",
      ignoreDuplicates: false,
    })
    .select("id");

  if (error) {
    throw new Error(
      `Failed to save new products: ${error.message}`,
    );
  }

  return {
    fetched: allItems.length,
    saved: data?.length ?? 0,
    errors,
  };
}







