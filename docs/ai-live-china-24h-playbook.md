# TRACER AI-live: China-inspired 24/7 commerce playbook

## Goal

Adapt proven operating patterns from China's AI digital-human livestream commerce to TRACER without copying platform-specific behavior blindly. The goal is a durable, low-cost Japanese-language shopping broadcast that introduces only verified TRACER products, answers common viewer questions, and hands off uncertain cases safely.

This document is a plan, not a claim that 24/7 streaming is already implemented.

## Patterns worth adapting

Public reporting describes Chinese digital-human livestreams covering overnight hours, presenting standardized product information, and answering frequently asked questions. JD and other operators have reported broad deployment; these figures are company/media-reported outcomes, not guaranteed results for TRACER.

1. **Fill quiet hours:** schedule a continuous rotation of approved product segments rather than relying on a human host for every hour.
2. **Structured product knowledge:** prepare concise, source-backed facts, use cases, dimensions, included items, shipping and return information, and a small FAQ for each product.
3. **Live interaction:** prioritize common questions and acknowledge comments; route uncertain, sensitive, order-specific, or complaint-related questions to a human.
4. **Measure the whole funnel:** track watch time, meaningful comments, product clicks, add-to-cart, orders, cancellations, refunds, and cost per minute—not just view counts.
5. **Separate persona from content:** reuse a permitted avatar and scene; vary the script and approved gesture/emotion tags instead of generating a new video continuously.

## Proposed TRACER architecture

1. **Catalog eligibility (read-only):** obtain products from TRACER's canonical data. Only consider a product when supplier identity, variant identity, cost, Japan shipping cost, stock, sale status, and positive profit are verified. Missing/ambiguous/stale facts mean skip the product; do not guess.
2. **Product facts package:** prepare a versioned Japanese fact sheet and approved claims for each eligible item. Keep source values and last-verified time. No medical, safety, performance, scarcity, discount, review, or comparative claim unless evidence supports it.
3. **24-hour programming scheduler:** choose product/segment blocks based on time, audience behavior, stock freshness, and recent repetition. A sample cycle can include greeting, product benefit, demonstration, FAQ, comparison based on verified facts, and recap. Rotate rather than repeat the exact same line.
4. **Comment router:** classify messages into product FAQ, price/shipping, variant/stock, order-specific, complaint/returns, spam/abuse, and unknown. Answer only from verified facts. Unknown or account/order-specific topics get a concise handoff rather than hallucination.
5. **Speech generation:** compare Japanese voice providers (including ElevenLabs and Fish Audio) with the same test script. Cache reusable approved segments; use real-time TTS only for new responses. Emotion tags are optional performance cues, not guarantees.
6. **Avatar renderer:** begin with a reusable, licensed avatar and existing video/animation. Synchronize mouth movement to generated audio where supported. Defer continuous generative-video rendering until latency and cost are proven.
7. **Streaming adapter:** isolate the destination platform behind an adapter. Confirm its current rules, account eligibility, required AI-content disclosure, API/stream-key terms, and automation restrictions before enabling a real stream.
8. **Observability and stop controls:** record segment IDs, product IDs, source freshness, provider latency/cost, errors, and engagement metrics. Never log API keys or full sensitive customer messages. Add a visible operator stop/pause control and automatic pause for stale stock, provider failures, policy concerns, or repeated unsupported answers.

## Low-cost rollout

### Phase 0 — offline script evaluation
- Select 3–5 products with verified supplier/variant identity, price, Japan shipping, stock, and positive margin.
- Produce a 15-minute Japanese script rotation and a 10-question FAQ per item.
- Compare browser TTS, ElevenLabs, and Fish Audio using the same text and permitted voice.
- Measure Japanese pronunciation, emotional appropriateness, first-audio latency, total response latency, and actual credits consumed.
- Do not connect a live platform or change sales/catalog data.

### Phase 1 — 30–60 minute supervised dry run
- Use simulated comments first; then only a platform-authorized private/test stream if available.
- Keep the stream read-only with respect to orders, inventory, and listings.
- Test common questions, repeated comments, stock becoming unknown, speech provider timeout, and human handoff.
- Record a transcript and cost/latency report for review.

### Phase 2 — limited scheduled stream
- Enable only after platform policy and AI disclosure requirements are verified.
- Start with a short scheduled block and operator oversight, not unattended 24/7 operation.
- Add overnight coverage only after successful reliability, safety, and unit-economics checks.
- Expand hours based on measured incremental orders and margin, not vanity metrics.

### Phase 3 — 24/7 operations
- Use a queue of approved content blocks, health checks, restart/recovery, provider budgets, and on-call escalation.
- Rotate products based on current verified inventory and actual performance.
- Use a human for complaints, sensitive claims, refunds, and ambiguous questions.
- Maintain an auditable record of content and policy decisions.

## Safety and compliance gates

- **AI disclosure:** clearly disclose the host is AI-generated wherever required by applicable law/platform policy; do not make it appear to be a real person.
- **Platform rules:** do not assume a platform permits unattended or fully AI-generated streams. Some platforms restrict such broadcasts; verify the destination's current policy before activation.
- **Product truthfulness:** no fabricated reviews, sales numbers, scarcity, countdowns, endorsements, health benefits, or discounts. Never infer stock or shipping details.
- **Consumer support:** complaints and order-specific requests should be handed to an authorized human or authenticated support workflow.
- **Voice/avatar rights:** use assets and voice IDs owned by or licensed to the operator; obtain consent for voice cloning.
- **Cost controls:** explicit budget and duration caps for paid TTS/video calls; no automatic retries that can create unbounded charges.
- **Commerce isolation:** the livestream layer does not place supplier orders, update inventory, publish listings, or alter prices. Those remain in existing TRACER workflows.

## Initial success criteria

A supervised 30–60 minute run should demonstrate:
- No unsupported price, stock, shipping, or product claims.
- Correct answer or safe handoff for all test FAQ cases.
- No secret leakage and no commerce writes.
- Measured Japanese speech quality, p50/p95 response latency, provider errors, and total cost.
- A working operator pause/stop path.
- A written go/no-go decision before any unattended stream.

## Reference cases

- China Daily report on digital anchors covering livestreams 24 hours a day: https://www.ehangzhou.gov.cn/2023-11/16/c_287748.htm
- China Daily / national science and technology news portal on JD virtual livestreamers: https://en.ncsti.gov.cn/Latest/news/202406/t20240613_164005.html
- Meituan technical post on digital-human livestream architecture (2026): https://tech.meituan.com/2026/09/03/meituan-Digital-Human-practice.html
- China's livestream e-commerce management rules (effective 2026-02-01; includes AI-generated human-image/video disclosure): https://www.cac.gov.cn/2026-01/07/c_1769516655383334.htm
- Reuters report on platform differences and AI livestream restrictions (2026-09): https://www.reuters.com/business/retail-consumer/chinas-lipstick-king-confronts-slower-growth-ai-disruption-livestream-shopping-2026-09-24/

Reported Chinese case-study results should be treated as context, not a forecast for Japanese platforms or TRACER.
