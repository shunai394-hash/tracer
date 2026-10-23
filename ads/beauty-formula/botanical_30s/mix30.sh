#!/usr/bin/env bash
# Narration (Kokoro jf_alpha, lines na/l01..l10.wav at 1.12x) over the upbeat BGM with ducking.
#   ./mix30.sh <na_dir> <bgm_raw.wav> <out_mix.wav>
set -euo pipefail
NA=$1 BGM=$2 OUT=$3
# start times (ms) aligned to the cuts in edit30.py
STARTS=(200 2700 5500 9100 11550 15150 19050 21600 24800 27700)
IN=() FC=""
for i in $(seq 1 10); do
  IN+=(-i "$NA/l$(printf %02d $i).wav")
  FC+="[$((i-1))]atempo=1.12,adelay=${STARTS[$((i-1))]}:all=1[n$i];"
done
for i in $(seq 1 10); do FC+="[n$i]"; done
FC+="amix=inputs=10:normalize=0,aresample=48000,pan=stereo|c0=c0|c1=c0,highpass=f=80,equalizer=f=3500:t=q:w=1.2:g=2,acompressor=threshold=-20dB:ratio=3:attack=5:release=120,apad=whole_dur=30,atrim=0:30[v]"
ffmpeg -hide_banner -loglevel error -y "${IN[@]}" -filter_complex "$FC" -map "[v]" -ar 48000 narration_track.wav
ffmpeg -hide_banner -loglevel error -y -i narration_track.wav -af loudnorm=I=-16:TP=-2:LRA=7 -ar 48000 narration_norm.wav
ffmpeg -hide_banner -loglevel error -y -i "$BGM" -af loudnorm=I=-18:TP=-1.5:LRA=7 -ar 48000 bgm_norm.wav
ffmpeg -hide_banner -loglevel error -y -i bgm_norm.wav -i narration_norm.wav -filter_complex \
  "[0]volume=-8dB[bg];[1]asplit=2[vo][sc];[bg][sc]sidechaincompress=threshold=0.02:ratio=5:attack=30:release=350:makeup=1[duck];[duck][vo]amix=inputs=2:normalize=0,alimiter=limit=0.89,loudnorm=I=-14:TP=-1.5:LRA=9,atrim=0:30" \
  -ar 48000 "$OUT"
echo "mix written: $OUT"
