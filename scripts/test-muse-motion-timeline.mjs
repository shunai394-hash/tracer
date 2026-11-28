import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../public/ai-live-short-drama-studio.html", import.meta.url), "utf8");
const script = await readFile(new URL("../public/muse-motion-timeline.js", import.meta.url), "utf8");

for (const id of ["museMotionPanel", "museMotionScenes", "museMotionPreview", "museMotionAdd", "museMotionPlay", "museMotionStop", "museMotionExport", "museMotionStatus", "museMotionSync", "museMotionBgmInfo"]) {
  assert.ok(html.includes(`id="${id}"`), `Missing studio element: ${id}`);
}
assert.ok(html.includes("gsap@3.13.0"), "GSAP version must be pinned");
assert.ok(html.includes("/muse-motion-timeline.js"), "Timeline module must be loaded by the studio");
assert.ok(script.includes('format: "muse-motion-manifest"'), "Manifest format must be stable");
assert.ok(script.includes("scenes.forEach((scene, index) => animateScene(scene, index, timeline))"), "Scenes must be added to the GSAP timeline");
assert.ok(script.includes("timeline.kill()"), "Timeline must be stoppable and safely reset");
assert.ok(script.includes("Math.min(60, Math.max(0.5"), "Scene durations must be bounded");
assert.ok(script.includes("scenes.length >= 30"), "Scene count must be bounded");
console.log("Muse motion timeline contract: PASS");

assert.ok(html.includes("window.TracerMuseBridge"), "Existing drama studio must expose a read-only bridge");
assert.ok(html.includes("getLines:()=>lineRows.map"), "Bridge must read current script line rows");
assert.ok(html.includes("getBgmUrl:"), "Bridge must expose selected BGM preview URL");
assert.ok(script.includes("function syncFromDrama()"), "Timeline must import the current drama script");
assert.ok(script.includes("new Audio(scene.audioUrl)"), "Generated dialogue audio must play in the timeline");
assert.ok(script.includes("new Audio(selectedBgm.url)"), "Selected BGM must play in the timeline");
assert.ok(script.includes("narrationAudioReady"), "Exported manifest must preserve generated-audio readiness");
