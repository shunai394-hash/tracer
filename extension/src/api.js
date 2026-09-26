const DEFAULT_API_BASE = "";

async function getSettings() {
  return chrome.storage.local.get({
    apiBase: DEFAULT_API_BASE,
    extensionKey: ""
  });
}

export async function sendProduct(product) {
  const settings = await getSettings();
  const headers = { "Content-Type": "application/json" };
  if (settings.extensionKey) headers["X-TRACER-Extension-Key"] = settings.extensionKey;

  const response = await fetch(`${settings.apiBase.replace(/\\/$/, "")}/api/extension/product`, {
    method: "POST",
    headers,
    body: JSON.stringify(product)
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error || `TRACER API failed (${response.status})`);
  }
  return body;
}

export async function saveSettings(apiBase, extensionKey) {
  await chrome.storage.local.set({
    apiBase: apiBase.trim().replace(/\\/$/, "") || DEFAULT_API_BASE,
    extensionKey: extensionKey.trim()
  });
}
