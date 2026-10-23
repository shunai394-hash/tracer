#!/usr/bin/env bash
# Place narration lines on the timeline, duck the BGM under the voice, and
# produce final_mix.wav (-14 LUFS). Run from this directory after tts.py/bgm.py.
#   ./mix.sh <narration_dir>   (expects jf_alpha_1..4.wav)
set -euo pipefail
N=${1:?narration dir}
python3 -I bgm.py bgm_raw.wav
ffmpeg -hide_banner -loglevel error -y -i bgm_raw.wav -af loudnorm=I=-18:TP=-1.5:LRA=7 -ar 48000 bgm.wav
ffmpeg -hide_banner -loglevel error -y \
  -i "$N/jf_alpha_1.wav" -i "$N/jf_alpha_2.wav" -i "$N/jf_alpha_3.wav" -i "$N/jf_alpha_4.wav" \
  -filter_complex "[0]adelay=250:all=1[a];[1]adelay=3650:all=1[b];[2]adelay=7650:all=1[c];[3]adelay=11600:all=1[d];[a][b][c][d]amix=inputs=4:normalize=0,aresample=48000,pan=stereo|c0=c0|c1=c0,highpass=f=80,equalizer=f=3500:t=q:w=1.2:g=2,acompressor=threshold=-20dB:ratio=3:attack=5:release=120,apad=whole_dur=15,atrim=0:15[v]" \
  -map "[v]" -ar 48000 narration_track.wav
ffmpeg -hide_banner -loglevel error -y -i narration_track.wav -af loudnorm=I=-16:TP=-2:LRA=7 -ar 48000 narration_norm.wav
ffmpeg -hide_banner -loglevel error -y -i bgm.wav -i narration_norm.wav -filter_complex \
  "[0]volume=-9dB[bg];[1]asplit=2[vo][sc];[bg][sc]sidechaincompress=threshold=0.02:ratio=6:attack=40:release=450:makeup=1[duck];[duck][vo]amix=inputs=2:normalize=0,alimiter=limit=0.89,loudnorm=I=-14:TP=-1.5:LRA=9,atrim=0:15" \
  -ar 48000 final_mix.wav
echo "final_mix.wav written"
