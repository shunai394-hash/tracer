# Shared MuseTalk worker (Colab)

This is the shared queue foundation for the nine Chrome/Muse sessions. The nine sessions submit jobs to TRACER; one Colab T4 worker claims and processes jobs sequentially.

## Required Vercel environment variables

- `MUSETALK_WORKER_TOKEN`: a new, randomly generated secret used only by the Colab worker. Do not reuse `TRACER_ADMIN_TOKEN`.
- Existing `TRACER_ADMIN_TOKEN`, `NEXT_PUBLIC_SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` remain server-side. Never expose the Supabase service-role key to a browser.

## Database

Apply `supabase/migrations/20261128090000_create_ai_live_musetalk_jobs.sql` before using the API.

## API

All requests use HTTPS.

### Submit a job (admin session)

`POST /api/admin/ai-live/musetalk/jobs`

Authorization: `Bearer <TRACER_ADMIN_TOKEN>`

```json
{
  "imageUrl": "https://<project>.supabase.co/storage/v1/object/public/<bucket>/<image>",
  "audioUrl": "https://<project>.supabase.co/storage/v1/object/public/<bucket>/<audio>",
  "requestedBy": "muse-01"
}
```

The image and audio must already be in Supabase Storage. Only HTTPS Supabase Storage URLs are accepted. The response contains a job ID.

### Read recent jobs

`GET /api/admin/ai-live/musetalk/jobs`

Optional: `?id=<job-uuid>`

### Colab worker

`POST /api/admin/ai-live/musetalk/worker`

Authorization: `Bearer <MUSETALK_WORKER_TOKEN>`

Claim the oldest queued job:

```json
{ "action": "claim" }
```

A successful claim returns `id`, `leaseToken`, `imageUrl`, `audioUrl`, and attempt number. An empty queue returns `job: null`.

After MuseTalk inference, upload the MP4 to Supabase Storage and complete the job:

```json
{
  "action": "complete",
  "id": "<job-uuid>",
  "leaseToken": "<lease-token>",
  "succeeded": true,
  "outputUrl": "https://<project>.supabase.co/storage/v1/object/public/<bucket>/<result>.mp4"
}
```

For a failed inference, send `succeeded: false` and an `error` string. The lease token prevents a stale worker from completing a job that has been reclaimed.

## Operational constraints

- One Colab worker should poll and process one job at a time. Do not run nine inference loops.
- A processing lease expires after 30 minutes; a later claim can recover abandoned work.
- Colab Free is not an always-on service. Start the notebook manually and expect disconnects.
- This PR creates the durable queue and authenticated worker API. It does not yet install MuseTalk into Colab, upload source assets from the studio, or wire a finished-video player into the studio. Those are the next integration steps; do not treat the queue API alone as a completed end-to-end workflow.
