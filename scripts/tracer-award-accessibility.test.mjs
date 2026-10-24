import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("global focus indicator uses a clear 3px dark ring", () => {
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--focus-ring\)/s);
  assert.match(css, /--focus-ring:\s*#3b241a/i);
});

test("reduced-motion preference disables smooth scrolling and minimizes transitions", () => {
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /html\s*\{\s*scroll-behavior:\s*auto;/s);
  assert.match(css, /transition-duration:\s*0\.01ms\s*!important/);
  assert.match(css, /animation-duration:\s*0\.01ms\s*!important/);
});
