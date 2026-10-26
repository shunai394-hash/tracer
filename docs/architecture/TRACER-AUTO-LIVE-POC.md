# TRACER AI Avatar Live — Read-Only POC Plan

## Goal

Build a low-cost 30–60 minute local proof of concept in which a Japanese-speaking AI avatar introduces one TRACER product and answers simulated viewer comments with speech. This phase is local-only and read-only. It does not publish listings, change inventory/prices, create orders, or connect to a public TikTok LIVE.

## Existing-system boundary

- TRACER remains the source of truth for product data.
- Reuse the existing authenticated read path where possible; never add a public unauthenticated product endpoint.
- Never expose supplier cost, supplier credentials, service-role keys, internal notes, or private order data to the avatar process.
- Do not change existing sales gates, scheduled jobs, database schema, listing status, pricing, stock, or channel integrations.
- Do not call any supplier or commerce write API from the POC.
- Fail closed if product data is missing, stale, unpublished, out of stock, or ambiguous.
- The avatar process must not have credentials or code paths capable of changing TRACER or external sales channels.

## Current implementation inventory

The repository already contains:
- `GET /api/admin/ai-live/products`: protected with `requireAutomationAuth(request)`; selects from `shop_listings`; returns a minimized product payload; declares `readOnly: true`; response is `no-store`; limits requested rows to 1–20.
- `public/ai-live-preview.html`: noindex/nofollow local browser preview using browser speech synthesis and synthetic data; it does not call APIs or TikTok.
- `scripts/ai-live-local-demo.mjs` and contract tests: synthetic responses and checks for local-only behavior.

These are code-level observations, not proof of successful production use or a completed real-time AI conversation. The browser preview is not a production 3D avatar, a real AI answer engine, a live comment connector, or a TikTok stream adapter.

## POC flow

1. Read one eligible published product through the existing protected endpoint from a local Node.js runner; never put the automation secret in browser code.
2. Normalize only safe display fields: listing ID, Japanese title, approved description, displayed selling price/currency, positive-stock boolean, public product URL, and fetched-at timestamp.
3. Validate freshness and sale eligibility again in the runner. Missing, stale, unpublished, out-of-stock, or ambiguous records must produce a safe fallback, not a sales claim.
4. Feed the normalized record and a bounded comment to a constrained response generator.
5. Convert the answer to Japanese speech and drive a locally rendered avatar.
6. Log timings and redacted errors; do not persist raw viewer comments or personal data during the pilot.
7. Run a 30–60 minute local test and produce a report before considering a public platform connection.

## Low-cost stack and budget

### Pilot stages

| Stage | Components | Estimated incremental cost for one 30–60 min test |
| --- | --- | ---: |
| A — already available | Current TRACER code, local browser preview, browser Japanese speech synthesis, synthetic comments | ¥0 software cost |
| B — local avatar | OBS Studio + a locally rendered avatar; use free/open-source components only after checking their current license and commercial-use terms | ¥0 software license target; existing PC and internet costs excluded |
| C — grounded product read | Local Node.js runner calling the existing protected endpoint; no new always-on Vercel service | ¥0 additional hosting target; existing hosting usage may still count toward the current plan |
| D — optional AI answers | Low-cost text model, strict token/output cap, bounded queue; keep a no-AI fallback | Budget cap: ¥300 for the first 60-minute trial, then compare actual provider usage |
| E — optional TTS | Prefer local/browser speech or a free local Japanese TTS engine with checked voice-specific terms; use paid TTS only if local quality is insufficient | ¥0 target for local speech; paid usage must be measured and separately capped |

These are pilot budget targets, not vendor quotes or a guarantee of zero charges. The first run should not buy subscriptions, rent a GPU, or add an always-on server. Record actual model/TTS usage, electricity/internet excluded, and stop the test if the configured ¥300 AI budget is reached. If the selected provider cannot enforce a spend cap, use local canned responses for the first endurance test.

### Recommended order

1. Validate the current local preview and read-only API contract.
2. Add a local Node.js runner that uses the protected product feed and synthetic comments; keep the secret in a local environment variable, never in the browser.
3. Use deterministic, grounded response templates first. Add a low-cost LLM only after safe-field tests pass.
4. Add local Japanese TTS and a VRM avatar only after measuring response latency and CPU/GPU load.
5. Test 30 minutes, inspect the report, then test 60 minutes. No public streaming in these stages.

## Response rules

- Answer only from the supplied product record.
- Do not invent product features, benefits, stock counts, shipping dates, discounts, reviews, or guarantees.
- If a detail is missing, say it cannot be confirmed and direct the viewer to the official product page.
- Use the displayed selling price only; never reveal supplier cost or margin.
- Avoid medical, financial, or other unsupported efficacy claims.
- Keep spoken answers short (normally one or two sentences) and avoid interrupting an active response.
- Identify the presenter as AI-generated when required by the platform's current rules; do not impersonate a real person.

## Safety and operational controls

