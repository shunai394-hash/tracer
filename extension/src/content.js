(() => {
  function text(selector) {
    return document.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() || null;
  }

  function meta(name) {
    return document.querySelector(`meta[name="${name}"]`)?.content?.trim() || null;
  }

  function extractAsin(url) {
    return url.match(/\//g(?:dp|gp\/product|gp\/aw\/d)\\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase() || null;
  }

  function extractPrice() {
    const selectors = [
      "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen",
      "#corePrice_feature_div .a-offscreen",
      "#priceblock_ourprice",
      "#priceblock_dealprice",
      "#priceblock_saleprice",
      ".a-price .a-offscreen"
    ];
    for (const selector of selectors) {
      const value = text(selector);
      if (value) return value;
    }
    return null;
  }

  function extractImage() {
    return document.querySelector("#landingImage")?.src ||
      document.querySelector("#imgBlkFront")?.src ||
      meta("og:image") ||
      null;
  }

  function captureProduct() {
    const url = location.href;
    const title = text("#productTitle") || meta("og:title") || document.title || null;
    const brand = text("#bylineInfo")?.replace(/^Visit the /i, "").replace(/ Store$/i, "") || null;
    const image = extractImage();

    return {
      source: "amazon",
      url,
      asin: extractAsin(url),
      title,
      brand,
      price_text: extractPrice(),
      image,
      captured_at: new Date().toISOString()
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "TRACER_CAPTURE") {
      sendResponse({ ok: true, product: captureProduct() });
    }
    return true;
  });
})();
