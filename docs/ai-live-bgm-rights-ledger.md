# AI LIVE BGM Rights Ledger

## Purpose

Keep a verifiable rights record for every audio track used by TRACER AI LIVE. A track must not be treated as approved merely because it can be uploaded to Supabase Storage.

## Current implementation boundary

- Audio files are stored in the private `tracer-drama-bgm` bucket.
- The rights ledger is stored separately in `public.ai_live_bgm_rights`.
- New ledger records default to `pending`; upload success is not rights approval.
- The table is protected by RLS and grants access only to `service_role`; browser clients must use the authenticated server API.

## Required fields and approval states

The database stores title, composer, source and license URLs, license review timestamp, use scope, commercial/platform permissions, redistribution and end-user permissions, attribution, evidence notes, genre, reviewer and review timestamp.

Allowed review states:

- `pending`: uploaded or registered, not approved for playback.
- `approved_internal`: approved for the operator's own stream only. Requires commercial and platform permission and `internal_stream` scope.
- `approved_platform_users`: approved for TRACER end-user use. Requires explicit end-user permission and an embedded-platform or end-user-secondary-use scope.
- `rejected`: not permitted for playback.

The database constraints fail closed: approvals cannot be recorded without the relevant permissions and review metadata. Do not grant customer access to `approved_internal` tracks.

## OpenTracks (旧DOVA-SYNDROME) specific note

OpenTracks permits background use in YouTube/TikTok and live content under its license, but explicitly says embedding tracks in tool apps/platforms and licensing them to end users who create and distribute content requires prior consultation. It also prohibits redistribution of the audio files and making raw audio readily accessible to end users. Thus, ordinary background-use permission is not sufficient for a TRACER user-selectable BGM library.

Official terms:
- https://opentracks.com/help/articles/license-usage/
- https://opentracks.com/help/articles/license/

## Migration

Apply `supabase/migrations/20261108090000_ai_live_bgm_rights_ledger.sql` before deploying code that writes ledger records. The migration is additive; it does not change or delete existing audio objects. Existing uploaded files have no ledger record and must be treated as unreviewed until manually registered.

## Next integration requirements

- Upload form collects the required rights evidence and metadata.
- API creates the audio object and a `pending` ledger row; if ledger insertion fails, remove the just-uploaded object or report a clearly recoverable orphan.
- GET endpoint returns only approved tracks for playback; admin listing may show all statuses.
- Internal OBS playback may use `approved_internal`; customer-facing playback must require `approved_platform_users`.
- Never expose raw credentials or allow browser access to the private bucket.
- Keep ledger rows when audio objects are deleted; record deletion/tombstone state rather than erasing audit history.
- Tests cover default-pending behavior, approval constraints, and fail-closed playback selection.
