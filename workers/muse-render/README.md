# Muse FFmpeg render worker (prototype)

This is the first real MP4 renderer for the Muse motion-manifest format. It runs
outside Vercel (Colab T4 or a dedicated worker) and renders jobs sequentially.

## Requirements

- Python 3.10+
- FFmpeg with `libx264`, AAC, concat demuxer, drawtext and Noto CJK font
- A job directory containing a validated manifest and local media assets

## Run

```bash
python workers/muse-render/renderer.py \
  --manifest /workspace/job/manifest.json \
  --assets-dir /workspace/job/assets \
  --output /workspace/job/output.mp4 \
  --font /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc
```

Optional local audio files are named `voice-1.mp3`, `voice-2.mp3`, ... in
scene order; `bgm.mp3` is mixed at 18% volume. Optional scene images are named
`scene-1.png`, `scene-2.jpg`, etc. and referenced by `imageFile: "scene-1"` in
the matching manifest scene. Images are center-cropped to 16:9 behind the
animated text. Missing audio is allowed; a declared-but-missing image fails the job.
The renderer does not fetch URLs, execute user code, or accept arbitrary
filesystem paths from the manifest. The queue adapter is responsible for
authorizing and downloading Supabase-hosted assets into the isolated job folder.

## Current limitations

The renderer produces an H.264 MP4 with animated text cards, optional
per-scene still images, and one mixed audio track. It does not itself run
MuseTalk. `musetalk_adapter.py` can create `lipsync.mp4` on a Colab GPU before
this renderer starts, and only when the job asks for it and the upstream
checkout is already installed. That inference has not been executed here.
