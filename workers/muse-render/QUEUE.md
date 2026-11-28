# Muse motion render queue

Studio and chat submit one motion manifest to the same queue. One Colab worker claims and renders one job at a time. MuseTalk, when requested, runs inside that worker before FFmpeg.

## Setup

These steps are manual. Do not run them from an agent session, and do not print secret values.

### 1. Confirm the production migration and private bucket

The production Supabase project is the one in Vercel Production `NEXT_PUBLIC_SUPABASE_URL`. Do not assume the host written in `lib/config/env.ts` is that project.

From a shell that already has the production URL and service-role key in its environment, run:

```bash
node scripts/check-muse-production-readiness.mjs
```

The script prints only names that are missing, plus `migration`, `bucket`, and `bucketPrivate`. It does not print keys, does not insert a job, and does not create a bucket.

Read the result this way:

- `migration: "applied"` means `ai_live_muse_render_jobs` answered a one-row read.
- `migration: "absent"` means the table is not there. In the Supabase SQL editor for that same project, run `supabase/migrations/20261128110000_create_ai_live_muse_render_jobs.sql` once. Then run the check again.
- `bucket: "present"` and `bucketPrivate: "yes"` means the private bucket `tracer-muse-render` exists.
- `bucket: "absent"` means create that bucket in Storage with public access off. Do not make it public.
- `bucketPrivate: "no"` means the bucket exists but is public. Turn public access off before any worker runs.

### 2. Set Vercel Production environment names

In the Vercel project `tracer`, Production environment, these names must exist. Values stay in Vercel and Colab secrets. Do not commit them and do not paste them into a notebook cell.

Already expected on Production from the existing app: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TRACER_ADMIN_TOKEN`, `FISH_AUDIO_API_KEY`. Leave those values as they are.

Add only the missing worker secret:

```bash
vercel env add MUSE_RENDER_WORKER_TOKEN production
```

Generate a new random token locally, enter it at the prompt, and store the same token in a Colab secret named `MUSE_RENDER_WORKER_TOKEN`. Do not reuse `TRACER_ADMIN_TOKEN`. Adding the variable does nothing for the new routes until this branch is deployed. This document does not deploy it.

### 3. Colab Free T4 worker

Use one GPU runtime. Runtime type must be T4. Confirm with `nvidia-smi` that the GPU name is Tesla T4 and memory is about 15360 MiB. A CPU runtime cannot run MuseTalk. Do not start a second worker.

```bash
!apt-get -qq update
!apt-get -qq install -y ffmpeg fonts-noto-cjk
```

Copy `renderer.py`, `colab_worker.py`, and `musetalk_adapter.py` into the same working directory. Put the base URL and token in Colab Secrets, not in the notebook source:

```python
from google.colab import userdata
import os
os.environ["TRACER_BASE_URL"] = "https://tracer-pied-alpha.vercel.app"
os.environ["MUSE_RENDER_WORKER_TOKEN"] = userdata.get("MUSE_RENDER_WORKER_TOKEN")
```

After this branch is deployed, check authentication without taking a job:

```bash
!python colab_worker.py --check
```

`--check` posts `{"action":"status"}`. A matching token prints `Worker authentication: ok` and the queue name. It does not claim, render, or run MuseTalk. Until this branch is deployed, production returns 404 for that route, so `--check` cannot succeed there yet.

`--once` is different: it claims one real job if one is waiting. Use it only when a job should actually be rendered. The normal loop is `!python colab_worker.py`.

### 4. MuseTalk on the same T4 worker

MuseTalk 1.5 inference is a separate checkout, not part of this repository. The published upstream runtime is Python 3.10, an NVIDIA GPU, and the v1.5 weights under `models/musetalkV15/`. Upstream measured realtime speed on a V100 and also ran fp16 inference on a 4GB laptop GPU. Colab Free T4 has 16GB, which is the existing worker and is enough for inference. It is not a training GPU. Do not set up MuseTalk training.

Clone `https://github.com/TMElyralab/MuseTalk` into the Colab session, install its dependencies, and download its weights there. Then:

