async function settings() {
    return chrome.storage.local.get({
        apiUrl: "http://localhost:3000",
        apiKey: "",
    });
}
export async function sendProduct(product) {
    const config = await settings();
    const response = await fetch(`${config.apiUrl.replace(/\/$/, "")}/api/extension/product`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(config.apiKey ? { "X-TRACER-EXTENSION-KEY": config.apiKey } : {}),
        },
        body: JSON.stringify(product),
    });
    const body = (await response.json());
    if (!response.ok) {
        throw new Error(body.error || `TRACER returned HTTP ${response.status}`);
    }
    return body;
}
export async function saveSettings(apiUrl, apiKey) {
    await chrome.storage.local.set({
        apiUrl: apiUrl.trim().replace(/\/$/, ""),
        apiKey: apiKey.trim(),
    });
}
