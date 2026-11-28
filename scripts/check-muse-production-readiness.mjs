import process from "node:process";

const REQUIRED = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "MUSE_RENDER_WORKER_TOKEN",
  "TRACER_ADMIN_TOKEN",
  "FISH_AUDIO_API_KEY",
];

function present(name) {
  return Boolean(process.env[name] && process.env[name].trim());
}

function report(body) {
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
}

const missing = REQUIRED.filter((name) => !present(name));
const result = {
  missing,
  migration: "not-checked",
  bucket: "not-checked",
  bucketPrivate: "not-checked",
  changedProduction: false,
};

if (missing.includes("NEXT_PUBLIC_SUPABASE_URL") || missing.includes("SUPABASE_SERVICE_ROLE_KEY")) {
  report(result);
  process.exit(missing.length ? 2 : 0);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL.trim().replace(/\/$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY.trim();
const headers = { apikey: key, Authorization: `Bearer ${key}` };

async function readStatus(path) {
  const response = await fetch(`${url}${path}`, { headers, cache: "no-store" });
  const text = await response.text();
  return { status: response.status, text };
}

try {
  const table = await readStatus("/rest/v1/ai_live_muse_render_jobs?select=status&limit=1");
  result.migration = table.status === 200 ? "applied" : "absent";

  const bucket = await readStatus("/storage/v1/bucket/tracer-muse-render");
  if (bucket.status === 200) {
    let parsed = {};
    try { parsed = JSON.parse(bucket.text); } catch { parsed = {}; }
    result.bucket = parsed.id === "tracer-muse-render" || parsed.name === "tracer-muse-render" ? "present" : "unexpected";
    result.bucketPrivate = parsed.public === false ? "yes" : parsed.public === true ? "no" : "unknown";
  } else {
    result.bucket = "absent";
    result.bucketPrivate = "unknown";
  }
} catch {
  result.migration = "unreadable";
  result.bucket = "unreadable";
  result.bucketPrivate = "unknown";
}

report(result);
const ready = result.migration === "applied" && result.bucket === "present" && result.bucketPrivate === "yes" && missing.length === 0;
process.exit(ready ? 0 : 2);
