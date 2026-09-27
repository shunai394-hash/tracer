# TRACER Product Capture — Chrome Web Store listing

## Short description
Capture Amazon product data and send it to TRACER for product research.

## Detailed description
TRACER Product Capture lets users capture structured product information from supported Amazon product pages and send it to their TRACER workspace.

### What it captures
- Product page URL
- ASIN when available
- Product title
- Brand when available
- Current displayed price when available
- Primary product image URL when available
- Capture timestamp

### What it does not do
- It does not collect general browsing history.
- It does not read passwords, cookies, bookmarks, or payment data.
- It does not contain EC-Pulse API keys or database service credentials.
- It does not modify marketplace listings.

### Supported sites
The initial release supports Amazon.com and Amazon.co.jp product pages.

### Permissions
- activeTab: access the page the user explicitly chooses to capture.
- storage: save the user's TRACER endpoint and extension settings locally.
- Amazon host access: run the capture content script on supported Amazon pages.
- TRACER deployment host access: send captured product data to the configured TRACER API.

### Privacy
See the TRACER Privacy Policy at the deployment's /privacy page. The extension only sends product-capture fields required for the requested research workflow.

### Support
Use the TRACER support channel associated with your workspace.
