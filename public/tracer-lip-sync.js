(() => {
  "use strict";
  const contexts = new WeakMap();
  const attachments = new WeakMap();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  let gain = 1.12;
  const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

  const vowelRows = [
    ["あかがさざただなはばぱまやらわぁゃ", "a"],
    ["いきぎしじちぢにひびぴみりゐぃ", "i"],
    ["うくぐすずつづぬふぶぷむゆるゔぅゅ", "u"],
    ["えけげせぜてでねへべぺめれゑぇ", "e"],
    ["おこごそぞとどのほぼぽもよろをぉょ", "o"]
  ];
  const bilabial = new Set(Array.from("まみむめもばびぶべぼぱぴぷぺぽ"));
  function toHiragana(character) {
    const normalized = character.normalize("NFKC");
    const code = normalized.codePointAt(0);
    return code >= 0x30a1 && code <= 0x30f6
      ? String.fromCodePoint(code - 0x60)
      : normalized;
  }
  function vowelOf(character) {
    const kana = toHiragana(character);
    for (const [row, vowel] of vowelRows) if (row.includes(kana)) return vowel;
    return "a";
  }
  function shapeFor(vowel) {
    switch (vowel) {
      case "i": return { open: 0.34, wide: 1, round: 0.02 };
      case "u": return { open: 0.38, wide: 0.08, round: 1 };
      case "e": return { open: 0.66, wide: 0.78, round: 0.04 };
      case "o": return { open: 0.72, wide: 0.05, round: 0.9 };
      default: return { open: 1, wide: 0.18, round: 0.04 };
    }
  }
  function buildVisemes(timeline) {
    if (!Array.isArray(timeline)) return [];
    const result = [];
    for (const segment of timeline) {
      const text = String(segment?.text || "");
      const start = Number(segment?.start);
      const end = Number(segment?.end);
      if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const chars = Array.from(text).filter(character => !/[\s、。,.!?！？「」『』（）()…ー]/u.test(character));
      if (!chars.length) {
        result.push({ start, end, open: 0, wide: 0, round: 0 });
        continue;
      }
      const duration = (end - start) / chars.length;
      chars.forEach((character, index) => {
        const charStart = start + duration * index;
        const charEnd = charStart + duration;
        const vowel = vowelOf(character);
        const shape = shapeFor(vowel);
        if (bilabial.has(toHiragana(character))) {
          const closureEnd = charStart + duration * 0.22;
          result.push({ start: charStart, end: closureEnd, open: 0.015, wide: 0.08, round: 0.02 });
          result.push({ start: closureEnd, end: charEnd, ...shape });
        } else {
          result.push({ start: charStart, end: charEnd, ...shape });
        }
      });
    }
    return result.sort((a, b) => a.start - b.start);
  }

  function attachAligned(audio, mouth, timeline) {
    if (!audio || !mouth) return () => {};
    const visemes = buildVisemes(timeline);
    if (!visemes.length) return attach(audio, mouth);
    detach(mouth);
    let frame = 0;
    let active = false;
    let index = 0;
    const setShape = (shape) => {
      mouth.style.setProperty("--lip-open", shape.open.toFixed(3));
      mouth.style.setProperty("--lip-wide", shape.wide.toFixed(3));
      mouth.style.setProperty("--lip-round", shape.round.toFixed(3));
      mouth.dataset.lipSyncState = shape.open < 0.035 ? "closed" : "speaking";
    };
    const closed = { open: 0, wide: 0, round: 0 };
    const tick = () => {
      if (!active) return;
      const time = audio.currentTime;
      while (index < visemes.length && visemes[index].end < time) index++;
      const current = visemes[index];
      if (current && current.start <= time && time <= current.end) {
        setShape(current);
      } else {
        setShape(closed);
      }
      frame = requestAnimationFrame(tick);
    };
    const start = () => {
      if (active) return;
      active = true;
      index = Math.max(0, visemes.findIndex(item => item.end >= audio.currentTime));
      if (index < 0) index = visemes.length;
      tick();
    };
    const stop = () => {
      active = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      index = 0;
      setShape(closed);
    };
    audio.addEventListener("play", start);
    audio.addEventListener("pause", stop);
    audio.addEventListener("ended", stop);
    audio.addEventListener("emptied", stop);
    audio.addEventListener("seeked", () => {
      index = Math.max(0, visemes.findIndex(item => item.end >= audio.currentTime));
    });
    if (!audio.paused) start();
    const dispose = () => {
      stop();
      audio.removeEventListener("play", start);
      audio.removeEventListener("pause", stop);
      audio.removeEventListener("ended", stop);
      audio.removeEventListener("emptied", stop);
      mouth.style.setProperty("--lip-open", "0");
      mouth.style.setProperty("--lip-wide", "0");
      mouth.style.setProperty("--lip-round", "0");
      delete mouth.dataset.lipSyncState;
    };
    let disposers = attachments.get(mouth);
    if (!disposers) {
      disposers = new Set();
      attachments.set(mouth, disposers);
    }
    disposers.add(dispose);
    return dispose;
  }

  function attach(audio, mouth) {
    if (!audio || !mouth || !AudioContextClass) return () => {};
    let entry = contexts.get(audio);
    if (!entry) {
      const context = new AudioContextClass();
      const source = context.createMediaElementSource(audio);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.06;
      source.connect(analyser);
      analyser.connect(context.destination);
      entry = {
        context, analyser,
        timeData: new Uint8Array(analyser.fftSize),
        frequencyData: new Uint8Array(analyser.frequencyBinCount),
        mouths: new Set(), running: false, frame: 0,
        open: 0, wide: 0, round: 0
      };
      contexts.set(audio, entry);
    }
    entry.mouths.add(mouth);
    let mouthDisposers = attachments.get(mouth);
    if (!mouthDisposers) {
      mouthDisposers = new Set();
      attachments.set(mouth, mouthDisposers);
    }
    const setMouth = () => {
      for (const target of entry.mouths) {
        target.style.setProperty("--lip-open", entry.open.toFixed(3));
        target.style.setProperty("--lip-wide", entry.wide.toFixed(3));
        target.style.setProperty("--lip-round", entry.round.toFixed(3));
        target.dataset.lipSyncState = entry.open < 0.035 ? "closed" : "speaking";
      }
    };
    const close = () => {
      entry.open = 0;
      entry.wide = 0;
      entry.round = 0;
      setMouth();
    };
    const averageBand = (data, sampleRate, fftSize, fromHz, toHz) => {
      const start = Math.max(1, Math.floor(fromHz * fftSize / sampleRate));
      const end = Math.min(data.length, Math.ceil(toHz * fftSize / sampleRate));
      if (end <= start) return 0;
      let sum = 0;
      for (let i = start; i < end; i++) sum += data[i] / 255;
      return sum / (end - start);
    };
    const tick = () => {
      if (!entry.running || entry.mouths.size === 0) return;
      const { analyser, timeData, frequencyData } = entry;
      analyser.getByteTimeDomainData(timeData);
      analyser.getByteFrequencyData(frequencyData);
      let energy = 0;
      for (let i = 0; i < timeData.length; i++) {
        const sample = (timeData[i] - 128) / 128;
        energy += sample * sample;
      }
      const rms = Math.sqrt(energy / timeData.length);
      const low = averageBand(frequencyData, entry.context.sampleRate, analyser.fftSize, 180, 650);
      const high = averageBand(frequencyData, entry.context.sampleRate, analyser.fftSize, 2200, 5200);
      const total = low + averageBand(frequencyData, entry.context.sampleRate, analyser.fftSize, 650, 2200) + high + 0.0001;
      const targetOpen = rms < 0.009 ? 0 : clamp((rms - 0.009) * 17 * gain, 0, 1);
      const targetWide = clamp((high / total - 0.18) * 2.1, 0, 1);
      const targetRound = clamp((low / total - 0.24) * 1.8, 0, 1);
      const smooth = (current, target) => current + (target - current) * (target > current ? 0.82 : 0.24);
      entry.open = smooth(entry.open, targetOpen);
      entry.wide = smooth(entry.wide, targetOpen === 0 ? 0 : targetWide);
      entry.round = smooth(entry.round, targetOpen === 0 ? 0 : targetRound);
      if (entry.open < 0.012) entry.open = 0;
      setMouth();
      entry.frame = requestAnimationFrame(tick);
    };
    const start = () => {
      if (entry.running) return;
      entry.running = true;
      entry.context.resume().catch(() => {});
      if (!entry.frame) tick();
    };
    const stopLoop = () => {
      entry.running = false;
      if (entry.frame) cancelAnimationFrame(entry.frame);
      entry.frame = 0;
      close();
    };
    const dispose = () => {
      mouthDisposers.delete(dispose);
      entry.mouths.delete(mouth);
      mouth.style.setProperty("--lip-open", "0");
      mouth.style.setProperty("--lip-wide", "0");
      mouth.style.setProperty("--lip-round", "0");
      delete mouth.dataset.lipSyncState;
      if (entry.mouths.size === 0) stopLoop();
    };
    mouthDisposers.add(dispose);
    audio.addEventListener("play", start);
    audio.addEventListener("pause", stopLoop);
    audio.addEventListener("ended", stopLoop);
    audio.addEventListener("emptied", stopLoop);
    if (!audio.paused) start();
    return () => {
      dispose();
      audio.removeEventListener("play", start);
      audio.removeEventListener("pause", stopLoop);
      audio.removeEventListener("ended", stopLoop);
      audio.removeEventListener("emptied", stopLoop);
    };
  }

  function detach(mouth) {
    const disposers = attachments.get(mouth);
    if (!disposers) return;
    for (const dispose of [...disposers]) dispose();
    attachments.delete(mouth);
  }
  function setGain(value) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) gain = clamp(parsed, 0.1, 1.5);
  }
  window.TracerLipSync = Object.freeze({ attach, attachAligned, detach, setGain });
})();