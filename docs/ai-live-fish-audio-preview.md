# Fish Audio manual voice preview

This adds a separate, admin-triggered Fish Audio TTS preview. The existing ElevenLabs route and preview remain unchanged.

## Vercel Production environment

Set these server-side variables:

- `FISH_AUDIO_API_KEY` — Fish Audio API key (Secret).
- `FISH_AUDIO_REFERENCE_ID` — ID returned after creating the authorized voice model in Fish Audio (Secret/Config; do not put it in browser code).
- `FISH_AUDIO_MODEL` — optional model header; defaults to `s2.1-pro-free`.

The API key is never sent to the browser. Do not paste it into chat, source control, logs, or client-side settings.

## Voice model setup

Create a private Fish Audio voice model using audio that the speaker or rights holder has authorized for voice cloning. Keep the model private. Use a clean, single-speaker Japanese recording and its matching transcript where the provider supports transcript input. Copy the returned model ID into `FISH_AUDIO_REFERENCE_ID`.

The model creation step is separate from TTS generation. This repository does not upload or train on a voice sample automatically.

## Manual preview

Open `/ai-live-fish-audio-preview.html` while signed into the admin environment, enter the TRACER admin token, and press Generate once. The route:

- requires TRACER admin-token or existing automation authentication;
- accepts only a text field up to 1,200 characters;
- has a 25-second provider timeout and a 12 MiB audio response limit;
- makes one provider request, with no automatic retry;
- does not log text, credentials, reference IDs, or audio;
- returns audio only; it does not publish, post, update listings, or trigger commerce actions.

If `FISH_AUDIO_REFERENCE_ID` is missing, the route returns a configuration error without contacting Fish Audio.

## Validation

`npm run test:ai-live-fish-audio-preview` checks the route and preview page contract. The normal `prebuild` runs this check before the production build. A successful build does not prove that the Fish Audio account can access the selected model; that requires one deliberate manual preview after the voice model is configured.
