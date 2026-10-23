import sys, subprocess, numpy as np, sherpa_onnx
d = sys.argv[1]; mp4 = sys.argv[2]
rec = sherpa_onnx.OfflineRecognizer.from_transducer(
    encoder=f"{d}/encoder-epoch-99-avg-1.int8.onnx", decoder=f"{d}/decoder-epoch-99-avg-1.onnx",
    joiner=f"{d}/joiner-epoch-99-avg-1.int8.onnx", tokens=f"{d}/tokens.txt", num_threads=4)
pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", mp4, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
                     capture_output=True, check=True).stdout
a = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768
for name, s, e in [("0-3s", 0.0, 3.4), ("3-7s", 3.4, 7.4), ("7-11s", 7.4, 11.4), ("11-15s", 11.4, 15.0)]:
    st = rec.create_stream(); st.accept_waveform(16000, a[int(s*16000):int(e*16000)])
    rec.decode_stream(st); print(name, "->", st.result.text)
