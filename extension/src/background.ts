chrome.runtime.onInstalled.addListener(() => {
  console.log("TRACER Product Capture installed");
});

chrome.runtime.onMessage.addListener(
  (message: any, _sender: any, sendResponse: (response: unknown) => void) => {
    if (message?.type === "TRACER_PING") {
      sendResponse({ ok: true });
      return true;
    }

    return false;
  },
);
