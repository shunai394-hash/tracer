import { saveSettings, sendProduct } from "../api";
const status = document.getElementById("status");
const captureButton = document.getElementById("capture");
const apiUrl = document.getElementById("apiUrl");
const apiKey = document.getElementById("apiKey");
const saveButton = document.getElementById("save");
function setStatus(message, ok = false) {
    status.textContent = message;
    status.className = ok ? "ok" : "error";
}
async function loadSettings() {
    const settings = await chrome.storage.local.get({
        apiUrl: "http://localhost:3000",
        apiKey: "",
    });
    apiUrl.value = settings.apiUrl;
    apiKey.value = settings.apiKey;
}
saveButton.addEventListener("click", async () => {
    await saveSettings(apiUrl.value, apiKey.value);
    setStatus("接続設定を保存しました。", true);
});
captureButton.addEventListener("click", async () => {
    captureButton.disabled = true;
    setStatus("Amazonページから商品情報を取得中…");
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab.id)
            throw new Error("アクティブなタブを取得できません");
        const response = await chrome.tabs.sendMessage(tab.id, {
            type: "TRACER_CAPTURE_PRODUCT",
        });
        if (!response?.ok || !response.product) {
            throw new Error(response?.error || "商品情報を取得できません");
        }
        setStatus("TRACER / EC-Pulseへ送信中…");
        const result = await sendProduct(response.product);
        const identity = result.identity;
        const persisted = result.persisted;
        const ecPulse = result.ecPulse;
        setStatus([
            `保存完了: ${persisted?.productId ?? "-"}`,
            `Identity: ${identity?.method ?? "none"} / ${identity?.confidence ?? 0}`,
            `Sales eligible: ${identity?.salesEligible ? "YES" : "NO"}`,
            `EC-Pulse: ${persisted?.ecPulse ? "CONNECTED" : "NOT CONNECTED"}`,
            ecPulse ? `EC-Pulse価格: ${ecPulse.price ?? "-"} ${ecPulse.currency ?? ""}` : "",
        ].filter(Boolean).join("\n"), true);
    }
    catch (error) {
        setStatus(error instanceof Error ? error.message : "送信に失敗しました");
    }
    finally {
        captureButton.disabled = false;
    }
});
void loadSettings();
