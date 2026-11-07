# AI LIVE BGM Rights Ledger

## Purpose

Keep a verifiable rights record for every audio track used by TRACER AI LIVE. A track must not be treated as approved merely because it can be uploaded to Supabase Storage.

## Current implementation boundary

- The existing BGM endpoint stores MP3 files and a genre label in the private `tracer-drama-bgm` bucket.
- The current upload UI does **not** collect or validate copyright/license evidence.
- Therefore, uploads in the current system are technically stored, not rights-approved.
- Do not expose user-selectable or bundled BGM tracks to TRACER customers until the platform/secondary-user license is confirmed in writing where required.

## Required ledger fields

| Field | Required | Meaning |
|---|---:|---|
| `track_id` | Yes | Stable internal ID; never use a temporary signed URL |
| `storage_object` | Yes | Private Storage object name |
| `title` | Yes | Official track title |
| `composer` | Yes | Official composer/creator name |
| `source_url` | Yes | Canonical source/track page |
| `source_downloaded_at` | Yes | UTC timestamp of download |
| `license_name` | Yes | License or terms name/version |
| `license_url` | Yes | Canonical license URL |
| `license_checked_at` | Yes | UTC timestamp of review |
| `license_scope` | Yes | Personal stream / company stream / embedded platform / end-user secondary use |
| `commercial_use_allowed` | Yes | Boolean backed by source evidence |
| `platform_use_allowed` | Yes | Boolean for YouTube/TikTok/other destination |
| `redistribution_allowed` | Yes | Boolean; normally false unless explicitly authorized |
| `end_user_use_allowed` | Yes | Boolean for TRACER customer use; false until explicitly licensed |
| `attribution_required` | Yes | Boolean |
| `attribution_text` | Conditional | Exact required attribution |
| `creator_terms_url` | No | Track-specific terms if separate |
| `evidence_note` | Yes | Short explanation and any restrictions |
| `review_status` | Yes | `pending`, `approved_internal`, `approved_platform_users`, `rejected` |
| `reviewed_by` | Yes | Account or operator identifier |
| `reviewed_at` | Yes | UTC timestamp |
| `genre` | Yes | daily / romance / emotional / suspense / comedy / action |

## Approval rules

1. Default every new upload to `pending`.
2. A personal YouTube/TikTok background-music permission does not automatically grant permission to embed the track in TRACER and sublicense it to TRACER users.
3. Set `approved_internal` only when the documented license covers the operator's own intended stream and each destination.
4. Set `approved_platform_users` only when the rights holder/administrator has explicitly confirmed the platform embedding and end-user secondary-use scope, or another license clearly grants it.
5. If redistribution, user extraction, or secondary-use rights are unclear, keep the track unavailable for customer selection.
6. Never infer rights from the words "free", "royalty-free", or from successful upload.
7. Preserve evidence URLs and timestamps so that license changes can be rechecked.

## OpenTracks (旧DOVA-SYNDROME) specific note

Its published terms allow background-music use in YouTube/TikTok and live-stream content within the license scope. However, embedding tracks into a tool/platform and licensing them to end users who create and publish content requires prior consultation with the service operator. Redistribution and making the raw audio readily accessible to end users are prohibited under the standard terms. See:

- https://opentracks.com/help/articles/license-usage/
- https://opentracks.com/help/articles/license-prohibitions/
- https://opentracks.com/help/articles/license/

Accordingly, an OpenTracks track may be considered for an internally operated stream only after checking the track-specific conditions. It must not be marked `approved_platform_users` without the required written permission.

## Acceptance criteria for the future admin UI/API

- Upload form collects source, official title, composer, license URL, scope and attribution.
- API persists the ledger record independently from the audio object's display name.
- Listing endpoint returns rights status and evidence fields, but never returns raw credentials.
- Admin UI visibly distinguishes pending, internal-only approval and platform-user approval.
- OBS/product-facing selection excludes pending/rejected tracks; internal-only tracks are available only to authorized internal workflows.
- Deleting an audio object does not silently erase the audit record.
- Tests cover default-pending behavior, denied end-user scope, and fail-closed selection.