- Explicit local-only mode by default.
- Separate configuration flags for mock comments, product read, AI generation, TTS, and any future platform adapter; platform adapter disabled by default.
- Timeouts, rate limits, a bounded comment queue, duplicate-comment suppression, and a visible kill switch.
- If product data cannot be refreshed or its timestamp exceeds a configured freshness limit, stop product-specific claims.
- No credential values in logs, prompts, browser output, or avatar-visible content.
- No automatic product purchases, order creation, inventory changes, listing publication, channel sync, or supplier API calls.
- No automated public LIVE connection until account-specific eligibility, approved connection method, comment access, and AI-content disclosure requirements have been verified.

## TikTok Japan: preflight gate before public streaming

Public TikTok LIVE is a separate milestone from the local POC. LIVE hosts generally need to be at least 18, and follower/access thresholds and available features can vary by account, age, region, and product surface. Treat this as a planning baseline, not account-specific approval: confirm eligibility in the Japanese TikTok app and review the current official policy pages below. Do not assume that access to LIVE automatically grants access to LIVE Studio, an automated comment feed, or a public API.

- LIVE eligibility and account requirements: [TikTok Support — TikTok LIVE](https://support.tiktok.com/ja/live-gifts-wallet/tiktok-live/what-is-tiktok-live)
- AI-generated content labels and restrictions: [TikTok Support — AI-generated content](https://support.tiktok.com/ja/safety-hc/account-and-user-safety/ai-generated-content)
- Creator/Studio product access: [TikTok Studio](https://www.tiktok.com/studio)
- Developer documentation and approved integrations: [TikTok for Developers](https://developers.tiktok.com/)

Preflight checklist:
1. Confirm the Japanese account can start a LIVE and that the intended desktop/streaming workflow is available to that account.
2. Confirm the permitted way to transmit video/audio and whether an official, approved real-time comment interface is available to this account/app. Do not use scraping, unofficial login automation, or reverse-engineered endpoints.
3. Confirm current AI-generated content labeling requirements for the specific avatar, voice, and stream format; display a clear Japanese disclosure in the scene as well.
4. Review LIVE/community, commercial content, music, intellectual-property, and TikTok Shop rules if products are promoted or tagged. Do not imply that a Shop AI-content guideline by itself authorizes automated LIVE streaming.
5. Test with a private/local rehearsal first; require a human operator, visible stop control, and moderation/escalation behavior before any public trial.

As of this design pass, account-specific eligibility and an approved real-time comment API have not been verified. Therefore the TikTok adapter stays disabled. Do not state a universal follower threshold as guaranteed; check the account's in-app eligibility and the current official rules.

## Acceptance criteria

- Product read path is authenticated and read-only.
- Automated tests prove that secrets/cost/internal fields are omitted from normalized output.
- Missing, stale, unpublished, zero-stock, or ambiguous product records fail closed.
- At least three simulated comment types receive grounded Japanese answers; unknown questions get a safe fallback.
- A 30–60 minute local run records successful responses, latency, errors, stop behavior, and estimated API/TTS spend.
- Actual test spend stays within the configured cap; if the cap cannot be enforced, no paid AI service is used.
- Existing commerce tests pass; no production data or external commerce systems are modified.
- Public streaming remains disabled until the TikTok preflight checklist is evidenced and approved.

## First implementation task (next)

**Harden and test the read-only product feed freshness contract before connecting AI or TTS.**

1. Add tests for authenticated access, published/orderable/tracking/positive-stock gates, Japanese title filtering, no-store headers, and absence of sensitive fields.
2. Add an explicit maximum product-data age check using `updatedAt` (initial target: 24 hours, configurable); stale records must be omitted or return a safe non-sale response. Do not silently claim the data is live.
3. Ensure a local runner reads the protected endpoint server-side only; no secret is placed in `public/ai-live-preview.html` or client JavaScript.
4. Add deterministic answer templates for price, features, availability, purchase URL, and unknown questions. All statements must be supported by the normalized product record.
5. Run the feed contract test and the existing local-demo test. Report each result separately; do not deploy or connect TikTok as part of this task.

The current route already has an auth gate and minimizes fields, but the explicit freshness contract and an end-to-end local runner remain the next implementation gaps to validate.

## Local avatar preview (implemented)

The local preview is `/ai-live-preview.html` on a deployment that contains the file. It is marked noindex/nofollow and uses no API key, account connection, or server-side service.

- The avatar is a lightweight CSS illustration with mouth movement during browser speech synthesis.
- A voice selector lists installed Japanese voices when the browser exposes them; availability and quality depend on the OS/browser.
- Japanese speech uses the browser's built-in `SpeechSynthesisUtterance` with `ja-JP`.
- Product and comment content are explicitly synthetic fixtures.
- Simulated comment buttons cover price, features, stock, purchase location, and delivery. Unknown delivery details are not invented.
- The Stop button cancels current speech; leaving the page also cancels speech.
- The preview contains no network calls, external assets, DB reads, credentials, product feed connection, or public streaming.
- The 30-minute and 60-minute buttons speak a canned response every 45 seconds. Stop ends the session; elapsed time and response count are not persisted. This checks browser continuity only, not API reliability or real-time AI latency.

Run the contract checks with `npm run test:ai-live-local-demo` and `npm run test:ai-live-product-feed`. Browser-specific speech quality still needs a manual check.
