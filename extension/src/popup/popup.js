import { sendProduct, saveSettings } from "../api.js";

const status = document.getElementById("status");
const capture = document.getElementById("capture");
const save = document.getElementById("save");
const apiBase = document.getElementById("apiBase");
const extensionKey = document.getElementById("extensionKey");

chrome.storage.local.get({ apiBase: "", extensionKey: "" }).then((settings) => {
  apiBase.value = settings.apiBase;
  extensionKey.value = settings.extensionKey;
});

capture.addEventListener("click", async () => {
  status.textContent = "Capturing…";
  try {
    const settings = await chrome.storage.local.get({ apiBase: "", extensionKey: "" });
    if (!settings.apiBase) {
      throw new Error("Open Settings below and save your TRACER deployment URL first.");
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https:\/\/(?:[^/]+\.)?amazon\.(com|co\.jp)(?:\/|$)/i.test(tab.url || "")) {
      throw new Error("Open an Amazon product page first.");
    }

    const captured = await chrome.tabs.sendMessage(tab.id, { type: "TRACER_CAPTURE" });
    if (!captured?.ok) throw new Error("Could not capture product data.");

    const result = await sendProduct(captured.product);
    const p = result.product || {};
    const persisted = result.persisted || {};

    status.textContent = [
      "Sent to TRACER.",
      `Title: ${p.title || captured.product.title || "—"}`,
      `ASIN: ${captured.product.asin || "—"}`,
      `Price: ${captured.product.price_text || p.pricing?.price || "—"}`,
      `TRACER product: ${persisted.productId || "—"}`,
      `EC-Pulse: ${result.ecPulse ? "synced" : "not configured"}`
    ].join("\\n");
  } catch (error) {
    status.textContent = `Error: ${error.message}`;
  }
});

save.addEventListener("click", async () => {
  await saveSettings(apiBase.value, extensionKey.value);
  status.textContent = "Settings saved.";
});
