import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const speak = readFileSync(new URL("../app/api/admin/ai-live/speak-reply/route.ts", import.meta.url), "utf8");
const drama = readFileSync(new URL("../app/api/admin/ai-live/fish-drama-3/route.ts", import.meta.url), "utf8");
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

assert.match(speak, /requireAutomationAuth\(request\)/u);
assert.match(speak, /routeAiLiveComment\(input\.comment\)/u);
assert.match(speak, /buildAiLiveReply\(route\.category, product\)/u);
assert.match(speak, /\.eq\("published", true\)/u);
assert.match(speak, /\.eq\("orderable", true\)/u);
assert.match(speak, /\.eq\("tracking_available", true\)/u);
assert.match(speak, /\.gt\("inventory", 0\)/u);
assert.match(speak, /\.eq\("base_publication_status", "published"\)/u);
assert.match(speak, /process\.env\.FISH_API_KEY/u);
assert.match(speak, /process\.env\.AI_LIVE_FISH_REFERENCE_ID/u);
assert.match(speak, /model: "s2-pro"/u);
assert.match(speak, /"X-AI-Voice-Model": "s2-pro"/u);
assert.match(speak, /AbortSignal\.timeout\(25_000\)/u);
assert.match(speak, /const MAX_AUDIO_BYTES = 12 \* 1024 \* 1024;/u);
assert.match(speak, /No automatic retry|never retry automatically/iu);
assert.match(speak, /human_or_moderation/u);
assert.doesNotMatch(speak, /\.from\(["']orders["']\)/u);
assert.doesNotMatch(speak, /\.insert\(|\.update\(|\.upsert\(|\.delete\(/u);
assert.doesNotMatch(speak, /console\.(log|error)\(/u);

assert.match(drama, /requireAutomationAuth\(request\)/u);
assert.match(drama, /TRACER_ADMIN_TOKEN/u);
assert.match(drama, /timingSafeEqual/u);
assert.match(drama, /authorizedAdminToken\(request\)/u);
assert.match(drama, /model: "drama-3"/u);
assert.match(drama, /"X-AI-Voice-Model": "drama-3"/u);
assert.match(drama, /AbortSignal\.timeout\(25_000\)/u);
assert.match(drama, /const MAX_AUDIO_BYTES = 12 \* 1024 \* 1024;/u);
assert.match(drama, /not automatically retried/u);
assert.doesNotMatch(drama, /console\.(log|error)\(/u);

function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

for (const source of [speak, drama]) {
  assert.equal(occurrenceCount(source, "async function readAudioBodyLimited("), 1);
  assert.equal(occurrenceCount(source, "readAudioBodyLimited(upstream, MAX_AUDIO_BYTES)"), 1);
  assert.equal(occurrenceCount(source, "arrayBuffer("), 0);
  assert.equal(occurrenceCount(source, "new ArrayBuffer("), 0);
  const call = source.indexOf("await readAudioBodyLimited(upstream, MAX_AUDIO_BYTES)");
  const sizeStatus = source.indexOf('error: "audio_size_out_of_range"', call);
  const rethrow = source.indexOf("throw error;", call);
  const success = source.indexOf("new NextResponse(bytes,", call);
  assert.ok(call > 0 && sizeStatus > call && rethrow > call && success > rethrow);
  assert.ok(source.indexOf(", 502)", sizeStatus) > sizeStatus);
}

assert.match(speak, /new NextResponse\(bytes,/u);
assert.doesNotMatch(speak, /audioBuffer/u);
assert.match(drama, /new NextResponse\(bytes,/u);

function extractFunction(source, name) {
  const signature = `async function ${name}(`;
  const start = source.indexOf(signature);
  assert.notEqual(start, -1);
  assert.equal(source.indexOf(signature, start + signature.length), -1);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

const helperSource = extractFunction(speak, "readAudioBodyLimited").replace(/\r\n/g, "\n");
assert.equal(extractFunction(drama, "readAudioBodyLimited").replace(/\r\n/g, "\n"), helperSource);
assert.ok(helperSource.indexOf('response.headers.get("content-length")') < helperSource.indexOf("body.getReader()"));
assert.ok(helperSource.indexOf("unread.cancel()") < helperSource.indexOf("body.getReader()"));
assert.ok(helperSource.includes("/^\\d+$/"));
assert.doesNotMatch(helperSource, /Number\(\s*(trimmed|rawLength|declared)/u);
assert.doesNotMatch(helperSource, /arrayBuffer\s*\(/u);

const compiled = ts.transpileModule(`${helperSource}\nexport { readAudioBodyLimited };\n`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const helperModule = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const { readAudioBodyLimited } = helperModule;

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("Fish Audio must not be contacted by the audio body limit test");
};

function responseWith(body, contentLength) {
  return {
    headers: {
      get(name) {
        if (String(name).toLowerCase() !== "content-length" || contentLength === undefined) return null;
        return contentLength;
      },
    },
    body,
  };
}

function trackedStream(chunk, maxPulls) {
  const stats = { pulls: 0, cancels: 0 };
  const stream = new ReadableStream({
    pull(controller) {
      stats.pulls += 1;
      if (stats.pulls > maxPulls) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(chunk));
    },
    cancel() {
      stats.cancels += 1;
    },
  }, { highWaterMark: 1 });
  return { stream, stats };
}

function oneChunkStream(chunk) {
  const stats = { pulls: 0, cancels: 0 };
  const stream = new ReadableStream({
    pull(controller) {
      stats.pulls += 1;
      if (stats.pulls === 1) controller.enqueue(new Uint8Array(chunk));
      else controller.close();
    },
    cancel() {
      stats.cancels += 1;
    },
  }, { highWaterMark: 1 });
  return { stream, stats };
}

async function waitForStream() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function scriptedBody(chunks, options = {}) {
  const state = { reads: 0, cancels: 0, readerRequested: false };
  const body = {
    async cancel() {
      state.cancels += 1;
      if (options.failCancel) throw new Error("cancel failed");
    },
    getReader() {
      state.readerRequested = true;
      if (options.failGetReader) throw new Error("getReader failed");
      return {
        async read() {
          state.reads += 1;
          if (options.failRead) throw new Error("read failed");
          if (state.reads > chunks.length) return { done: true, value: undefined };
          return { done: false, value: chunks[state.reads - 1] };
        },
        async cancel() {
          state.cancels += 1;
        },
        releaseLock() {},
      };
    },
  };
  return { body, state };
}

async function expectFailure(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.name, "AudioBodyError");
    assert.equal(error?.message, code);
    return true;
  });
}

try {
  const sample = new Uint8Array([1, 2, 3, 4]);
  const overLimit = scriptedBody([sample], { failGetReader: true });
  await expectFailure(
    readAudioBodyLimited(responseWith(overLimit.body, String(MAX_AUDIO_BYTES + 1)), MAX_AUDIO_BYTES),
    "audio_size_out_of_range",
  );
  assert.equal(overLimit.state.readerRequested, false);
  assert.equal(overLimit.state.reads, 0);
  assert.equal(overLimit.state.cancels, 1);

  for (const header of [
    String(MAX_AUDIO_BYTES + 1),
    ` ${MAX_AUDIO_BYTES + 1} `,
    `000${MAX_AUDIO_BYTES + 1}`,
    "9".repeat(40),
    "20",
  ]) {
    const tracked = trackedStream(sample, 30);
    await waitForStream();
    const before = tracked.stats.pulls;
    const maxBytes = header === "20" ? 19 : MAX_AUDIO_BYTES;
    await expectFailure(
      readAudioBodyLimited(responseWith(tracked.stream, header), maxBytes),
      "audio_size_out_of_range",
    );
    await waitForStream();
    assert.equal(tracked.stats.pulls, before, header);
    assert.equal(tracked.stats.cancels, 1, header);
  }

  const withinDeclared = oneChunkStream(new Uint8Array([4, 5]));
  assert.deepEqual([...(await readAudioBodyLimited(responseWith(withinDeclared.stream, "19"), 19))], [4, 5]);
  assert.equal(withinDeclared.stats.cancels, 0);
  const shorterDigits = oneChunkStream(new Uint8Array([6]));
  assert.deepEqual([...(await readAudioBodyLimited(responseWith(shorterDigits.stream, "9"), 10))], [6]);

  for (const header of ["1e8", "1.3e7", "+13000000", "0x2000000", "Infinity", "4.9", "-1", "+12", "nope", "8abc", "NaN", "1,000", "", "   "]) {
    const small = oneChunkStream(sample);
    assert.deepEqual(
      [...(await readAudioBodyLimited(responseWith(small.stream, header), MAX_AUDIO_BYTES))],
      [...sample],
      header,
    );
    assert.equal(small.stats.cancels, 0, header);
  }

  const cancelFails = scriptedBody([sample], { failCancel: true, failGetReader: true });
  await expectFailure(
    readAudioBodyLimited(responseWith(cancelFails.body, String(MAX_AUDIO_BYTES + 1)), MAX_AUDIO_BYTES),
    "audio_size_out_of_range",
  );
  assert.equal(cancelFails.state.readerRequested, false);

  await expectFailure(
    readAudioBodyLimited(responseWith(null, String(MAX_AUDIO_BYTES + 1)), MAX_AUDIO_BYTES),
    "audio_size_out_of_range",
  );

  for (const header of [undefined, "nope", "", "   ", "-1", "8abc", "NaN", "1,000", "1e8", "4.9", "+8", "0x10"]) {
    const tracked = trackedStream(sample, 30);
    await waitForStream();
    const before = tracked.stats.pulls;
    await expectFailure(readAudioBodyLimited(responseWith(tracked.stream, header), 8), "audio_size_out_of_range");
    await waitForStream();
    assert.equal(tracked.stats.cancels, 1, String(header));
    assert.ok(tracked.stats.pulls > before, String(header));
    assert.ok(tracked.stats.pulls - before <= 6, `${header} kept reading (${tracked.stats.pulls - before} new pulls)`);
    assert.ok(tracked.stats.pulls < 30, String(header));
  }

  const understated = trackedStream(sample, 30);
  await waitForStream();
  const understatedBefore = understated.stats.pulls;
  await expectFailure(readAudioBodyLimited(responseWith(understated.stream, "4"), 8), "audio_size_out_of_range");
  await waitForStream();
  assert.equal(understated.stats.cancels, 1);
  assert.ok(understated.stats.pulls > understatedBefore);
  assert.ok(understated.stats.pulls - understatedBefore <= 6);
  assert.ok(understated.stats.pulls < 30);

  const zeroDeclared = oneChunkStream(sample);
  assert.deepEqual([...(await readAudioBodyLimited(responseWith(zeroDeclared.stream, "0"), 8))], [...sample]);
  assert.equal(zeroDeclared.stats.cancels, 0);

  const exact = scriptedBody([new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8])]);
  const exactBytes = await readAudioBodyLimited(responseWith(exact.body), 8);
  assert.ok(exactBytes instanceof Uint8Array);
  assert.deepEqual([...exactBytes], [1, 2, 3, 4, 5, 6, 7, 8]);

  const declaredExact = scriptedBody([new Uint8Array([9, 8, 7, 6])]);
  const declaredBytes = await readAudioBodyLimited(responseWith(declaredExact.body, "4"), 8);
  assert.deepEqual([...declaredBytes], [9, 8, 7, 6]);

  const fractional = scriptedBody([new Uint8Array([4, 3, 2, 1])]);
  assert.deepEqual([...(await readAudioBodyLimited(responseWith(fractional.body, "4.9"), 8))], [4, 3, 2, 1]);

  const emptyChunk = scriptedBody([new Uint8Array(), new Uint8Array([7, 7])]);
  assert.deepEqual([...(await readAudioBodyLimited(responseWith(emptyChunk.body), 8))], [7, 7]);

  const sourceChunk = new Uint8Array([1, 2, 3, 4]);
  const copied = await readAudioBodyLimited(responseWith(scriptedBody([sourceChunk]).body), 8);
  sourceChunk[0] = 9;
  assert.equal(copied[0], 1);

  await expectFailure(readAudioBodyLimited(responseWith(scriptedBody([]).body), 8), "audio_size_out_of_range");
  await expectFailure(readAudioBodyLimited(responseWith(null), 8), "audio_size_out_of_range");
  await expectFailure(
    readAudioBodyLimited(responseWith(scriptedBody([new Uint8Array(20)]).body), 8),
    "audio_size_out_of_range",
  );

  const broken = scriptedBody([sample], { failRead: true });
  await expectFailure(readAudioBodyLimited(responseWith(broken.body, "nope"), 8), "audio_read_failed");
  assert.equal(broken.state.reads, 1);
  assert.equal(broken.state.cancels, 1);
  await expectFailure(
    readAudioBodyLimited(responseWith(scriptedBody([], { failGetReader: true }).body), 8),
    "audio_read_failed",
  );
  await expectFailure(readAudioBodyLimited(responseWith(scriptedBody([new Uint8Array([1])]).body), 0), "audio_read_failed");

  const platformBytes = await readAudioBodyLimited(new Response(new Uint8Array([9, 8, 7, 6])), MAX_AUDIO_BYTES);
  assert.deepEqual([...platformBytes], [9, 8, 7, 6]);
  await expectFailure(readAudioBodyLimited(new Response(new Uint8Array()), MAX_AUDIO_BYTES), "audio_size_out_of_range");
  await expectFailure(readAudioBodyLimited(new Response(null), MAX_AUDIO_BYTES), "audio_size_out_of_range");

  let produced = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      produced += 1;
      if (produced > 30) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array([1, 2, 3, 4]));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expectFailure(readAudioBodyLimited(new Response(stream), 8), "audio_size_out_of_range");
  assert.equal(cancelled, true);
  assert.ok(produced > 0 && produced <= 6, `stream read continued past the cap (${produced} chunks)`);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("AI-live verified speech route safety contract and bounded audio reads passed.");
