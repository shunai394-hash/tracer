import { saveSettings, sendProduct, type CapturedProduct } from "../api";

const status = document.getElementById("status") as HTMLDivElement;
const captureButton = document.getElementById("capture") as HTMLButtonElement;
const apiUrl = document.getElementById("apiUrl") as HTMLInputElement;
const apiKey = document.getElementById("apiKey") as HTMLInputElement;
const saveButton = document.getElementById("save") as HTMLButtonElement;

function setStatus(message: string, ok = false) {
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

    if (!tab.id) throw new Error("アクティブなタブを取得できません");

    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "TRACER_CAPTURE_PRODUCT",
    }) as { ok: boolean; product?: CapturedProduct; error?: string };

    if (!response?.ok || !response.product) {
      throw new Error(response?.error || "商品情報を取得できません");
    }

    setStatus("TRACER / EC-Pulseへ送信中…");
    const result = await sendProduct(response.product);

    const identity = result.identity;
    const persisted = result.persisted;
    const ecPulse = result.ecPulse;

    setStatus(
      [
        `保存完了: ${persisted?.productId ?? "-"}`,
        `Identity: ${identity?.method ?? "none"} / ${identity?.confidence ?? 0}`,
        `Sales eligible: ${identity?.salesEligible ? "YES" : "NO"}`,
        `EC-Pulse: ${persisted?.ecPulse ? "CONNECTED" : "NOT CONNECTED"}`,
        ecPulse ? `EC-Pulse価格: ${ecPulse.price ?? "-"} ${ecPulse.currency ?? ""}` : "",
      ].filter(Boolean).join("\n"),
      true,
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "送信に失敗しました");
  } finally {
    captureButton.disabled = false;
  }
});

void loadSettings();
