type TracerMessage = {
  type?: string;
};

function isTracerMessage(value: unknown): value is TracerMessage {
  return typeof value === "object" && value !== null;
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("TRACER Product Capture installed");
});

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => {
    if (!isTracerMessage(message)) return false;

    if (message.type === "TRACER_PING") {
      sendResponse({ ok: true });
      return true;
    }

    return false;
  },
);
