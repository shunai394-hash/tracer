import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const appId = process.env.TRACER_MOBILE_APP_ID?.trim();
const appName = process.env.TRACER_MOBILE_APP_NAME?.trim() || "TRACER";
const webUrl = process.env.TRACER_MOBILE_WEB_URL?.trim();

if (!appId) {
  console.error("TRACER_MOBILE_APP_ID is required.");
  console.error("Example: TRACER_MOBILE_APP_ID=com.example.tracer");
  process.exit(1);
}

if (!webUrl) {\n  console.error("TRACER_MOBILE_WEB_URL is required.");\n  console.error("Use the stable HTTPS production URL for TRACER.");\n  process.exit(1);\n}\n\ntry {\n  const parsed = new URL(webUrl);\n  if (parsed.protocol !== "https:") throw new Error("HTTPS is required.");\n} catch {\n  console.error("TRACER_MOBILE_WEB_URL must be a valid HTTPS URL.");\n  process.exit(1);\n}\n\nif (!/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)+$/.test(appId)) {
  console.error("TRACER_MOBILE_APP_ID must be a reverse-DNS style application ID.");
  process.exit(1);
}

const config = {
  appId,
  appName,
  webDir: ".",
  server: {
    url: webUrl,
    cleartext: false,
  },
};

writeFileSync("capacitor.config.json", JSON.stringify(config, null, 2) + "\n", "utf8");

function run(args) {
  console.log("$ npx cap " + args.join(" "));
  execFileSync("npx", ["cap", ...args], { stdio: "inherit" });
}

if (!existsSync("ios")) {
  run(["add", "ios", "--packagemanager", "SPM"]);
} else {
  console.log("ios/ already exists; leaving it unchanged.");
}

if (!existsSync("android")) {
  run(["add", "android"]);
} else {
  console.log("android/ already exists; leaving it unchanged.");
}

console.log("\nNative TRACER shells created.");
console.log("Next: open ios/App/App.xcodeproj in Xcode and android/ in Android Studio.");
