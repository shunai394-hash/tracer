(() => {
  "use strict";
  const contexts = new WeakMap();
  const attachments = new WeakMap();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  let gain = 0.72;
  const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

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
      const mid = averageBand(frequencyData, entry.context.sampleRate, analyser.fftSize, 650, 2200);
      const high = averageBand(frequencyData, entry.context.sampleRate, analyser.fftSize, 2200, 5200);
      const total = low + mid + high + 0.0001;

      // RMS tracks syllable energy; spectral balance adds visible vowel-shape changes.
      const targetOpen = rms < 0.014
        ? 0
        : clamp((rms - 0.014) * 11.5 * gain, 0, 0.92);
      const targetWide = clamp((high / total - 0.18) * 2.1, 0, 1);
      const targetRound = clamp((low / total - 0.24) * 1.8, 0, 1);

      const smooth = (current, target) => current + (target - current) * (target > current ? 0.62 : 0.34);
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

  window.TracerLipSync = Object.freeze({ attach, detach, setGain });
})();