# Muse Motion Studio integration plan

## Goal

Extend the existing TRACER short-drama studio without replacing its voice registry, drama cast registry, Fish Audio generation, BGM library, or lip-sync workflow. The target is a staged authoring pipeline: script and cast -> storyboard -> motion/3D scenes -> voice and BGM timing -> subtitles -> final MP4.

This document is an implementation plan, not a claim that the listed projects have already been installed or tested in TRACER.

## Existing TRACER baseline

The current `public/ai-live-short-drama-studio.html` is a plain HTML/JavaScript admin studio. It already contains voice selection/registration, drama-level cast persistence, Fish Audio speech generation, BGM library UI, and a simple mouth-overlay lip-sync path (`public/tracer-lip-sync.js`). The simple overlay is not equivalent to MuseTalk or a 3D facial rig.

The shared MuseTalk queue is being developed separately in PR #2336. Do not couple the motion-rendering queue to that PR until its API is reviewed and merged.

## Tool selection matrix

| Tool | Proposed role | Decision | Important constraint |
|---|---|---|---|
| GSAP | 2D timeline, typography, transitions, SVG motion | Phase 1 candidate | Verify current license terms for the intended product; pin version |
| Motion (motion.dev) | Spring/layout motion in React-facing UI | Optional UI layer | MIT; avoid adding if the existing plain HTML studio does not need it |
| Remotion | Programmatic final video composition | Phase 2 candidate | License is not OSI open source; free tier is limited by eligibility; automated video product/rendering service may need a paid license |
| FFmpeg | Final mux/transcode/audio mix | Phase 1/2 core | Package binaries and deployment/runtime licensing must be reviewed |
| librosa | Beat/onset/tempo analysis | Phase 1 candidate | Python worker dependency; keep out of browser bundle |
| WhisperX | Word-level speech alignment/subtitles | Phase 1 candidate | Japanese is listed in upstream examples; model/runtime dependencies need GPU/CPU test |
| Three.js | Browser 3D preview and camera scene | Phase 3 candidate | Keep preview optional; do not load into every studio screen |
| Blender | Offline 3D asset and animation rendering | Phase 3 candidate | Separate worker/runtime, not a browser dependency |
| react-three-rapier | Rigid-body physics for Three.js/React | Phase 3 conditional | Requires React Three Fiber scene architecture |
| react-postprocessing | Three.js post effects | Phase 3 conditional | Only if scene quality requires it |
| three.quarks | Three.js particle effects | Phase 3 conditional | Validate compatibility with selected Three.js version |
| Tweakpane | Runtime scene controls | Phase 3 candidate | Editor-only; exclude from final render bundle |
| Lottie | Lightweight vector animation playback | Phase 2 candidate | Use for authored vector assets, not as a general video renderer |
| hairline | SVG line-art animation | Optional effect | Verify exact upstream package, API, and license before adding |
| anatomy | Mechanical/product cutaway | Optional specialist tool | Verify upstream repository and output format before adoption |
| anatomy-reveal | Product exploded-view animation | Optional specialist tool | Verify repository, dependencies, and commercial license |
| motion-design-skill | AI motion-design instructions | Prompt/skill candidate | Instructions, not a rendering engine; inspect skill contents and license |
| Remotion Skills | AI authoring instructions | Prompt/skill candidate | Instructions, not a rendering engine; inspect skill contents and license |
| Openverse API | Search openly licensed audio | Phase 2 candidate | Verify each asset's license and attribution; API metadata is not a rights guarantee |

## Phased delivery

### Phase 1 — 2D motion and audio timing (smallest useful release)
1. Add a scene/timeline data model to the studio: scene duration, asset references, transition, motion preset, audio cue, subtitle cue.
2. Add GSAP only to a dedicated preview/editor module, not globally to every TRACER page.
3. Add a Python audio-analysis worker using librosa to return beat/onset timestamps as JSON.
4. Add WhisperX subtitle alignment as an optional worker task; explicitly test Japanese with actual Fish Audio output.
5. Export a deterministic render manifest. Keep FFmpeg as the final mux stage only after manifest validation.

Acceptance criteria:
- Existing voice registration, drama cast save/load, audio generation, and BGM library regression tests remain green.
- A 15-second sample scene renders repeatably with fixed input assets.
- Beat markers and subtitle timestamps can be inspected and corrected before export.
- No Vercel cron or always-on GPU service is introduced.

### Phase 2 — Remotion render pipeline
1. Build a separate render worker/container; do not install the full Remotion stack into the admin page.
2. Generate compositions from validated scene manifests.
3. Confirm Remotion license eligibility for TRACER's actual legal entity and whether end-user generated videos constitute an automated video product/rendering service.
4. Render one 1080p sample and compare runtime, memory, output quality, and per-render cost.

Acceptance criteria:
- Same manifest produces deterministic duration, scene order, audio alignment, and subtitle placement.
- Failed render is resumable and does not lose the source job.
- No automatic publishing occurs.

### Phase 3 — 3D studio
1. Prototype one Three.js scene with camera and lighting.
2. Add Tweakpane controls only in editor mode.
3. Add Three.js physics/postprocessing/particles only when a concrete scene requires them.
4. Keep Blender as a separate offline render/asset pipeline.
5. Add anatomy/exploded-view tools only for product explainer scenes after their repositories and licenses are verified.

Acceptance criteria:
- 3D is opt-in per scene and does not increase initial load for ordinary drama editing.
- GPU workloads are queued, not launched concurrently by nine browser sessions.

## Architecture and cost guardrails

- Browser: editing controls, 2D preview, upload and job submission only.
- TRACER API/Supabase: durable scene manifests, assets metadata, job state, and output references.
- Worker: Python audio analysis / WhisperX / MuseTalk / Blender as separate task types.
- Render worker: Remotion + FFmpeg, sequential GPU/CPU concurrency limits.
- Store media in private object storage; do not store media blobs in Postgres.
- No new frequent Vercel cron. Start workers manually or run only while there are jobs.
- Nine Muse browser sessions are clients of one queue, not nine independent render machines.

## License and verification gates

Before adding a dependency:
1. Confirm canonical upstream repository and exact package/release.
2. Read the current license file and commercial-use terms.
3. Check runtime compatibility with TRACER's Node/Python versions.
4. Add pinned dependency and minimal isolated proof.
5. Run focused tests and build before studio integration.

## Sources checked on 2026-11-28

- Remotion license/pricing: https://www.remotion.dev/docs/license/pricing
- Remotion license terms: https://github.com/remotion-dev/remotion/blob/main/LICENSE.md
- GSAP installation: https://gsap.com/docs/v3/Installation/
- Motion vs GSAP: https://motion.dev/docs/gsap-vs-motion
- WhisperX Japanese example: https://github.com/m-bain/whisperX/blob/main/EXAMPLES.md
- Openverse API notes: https://docs.openverse.org/api/reference/made_with_ov.html
- Openverse terms: https://docs.openverse.org/terms_of_service

These sources support the specific notes above; they do not prove that all twenty projects are already compatible with TRACER or each other.