```python
os.environ["MUSE_TALK_ROOT"] = "/content/MuseTalk"
```

`--check` reports `MuseTalk ready: yes` only when the GPU, `scripts/inference.py`, `unet.pth`, and `musetalk.json` are all present. Ready does not mean inference ran.

A job runs MuseTalk only when its manifest contains `lipSync: { "engine": "musetalk" }`, a portrait such as `scene-1.png`, and `narration.mp3` or `voice-1.mp3`, and no `lipsync.mp4` was already uploaded. The adapter writes `lipsync.mp4` and the existing FFmpeg renderer strips that file's audio, then mixes the Fish dialogue and BGM once. If the checkout, weights, or GPU is missing, the job fails with `MuseTalk was not executed` and is not marked succeeded. Studio jobs that already upload a canvas `lipsync` file keep that file and do not call MuseTalk.

The bucket is private. The browser receives short-lived signed upload URLs; the worker receives short-lived signed read/upload URLs. No service-role key is sent to the browser or Colab. Keep one worker process running. It polls every five seconds, claims at most one job, and stops when the cell stops. Colab Free is not always-on and may disconnect.

## API protocol

### Enqueue

`POST /api/admin/ai-live/muse-render/jobs`

Bearer `TRACER_ADMIN_TOKEN`. The studio calls this after building a valid manifest and declares asset paths such as `voice-1.mp3` and `bgm.mp3`.

### Browser asset upload

`POST /api/admin/ai-live/muse-render/assets`

Bearer `TRACER_ADMIN_TOKEN`; body contains `jobId`, `fileName` (without extension), `contentType`, and byte `size`. Upload the raw bytes to the returned signed URL with HTTP POST.

### Worker

POST `/api/admin/ai-live/muse-render/worker` with Bearer `MUSE_RENDER_WORKER_TOKEN`.

- `{"action":"status"}`: checks the worker token and returns the queue name. It does not claim a job and does not touch storage.
- `{"action":"claim"}`: atomically claims the oldest job and returns its manifest, time-limited signed asset URLs, and a signed upload URL for `render.mp4`. Empty queue returns `job:null`. Use this only when a job should be taken.
- Render locally with `workers/muse-render/renderer.py`.
- Upload MP4 to the supplied signed upload URL using HTTP POST and `Content-Type: video/mp4`.
- `{"action":"complete","id":"...","leaseToken":"...","succeeded":true}` records success. For errors use `succeeded:false` and an error string.

The lease duration is 30 minutes. The Colab worker renews its lease every four minutes while rendering/uploading via the worker heartbeat action. Attempts are capped at five for jobs whose leases expire; a worker-reported failure is marked failed. If heartbeat renewal fails, the worker logs the loss of lease; completion is then rejected if the lease is no longer valid.

### Browser status and playback

`GET /api/admin/ai-live/muse-render/jobs?id=<job-id>` returns the job state. Once succeeded, the API creates a one-hour signed read URL for the private MP4. The studio polls this endpoint and displays the video player.

## Current limitations

The renderer builds H.264 scenes from text cards, still images, or a lip-sync MP4/WebM. Source audio inside a lip-sync or scene video is discarded. Fish dialogue (`voice-N.mp3` or one `narration.mp3`) and optional `bgm.mp3` are mixed once and trimmed to the manifest duration. Studio (`requestedBy: "muse-studio"`) and chat (`requestedBy: "muse-chat"`) both call `enqueueMuseRenderJob` and insert `ai_live_muse_render_jobs`. Chat status is `GET /api/chat/muse-video?id=`. The studio polls `GET /api/admin/ai-live/muse-render/jobs?id=`. A signed MP4 URL is returned only after status is `succeeded`.

Chat sets `lipSync.engine` to `musetalk` only for an explicit lip-sync request that has a portrait and voice and no uploaded lip-sync video. That flag is consumed by the same worker. MuseTalk inference has not been executed in this repository. No live Supabase migration, private-bucket check, Colab claim, Fish Audio render, or MuseTalk playback has been verified here.
