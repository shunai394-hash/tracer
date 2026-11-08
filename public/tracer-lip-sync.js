(() => {
  "use strict";
  const contexts = new WeakMap();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  let gain = 0.42;
  function attach(audio, mouth) {
    if (!audio || !mouth || !AudioContextClass) return () => {};
    let entry = contexts.get(audio);
    if (!entry) {
      const context = new AudioContextClass();
      const source = context.createMediaElementSource(audio);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.12;
      source.connect(analyser);
      analyser.connect(context.destination);
      entry = { context, analyser, data: new Uint8Array(analyser.fftSize), mouths: new Set(), running: false, frame: 0, smoothed: 0 };
      contexts.set(audio, entry);
    }
    entry.mouths.add(mouth);
    const setMouth = value => { for (const target of entry.mouths) target.style.setProperty("--lip-open", value.toFixed(3)); };
    const close = () => { entry.smoothed = 0; setMouth(0); };
    const tick = () => {
      if (!entry.running || entry.mouths.size === 0) return;
      entry.analyser.getByteTimeDomainData(entry.data);
      let energy = 0;
      for (let i = 0; i < entry.data.length; i++) {
        const sample = (entry.data[i] - 128) / 128;
        energy += sample * sample;
      }
      const rms = Math.sqrt(energy / entry.data.length);
      const target = rms <= 0.022 ? 0 : Math.max(0, Math.min(0.48, (rms - 0.022) * 6.5 * gain));
      if (target === 0) {
        entry.smoothed *= 0.48;
        if (entry.smoothed < 0.012) entry.smoothed = 0;
      } else {
        entry.smoothed += (target - entry.smoothed) * 0.52;
      }
      setMouth(entry.smoothed);
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
      entry.mouths.delete(mouth);
      mouth.style.setProperty("--lip-open", "0");
      if (entry.mouths.size === 0) stopLoop();
    };
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
  function setGain(value) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) gain = Math.max(0.05, Math.min(1, parsed));
  }
  window.TracerLipSync = Object.freeze({ attach, setGain });
})();