"use strict";
function textFrom(selector) {
    const node = document.querySelector(selector);
    const value = node?.textContent?.replace(/\s+/g, " ").trim();
    return value || null;
}
function numberFromText(value) {
    if (!value)
        return null;
    const normalized = value.replace(/,/g, "").replace(/[^0-9.]/g, "");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}
function extractAsin(url) {
    const match = url.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i);
    return match?.[1]?.toUpperCase() ?? null;
}
function jsonLdObjects() {
    const result = [];
    for (const node of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
        try {
            const parsed = JSON.parse(node.textContent || "");
            const values = Array.isArray(parsed) ? parsed : [parsed];
            for (const value of values) {
                if (value && typeof value === "object") {
                    result.push(value);
                }
            }
        }
        catch {
            // Ignore malformed JSON-LD.
        }
    }
    return result;
}
function firstString(...values) {
    for (const value of values) {
        if (typeof value === "string" && value.trim())
            return value.trim();
        if (typeof value === "number" && Number.isFinite(value))
            return String(value);
    }
    return null;
}
function detailValue(labels) {
    const wanted = new Set(labels.map((label) => label.replace(/\s+/g, "").replace(/[：:]/g, "").toLowerCase()));
    const candidates = Array.from(document.querySelectorAll("#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, #detailBullets_feature_div li, #prodDetails tr"));
    for (const node of candidates) {
        const text = node.textContent?.replace(/\s+/g, " ").trim() ?? "";
        if (!text)
            continue;
        const cells = Array.from(node.querySelectorAll("th, td")).map((cell) => cell.textContent?.replace(/\s+/g, " ").trim() ?? "").filter(Boolean);
        const label = cells[0] ?? text.split(/[:：]/, 1)[0]?.trim() ?? "";
        const normalizedLabel = label.replace(/\s+/g, "").replace(/[：:]/g, "").toLowerCase();
        if (!wanted.has(normalizedLabel))
            continue;
        if (cells.length >= 2)
            return cells.slice(1).join(" ").trim() || null;
        const separator = text.match(/^(.+?)\s*[:：]\s*(.+)$/);
        if (separator && wanted.has(separator[1].replace(/\s+/g, "").replace(/[：:]/g, "").toLowerCase())) {
            return separator[2].trim() || null;
        }
    }
    return null;
}
function capture() {
    const jsonLd = jsonLdObjects();
    const product = jsonLd.find((value) => {
        const type = value["@type"];
        return type === "Product" || (Array.isArray(type) && type.includes("Product"));
    }) ?? {};
    const offers = product.offers && typeof product.offers === "object"
        ? product.offers
        : {};
    const brandValue = product.brand && typeof product.brand === "object"
        ? product.brand.name
        : product.brand;
    const title = textFrom("#productTitle") ??
        firstString(product.name) ??
        document.title.replace(/Amazon.*$/i, "").trim();
    const imageValue = Array.isArray(product.image)
        ? product.image[0]
        : product.image;
    const asin = extractAsin(location.href);
    const manufacturer = detailValue(["メーカー", "Manufacturer"]);
    const modelNumber = detailValue([
        "商品モデル番号",
        "Item model number",
        "Model number",
        "Manufacturer part number",
        "MPN",
    ]);
    const gtin = firstString(product.gtin13, product.gtin12, product.gtin14, product.gtin);
    const priceText = textFrom("#corePriceDisplay_desktop_feature_div .a-price .a-offscreen") ??
        textFrom("#priceblock_ourprice") ??
        textFrom("#priceblock_dealprice") ??
        firstString(offers.price);
    return {
        url: location.href,
        title,
        price: numberFromText(priceText),
        currency: firstString(offers.priceCurrency) ?? (location.hostname.endsWith(".co.jp") ? "JPY" : null),
        imageUrl: firstString(imageValue) ??
            document.querySelector('meta[property="og:image"]')?.content ??
            null,
        asin,
        jan: null,
        gtin,
        ean: null,
        upc: firstString(product.gtin12),
        mpn: firstString(product.mpn) ?? modelNumber,
        brand: firstString(brandValue) ?? manufacturer,
    };
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "TRACER_CAPTURE_PRODUCT")
        return false;
    try {
        sendResponse({ ok: true, product: capture() });
    }
    catch (error) {
        sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : "Failed to capture product",
        });
    }
    return true;
});
