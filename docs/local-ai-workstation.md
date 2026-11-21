# TRACER Local AI Workstation (Windows)

## Purpose

This is an optional, local-PC tool for the AI drama workflow:

- **Ollama**: private local text assistance for dialogue polishing, summaries, and script drafts.
- **OpenAI Whisper**: local speech recognition that exports Japanese SRT subtitles from existing audio/video.
- **Fish Audio remains the voice-generation provider.** This tool does not replace, call, or charge Fish Audio.

The helper is deliberately a command-line workstation tool for the first rollout. It does not expose a public HTTP server, add credentials to Vercel, connect to Supabase, publish media, or write to TRACER commerce data.

## 1. Install the local tools

1. Install Ollama from the official page: https://ollama.com/download
2. Open PowerShell and pull a model that fits the PC's RAM/VRAM. Example:

   ```powershell
   ollama pull qwen3:8b
   ollama list
   ```

   If the PC cannot comfortably run that model, choose a smaller Qwen model shown in the Ollama library and use its exact installed name in `OLLAMA_MODEL`.

3. Install FFmpeg using the official instructions: https://ffmpeg.org/download.html
4. Install Whisper:

   ```powershell
   py -m pip install -U openai-whisper
   py -m whisper --help
   ```

   Whisper requires FFmpeg. If `whisper.exe` is not on PATH, TRACER now falls back to `py -m whisper` automatically.

## 2. Configure the current PowerShell session

   ```powershell
   $env:OLLAMA_MODEL = "qwen3:8b"
   $env:WHISPER_MODEL = "small"
   $env:WHISPER_LANGUAGE = "Japanese"
   ```

No API key is required for local Ollama or Whisper execution. The Ollama helper only accepts loopback addresses (127.0.0.1, localhost, or ::1).

## 3. Run the preflight

From the TRACER repository root:

   ```powershell
   node scripts/local-ai-workstation.mjs status
   ```

Expected: Ollama is available and lists at least one installed model; Whisper reports installed. If either is unavailable, fix that local installation before continuing.

## 4. Use local Ollama for text assistance

   ```powershell
   node scripts/local-ai-workstation.mjs ask "第1話の台詞を自然な日本語に整えて。人物の性格と意味は変えず、短く話しやすくする。"
   ```

The response is printed to the terminal. Review it before copying anything into the drama project. It does not automatically overwrite project data.

## 5. Generate Japanese subtitles with Whisper

   ```powershell
   node scripts/local-ai-workstation.mjs transcribe "C:\\media\\episode1.mp4" "C:\\media\\episode1-subtitles"
   ```

Whisper writes an SRT file to the output folder. Check names, timing, and dialogue manually before using it in the final edit. Large models can take substantial time and memory; `small` is the default compromise.

## 6. Safety and cost boundaries

- Local inference uses the PC's CPU/GPU and electricity; it is not literally cost-free.
- Model downloads use network bandwidth and disk space.
- No video is uploaded by this helper.
- No Vercel deployment or new cloud service is required.
- No TTS endpoint is called. No Fish Audio charge can be triggered by these commands.
- Use only media you own or are authorized to process.
- This first milestone is intentionally CLI-only. A browser-to-local-workstation connection is not enabled; do not expose Ollama's port to the public internet.

## Related official references

- Ollama: https://github.com/ollama/ollama
- Whisper: https://github.com/openai/whisper
- FFmpeg: https://ffmpeg.org/download.html
