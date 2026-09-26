chrome.runtime.onInstalled.addListener(() => {
  console.log("TRACER Product Capture installed");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "TRACER_PING") {
    sendResponse({ ok: true });
    return true;
  }

  return false;
});
