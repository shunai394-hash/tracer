import { existsSync } from "node:fs";
import { join } from "node:path";

const candidates = [
  join(process.env.ProgramFiles || "C:\\Program Files", "obs-studio", "bin", "64bit", "obs64.exe"),
  join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "obs-studio", "bin", "64bit", "obs64.exe"),
  join(process.env.LOCALAPPDATA || "", "Programs", "obs-studio", "bin", "64bit", "obs64.exe"),
].filter(Boolean);

const installed = candidates.find((path) => existsSync(path)) || null;
console.log(JSON.stringify({
  obsStudioLaunched: false,
  obsStudioInstalled: Boolean(installed),
  obsStudioPath: installed,
  videoInObs: "未確認",
  audioInObs: "未確認",
  duckingInObs: "未確認",
  note: installed
    ? "OBS Studio is installed. This check does not launch it and does not start a broadcast."
    : "OBS Studio was not found. FFmpeg loopback receive is not OBS playback.",
}));
