import { spawn as nodeSpawn } from "node:child_process";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
export function validateLocalRtmpUrl(value) {
  if (typeof value !== "string" || value.length > 512) throw new Error("ai_live_local_rtmp_url_invalid");
  let url;
  try { url = new URL(value); } catch { throw new Error("ai_live_local_rtmp_url_invalid"); }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const ipv4Loopback = /^127(?:\.\d{1,3}){3}$/.test(host) && host.split(".").slice(1).every((part) => Number(part) <= 255);
  if (url.protocol !== "rtmp:" || (!LOOPBACK_HOSTS.has(host) && !ipv4Loopback) || url.username || url.password || url.search || url.hash || !url.port) {
    throw new Error("ai_live_local_rtmp_destination_must_be_loopback");
  }
  return url.toString();
}
export function buildLocalRtmpArgs(url, durationSeconds = 10) {
  const destination = validateLocalRtmpUrl(url);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 120) throw new Error("ai_live_local_rtmp_duration_out_of_range");
  return ["-hide_banner","-loglevel","error","-re","-f","lavfi","-i","testsrc2=size=1280x720:rate=30","-f","lavfi","-i","sine=frequency=440:sample_rate=48000","-t",String(durationSeconds),"-c:v","libx264","-preset","veryfast","-tune","zerolatency","-pix_fmt","yuv420p","-g","60","-c:a","aac","-b:a","128k","-ar","48000","-f","flv",destination];
}
export function runLocalRtmpSmokeTest({url,durationSeconds=10,spawnImpl=nodeSpawn,signal}={}) {
  const args=buildLocalRtmpArgs(url,durationSeconds);
  if(typeof spawnImpl!=="function") throw new Error("ai_live_local_rtmp_spawn_required");
  return new Promise((resolve,reject)=>{
    if(signal?.aborted) return reject(new Error("ai_live_local_rtmp_aborted"));
    let settled=false;
    const child=spawnImpl("ffmpeg",args,{stdio:["ignore","ignore","ignore"],windowsHide:true});
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener("abort",abort);if(error)reject(error);else resolve(result);};
    const abort=()=>{child.kill("SIGTERM");finish(new Error("ai_live_local_rtmp_aborted"));};
    const timer=setTimeout(()=>{child.kill("SIGTERM");finish(new Error("ai_live_local_rtmp_timeout"));},(durationSeconds+15)*1000);
    signal?.addEventListener("abort",abort,{once:true});
    child.once("error",()=>finish(new Error("ai_live_local_rtmp_ffmpeg_spawn_failed")));
    child.once("close",(code,exitSignal)=>{if(code!==0)return finish(new Error("ai_live_local_rtmp_ffmpeg_exit_"+(Number.isInteger(code)?code:"signal")));finish(null,{ok:true,destination:"loopback",durationSeconds,exitCode:0,signal:exitSignal||null});});
  });
}
