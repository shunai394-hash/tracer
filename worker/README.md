# TRACER AI Live worker and media renderer

The isolated worker includes:
- An authenticated, fake-only stream lifecycle API with bounded runtime and simulated product rotation.
- A local FFmpeg media renderer that combines a still-image slate, one TTS voice file, and optional looped BGM into an MP4.

## Local media render

Place licensed assets under a dedicated media root. The renderer accepts only local files under that root; it rejects URLs, traversal, symlinks that escape the root, unsupported extensions, and oversized files.

\`\`\`js
import { renderAiLiveSegment } from "./worker/ffmpeg-media.mjs";

await renderAiLiveSegment({
  mediaRoot: "/srv/tracer-media",
  imagePath: "slates/ai-live.png",
  voicePath: "tts/segment-001.wav",
  bgmPath: "bgm/track-01.mp3",
  outputPath: "renders/segment-001.mp4",
  bgmVolume: 0.16,
  maxDurationSeconds: 600,
});
\`\`\`

The output is a local MP4 only. FFmpeg is launched with an argument array and \`shell:false\`; input protocols are restricted to \`file,pipe\`. No RTMP, RTMPS, YouTube, or TikTok destination is opened by this renderer.

## Worker control API

Run locally with a random bearer token of at least 32 characters:

\`\`\`sh
AI_LIVE_WORKER_TOKEN='replace-with-a-random-secret-at-least-32-characters' \
AI_LIVE_WORKER_MODE=fake node worker/ai-live-worker.mjs
\`\`\`

- \`GET /healthz\` — process liveness
- \`GET /readyz\` — readiness and publishing-disabled state
- \`POST /v1/streams\` — create an idempotent, bounded simulated stream
- \`GET /v1/streams/:streamId\` — read state and current simulated segment
- \`POST /v1/streams/:streamId/stop\` — stop a simulated stream

Jobs accept logical \`youtube_live\` or \`tiktok_live\` destination IDs and an opaque secret reference, never an RTMP URL or stream key. Product facts older than 15 minutes are rejected. Maximum runtime is 30 minutes. Segment rotation is simulated; it does not switch a real broadcast.

## Container

Build from the repository root:

\`\`\`sh
docker build -f worker/Dockerfile -t tracer-ai-live-worker .
\`\`\`

The image includes FFmpeg and runs as the unprivileged \`node\` user. Set
\`AI_LIVE_WORKER_TOKEN\` through a deployment secret manager.

## Explicitly not enabled

- Real RTMP/RTMPS publishing or platform authentication
- TikTok LIVE account eligibility verification
- YouTube Live API integration
- Live comment ingestion/replies
- Persistent stream registry, reconnect supervisor, and deployment
- 24/7 or unattended broadcasting

The worker defaults to \`fake\` mode and refuses other modes. Local MP4 rendering does not mean a broadcast can be started.
