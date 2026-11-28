# Muse motion render queue

This API is separate from the MuseTalk image+audio lip-sync queue. It accepts a validated motion manifest and Storage object paths, then leases one full-render job at a time to the Colab worker.

## Setup

1. Apply `supabase/migrations/20261128110000_create_ai_live_muse_render_jobs.sql`.
2. Create a private Supabase Storage bucket named `tracer-muse-render` (or apply the bucket statement in the migration if enabled in your environment).
3. Set `MUSE_RENDER_WORKER_TOKEN` in Vercel and Colab. Keep `SUPABASE_SERVICE_ROLE_KEY` server-side only.
4. The studio uploader must place assets under `<job-id>/` using the returned `uploadPaths`. Expected renderer filenames are `voice-1.mp3`, `voice-2.mp3`, etc. and optional `bgm.mp3`.

## Enqueue

`POST /api/admin/ai-live/muse-render/jobs`

Bearer `TRACER_ADMIN_TOKEN`

```json
{
  "requestedBy": "muse-01",
  "manifest": {
    "format": "muse-motion-manifest",
    "version": 1,
    "scenes": [
      { "title": "Scene 1", "text": "Opening line", "durationSeconds": 4, "motionPreset": "fade-up" }
    ]
  },
  "assetPaths": ["voice-1.mp3", "bgm.mp3"]
}
```

The API returns a job ID and object paths. Uploads must be completed before the Colab worker claims the job. The browser must use a separate signed-upload preparation flow; do not expose the service-role key.

## Worker protocol

POST `/api/admin/ai-live/muse-render/worker` with Bearer `MUSE_RENDER_WORKER_TOKEN`.

- `{"action":"claim"}`: atomically claims the oldest job, returns manifest, time-limited signed read URLs for its assets, and a signed upload URL/token for `render.mp4`. Empty queue returns `job:null`.
- Render locally with `workers/muse-render/renderer.py`.
- Upload MP4 to the supplied signed upload URL using the Supabase Storage signed-upload protocol.
- `{"action":"complete","id":"...","leaseToken":"...","succeeded":true}` records the result. For errors use `succeeded:false` and an error string.

The worker should process sequentially and claim again only after completing the current render. Lease duration is 30 minutes; attempts are capped at five. Colab Free can disconnect and is not always-on.

## Current integration boundary

This commit provides the DB queue and authenticated worker API only. It does not yet add the studio asset uploader, automatic enqueue button, Colab notebook loop, or finished-video player. Do not treat the system as end-to-end until those are connected and tested.
