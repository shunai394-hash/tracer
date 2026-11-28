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
scene order; `bgm.mp3` is mixed at 18% volume. Missing audio is allowed.
The renderer does not fetch URLs, execute user code, or accept arbitrary
filesystem paths from the manifest. The queue adapter is responsible for
authorizing and downloading Supabase-hosted assets into the isolated job folder.

## Current limitations

The renderer produces 1920x1080 H.264 MP4 with animated text cards and audio
mixing. It does not yet render uploaded character footage, 3D scenes, lip-sync,
or per-scene image assets. The current browser manifest intentionally excludes
temporary audio URLs, so the queue/upload adapter must attach approved audio
assets before this worker can produce a fully voiced drama.
