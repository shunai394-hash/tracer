# Muse motion render queue

This full MP4 render queue is separate from the MuseTalk image+audio lip-sync queue. The studio submits a motion manifest and approved audio assets; one Colab worker claims and renders one job at a time.

## Setup

1. Apply `supabase/migrations/20261128110000_create_ai_live_muse_render_jobs.sql`.
2. Create a **private** Supabase Storage bucket named `tracer-muse-render`.
3. Set `MUSE_RENDER_WORKER_TOKEN` in Vercel and Colab. Keep `SUPABASE_SERVICE_ROLE_KEY` server-side only.
4. Ensure the deployed Vercel environment has the same `TRACER_ADMIN_TOKEN` used by the studio.
5. The browser uploader creates a job, uploads generated narration as `voice-{scene-number}.mp3`, and optional selected BGM as `bgm.mp3`.

The bucket is private. The browser receives short-lived signed upload URLs; the worker receives short-lived signed read/upload URLs. No service-role key is sent to the browser or Colab.

## Colab Free worker

In a Colab notebook, install the runtime dependencies:

```bash
!apt-get -qq update
!apt-get -qq install -y ffmpeg fonts-noto-cjk
```

Copy `renderer.py` and `colab_worker.py` from this directory into the notebook working directory, then start one sequential worker:

```bash
import os
os.environ["TRACER_BASE_URL"] = "https://tracer-pied-alpha.vercel.app"
os.environ["MUSE_RENDER_WORKER_TOKEN"] = "YOUR_WORKER_TOKEN"
!python colab_worker.py
```

Keep only one worker process running for the shared queue. It polls every five seconds, claims at most one job, downloads its assets, renders with FFmpeg, uploads the MP4, and reports completion before claiming another job. Stop the cell to stop polling. Colab Free is not always-on and may disconnect.

For a one-job smoke test, append `--once` to the command.

## API protocol

### Enqueue

`POST /api/admin/ai-live/muse-render/jobs`

Bearer `TRACER_ADMIN_TOKEN`. The studio calls this after building a valid manifest and declares asset paths such as `voice-1.mp3` and `bgm.mp3`.

### Browser asset upload

`POST /api/admin/ai-live/muse-render/assets`

Bearer `TRACER_ADMIN_TOKEN`; body contains `jobId`, `fileName` (without extension), `contentType`, and byte `size`. Upload the raw bytes to the returned signed URL with HTTP POST.

### Worker

POST `/api/admin/ai-live/muse-render/worker` with Bearer `MUSE_RENDER_WORKER_TOKEN`.

- `{"action":"claim"}`: atomically claims the oldest job and returns its manifest, time-limited signed asset URLs, and a signed upload URL for `render.mp4`. Empty queue returns `job:null`.
- Render locally with `workers/muse-render/renderer.py`.
- Upload MP4 to the supplied signed upload URL using HTTP POST and `Content-Type: video/mp4`.
- `{"action":"complete","id":"...","leaseToken":"...","succeeded":true}` records success. For errors use `succeeded:false` and an error string.

The lease duration is 30 minutes. The Colab worker renews its lease every four minutes while rendering/uploading via the worker heartbeat action. Attempts are capped at five for jobs whose leases expire; a worker-reported failure is marked failed. If heartbeat renewal fails, the worker logs the loss of lease; completion is then rejected if the lease is no longer valid.

### Browser status and playback

`GET /api/admin/ai-live/muse-render/jobs?id=<job-id>` returns the job state. Once succeeded, the API creates a one-hour signed read URL for the private MP4. The studio polls this endpoint and displays the video player.

## Current limitations

The renderer builds H.264 scenes from text cards, still images, or a lip-sync MP4/WebM. Source audio inside a lip-sync or scene video is discarded. Fish dialogue (`voice-N.mp3` or one `narration.mp3`) and optional `bgm.mp3` are mixed once and trimmed to the manifest duration. Studio and chat both insert `ai_live_muse_render_jobs`; chat status is `GET /api/chat/muse-video?id=`. A signed MP4 URL is returned only after status is `succeeded`.

No live Supabase migration, Colab execution, or end-to-end MP4 playback has been verified in this change. Do not treat the feature as production-validated until those checks pass.
