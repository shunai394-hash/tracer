#!/usr/bin/env bash
# Narration (Kokoro jf_alpha lines na/l01..l09.wav, played at 1.12x) over the BGM with ducking.
#   ./mix_active.sh <30|15> <na_dir> <bgm_raw.wav> <out_mix.wav>
set -euo pipefail
VER=$1 NA=$2 BGM=$3 OUT=$4
if [ "$VER" = "30" ]; then
  DUR=30
  LINES=(1 2 3 4 5 6 7 8 9)
  STARTS=(250 3200 6500 9500 12700 15900 19300 23300 26300)   # ms, aligned to CAPS in edit_active.py
else
  DUR=15
  LINES=(1 4 5 6 8 9)
  STARTS=(200 3000 6000 8900 11700 13800)
fi
N=${#LINES[@]}
IN=() FC=""
for i in $(seq 0 $((N-1))); do
  IN+=(-i "$NA/l$(printf %02d ${LINES[$i]}).wav")
  FC+="[$i]atempo=1.12,adelay=${STARTS[$i]}:all=1[n$i];"
done
for i in $(seq 0 $((N-1))); do FC+="[n$i]"; done
FC+="amix=inputs=$N:normalize=0,aresample=48000,pan=stereo|c0=c0|c1=c0,highpass=f=80,equalizer=f=3500:t=q:w=1.2:g=2,acompressor=threshold=-20dB:ratio=3:attack=5:release=120,apad=whole_dur=$DUR,atrim=0:$DUR[v]"
ffmpeg -hide_banner -loglevel error -y "${IN[@]}" -filter_complex "$FC" -map "[v]" -ar 48000 narration_track_$VER.wav
ffmpeg -hide_banner -loglevel error -y -i narration_track_$VER.wav -af loudnorm=I=-16:TP=-2:LRA=7 -ar 48000 narration_norm_$VER.wav
# BGM: trim to length with a 1.2s fade out so the end card resolves cleanly.
ffmpeg -hide_banner -loglevel error -y -i "$BGM" -af "atrim=0:$DUR,afade=t=out:st=$((DUR-2)).8:d=1.2,loudnorm=I=-18:TP=-1.5:LRA=7" -ar 48000 bgm_norm_$VER.wav
ffmpeg -hide_banner -loglevel error -y -i bgm_norm_$VER.wav -i narration_norm_$VER.wav -filter_complex \
  "[0]volume=-9dB[bg];[1]asplit=2[vo][sc];[bg][sc]sidechaincompress=threshold=0.02:ratio=5:attack=30:release=350:makeup=1[duck];[duck][vo]amix=inputs=2:normalize=0,alimiter=limit=0.89,loudnorm=I=-14:TP=-1.5:LRA=9,atrim=0:$DUR" \
  -ar 48000 "$OUT"
echo "mix written: $OUT"
