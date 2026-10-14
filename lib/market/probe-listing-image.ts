import { isHttpImageUrl } from "./channel-listing-eligibility.ts";

export async function probeListingImage(url: unknown, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!isHttpImageUrl(url)) return false;
  try {
    const response = await fetchImpl(String(url).trim(), { method: "GET", redirect: "follow", signal: AbortSignal.timeout(5000) });
    if (!response.ok) return false;
    const contentType = response.headers.get("content-type") ?? "";
    return contentType.toLowerCase().startsWith("image/");
  } catch {
    return false;
  }
}
