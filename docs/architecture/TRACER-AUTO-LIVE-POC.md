# TRACER AI Avatar Live — Read-Only POC Plan

## Goal

Build a low-cost 30–60 minute local proof of concept in which a Japanese-speaking AI avatar introduces one TRACER product and answers simulated viewer comments with speech. This phase is local-only and read-only. It does not publish listings, change inventory/prices, create orders, or connect to a public TikTok LIVE.

## Existing-system boundary

- TRACER remains the source of truth for product data.
- Reuse an existing authenticated read path where possible; do not add a public unauthenticated product endpoint.
- Never expose supplier cost, supplier credentials, service-role keys, internal notes, or private order data to the avatar process.
- Do not change existing sales gates, scheduled jobs, database schema, listing status, pricing, stock, or channel integrations.
- Do not call any supplier or commerce write API from the POC.
- Fail closed if product data is missing, stale, unpublished, out of stock, or ambiguous.

## POC flow

1. Read one eligible published product from TRACER using an authenticated server-side path.
2. Normalize only safe display fields: listing ID, Japanese title, approved description, displayed selling price/currency, positive inventory indicator, public product URL, and fetched-at timestamp.
3. Feed the normalized record to a constrained response generator.
4. Use simulated comments first: price, product features, availability, and purchase location.
5. Convert the answer to Japanese speech and drive a locally rendered avatar (OBS or another local preview output).
6. Log timings and redacted errors; do not store raw viewer personal data.
7. Run a 30–60 minute local test and produce a test report before considering a platform connection.

## Suggested low-cost stack

- Existing TRACER app/API for authenticated read-only product data.
- Local Node.js/TypeScript runner for orchestration; no new always-on Vercel workload.
- A local avatar model and local renderer where practical.
- Start with push-to-talk or simulated comment events and a low-cost TTS provider. Evaluate realtime speech-to-speech only after latency and cost are measured.
- OBS for local scene preview. Public streaming remains disabled in this milestone.

## Response rules

- Answer only from the supplied product record.
- Do not invent product features, benefits, stock counts, shipping dates, discounts, reviews, or guarantees.
- If a detail is missing, say it cannot be confirmed and direct the viewer to the official product page.
- Use the displayed selling price only; never reveal supplier cost or margin.
- Avoid medical, financial, or other unsupported efficacy claims.
- Keep spoken answers short (normally one or two sentences) and avoid interrupting an active response.
- Mark the experience clearly as AI-generated during any future platform test, following the platform's current rules.

## Safety and operational controls

- Explicit local-only mode by default.
- Separate configuration flags for mock comments, product read, and any future platform adapter; platform adapter disabled by default.
- Timeouts, rate limits, bounded comment queue, duplicate-comment suppression, and a kill switch.
- If product data cannot be refreshed or its timestamp exceeds the configured freshness limit, stop product-specific claims.
- No credential values in logs, prompts, browser output, or avatar-visible content.
- No automated public LIVE connection until account-specific eligibility, official connection method, comment access, and AI-content disclosure requirements have been verified.

## Acceptance criteria

- Product read path is authenticated and read-only.
- Automated tests prove that secrets/cost/internal fields are omitted from the normalized output.
- Missing, stale, unpublished, and zero-stock product records fail closed.
- Three simulated comment types receive grounded Japanese answers.
- A 30–60 minute local run records successful responses, latency, errors, and estimated API/TTS spend.
- Existing commerce tests pass; no production data or external commerce systems are modified.

## TikTok Japan policy gate (verify before public streaming)

TikTok Shop Japan's AIGC guidance surfaced during planning says AIGC is permitted when compliant, requires clear disclosure, and prohibits misleading product information, fabricated results, impersonation, and low-quality repetitive promotions. This does not itself establish that a specific account has permission to automate public LIVE streaming or that a supported real-time comment API is available. Verify the latest account-specific rules and approved integration path before enabling a platform adapter.

## First implementation task

Inspect the existing TRACER read-only listing/product routes and authentication contracts. Select the safest existing read path and document its exact safe fields. If no suitable path exists, propose a protected read-only route behind existing automation/user authentication and tests; do not implement until its auth contract is clear.


## Local avatar preview (implemented)

Open `scripts/ai-live-avatar-preview.html` directly in a modern desktop browser (Chrome or Edge). No build, API key, account connection, or server is required.

- The avatar is a lightweight CSS illustration with mouth movement during browser speech synthesis.
- A voice selector lists installed Japanese voices when the browser exposes them; if none are available, the page shows a fallback warning.
- Japanese speech uses the browser's built-in `SpeechSynthesisUtterance` with `ja-JP`; voice availability and quality depend on the OS/browser.
- The product and comments are explicitly fictional test fixtures.
- Four simulated comment buttons cover price, features, stock, and delivery. Unknown delivery details are not invented.
- The Stop button cancels current speech; leaving the page also cancels speech.
- The preview contains no network calls, external assets, DB reads, credentials, product feed connection, or public streaming.
- The 30-minute and 60-minute buttons run a local simulated endurance session, speaking one canned comment response every 45 seconds. Stop ends the session; elapsed time and response count are visible but not persisted. This checks browser continuity only, not API reliability or real-time AI latency.
- This preview is not a production-grade 3D avatar, lip-sync engine, real-time AI conversation, or TikTok adapter.

Run the contract checks with `npm run test:ai-live-local-demo`. The test checks the mock runner and verifies the preview's speech controls, disclosure, simulated prompts, and no-network contract. Browser-specific speech quality still needs a manual check.
