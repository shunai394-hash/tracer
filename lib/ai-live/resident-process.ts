import { spawnSync } from "node:child_process";

/** Stops a worker child and its descendants. Safe to call when the pid is already gone. */
export function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // The child already exited.
  }
}
