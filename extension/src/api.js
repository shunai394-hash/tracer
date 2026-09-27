const DEFAULT_API_BASE = "";

async function getSettings() {
  return chrome.storage.local.get({
    apiBase: DEFAULT_API_BASE,
    extensionKey: ""
  });
}

function normalizeApiBase(value) {
  const base = value.trim().replace(/\/$/, "");
  if (!base) throw new Error("Set the TRACER API base URL in Settings first.");
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error("TRACER API base URL is invalid.");
  }
  if (url.protocol !== "https:") {
    throw new Error("TRACER API base URL must use HTTPS.");
  }
  return base;
}

export async function sendProduct(product) {
  const settings = await getSettings();
  const apiBase = normalizeApiBase(settings.apiBase);
  const headers = { "Content-Type": "application/json" };
  if (settings.extensionKey) headers["X-TRACER-Extension-Key"] = settings.extensionKey;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  let response;
  try {
    response = await fetch(`${apiBase}/api/extension/product`, {
      method: "POST",
      headers,
      body: JSON.stringify(product),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("TRACER request timed out.");
    throw new Error("Could not connect to TRACER. Check the deployment URL and network.");
  } finally {
    clearTimeout(timeout);
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) throw new Error("Extension authentication failed. Check the ingestion key.");
    throw new Error(body?.error || `TRACER API failed (${response.status})`);
  }
  return body;
}

export async function saveSettings(apiBase, extensionKey) {
  const normalized = apiBase.trim().replace(/\/$/, "");
  if (normalized) normalizeApiBase(normalized);
  await chrome.storage.local.set({
    apiBase: normalized || DEFAULT_API_BASE,
    extensionKey: extensionKey.trim()
  });
}
