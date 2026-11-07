# AI Live BGM category rotation

## Current state

The BGM API lists private Storage MP3 objects and exposes their Storage metadata
field `genre`. The studio can upload tracks with a selected genre, preview one
track, and mix a selected BGM into the browser-side WAV export.

The archive manifest at `docs/ai-live-bgm-library-manifest.json` records the
17 supplied MP3s with measured byte sizes and SHA-256 checksums. Every entry is
marked `licenseStatus: unverified` and `productionEligible: false`.

## Implemented in the studio

- The current studio has one work-level genre selector. The operator can request a genre-matched BGM selection from that selector.
- Matching categories are 日常・ヒューマン → 日常・会話, 恋愛 → 恋愛, ミステリー / サスペンス → サスペンス, and コメディ → コメディ.
- If there is no matching track, BGM is cleared. The selector never substitutes a track from an unrelated category.
- Manual track selection remains available. Automatic selection avoids choosing the immediately previous auto-selected track when the category has multiple tracks.
- The BGM list is loaded on operator request or token entry; no polling is added.

## Next rotation increment: scene-level choices

The studio currently has a work-level genre selector, not a scene editor with per-scene audio lanes. When a scene model is introduced, extend the same matching rules per scene:

1. Normalize scene categories to the library genres:
   - 日常・ヒューマン → 日常・会話
   - 恋愛 → 恋愛
   - ミステリー / サスペンス → サスペンス
   - コメディ → コメディ
   - 感動 / 余韻 → 感動・余韻
   - アクション / 場面転換 → アクション・場面転換
2. Query the existing BGM library once per studio session; do not poll.
3. For each scene, choose only from tracks in the matching genre and avoid an immediate repeat when multiple tracks exist.
4. If a scene has no matching track, leave BGM off rather than choosing an unrelated category.
5. Keep manual selection available and let it override automatic category selection.
6. Apply BGM only during final mixdown; never regenerate dialogue when BGM changes.
7. Preserve a visible per-scene selection for operator review before export.

## Release gate

A track is eligible only after its license and intended commercial/live-stream
use have been verified and recorded. Until then, manifest entries remain
blocked, and the archive must not be bulk-uploaded to the production bucket.
A file's presence in the archive or a filename/category is not proof of rights.

## Operational constraints

- Reuse the existing private `tracer-drama-bgm` bucket and BGM API.
- Keep each upload below the existing 10 MiB limit.
- Do not introduce a cron, background poller, or Vercel long-running task.
- Keep live publishing separate from studio mixdown; this rotation is not an
  RTMP publisher and does not authorize a TikTok or YouTube broadcast.
