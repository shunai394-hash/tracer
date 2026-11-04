# TRACER Fish Audio Japanese voice picker

This admin-only preview now lets an operator select a Japanese female voice from Fish Audio's public voice library before generating a short MP3. The existing ElevenLabs route and preview remain unchanged.

## Production environment

Set the server-side variable:

- `FISH_AUDIO_API_KEY` — Fish Audio API key (Secret).

The API key is never sent to the browser. The preview no longer requires a fixed `FISH_AUDIO_REFERENCE_ID`; the operator selects a voice at runtime.

## Voice selection

Open `/ai-live-fish-audio-preview.html`, enter the TRACER admin token, and press **許諾済み日本語ボイスを読み込む**. The server queries Fish Audio's public model library with Japanese-language and licensed-only filters. The returned candidates are further restricted to public models whose language metadata includes Japanese and whose title, description, or tags explicitly indicate a female voice.

Only the selected model ID and display metadata are returned to the browser. Before TTS, the server independently reloads the licensed Japanese list and rejects any ID not present in that list. Voice-list loading does not generate audio. The operator must press Generate for one TTS request.

## Safety and limits

- Admin-token or existing automation authentication is required for both voice listing and generation.
- The API key stays server-side; no credentials or audio are logged.
- Text is limited to 1,200 characters, audio to 12 MiB, and the TTS request times out after 25 seconds.
- No automatic generation, retries, public posting, or commerce writes occur.
- The library query uses Fish Audio's licensed-only filter; voice results are additionally checked for public visibility and Japanese language metadata.
- Availability and licensing status are provider-controlled and can change. Confirm the voice's current usage terms in Fish Audio before commercial use.
- This picker selects an existing licensed public voice; it does not clone a person's voice or create a custom model.

## Validation

`npm run test:ai-live-fish-audio-preview` checks authentication, the licensed Japanese voice filter, server-side credential handling, explicit voice selection, and one-shot generation. A successful build does not prove the Fish Audio account has API access; one deliberate admin preview is still required.
