(() => {
  "use strict";
  const contexts = new WeakMap();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  function attach(audio, mouth) {
    if (!audio || !mouth || !AudioContextClass) return () => {};
    let entry = contexts.get(audio);
    if (!entry) {
      const context = new AudioContextClass();
      const source = context.createMediaElementSource(audio);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.68;
      source.connect(analyser);
      analyser.connect(context.destination);
      entry = { context, analyser, data: new Uint8Array(analyser.fftSize), frame: 0, users: 0 };
      contexts.set(audio, entry);
    }
    entry.users += 1;
    let active = true;
    let running = false;
    let smoothed = 0;
    const tick = () => {
      if (!active || !running) return;
      entry.analyser.getByteTimeDomainData(entry.data);
      let energy = 0;
      for (let i = 0; i < entry.data.length; i++) {
        const sample = (entry.data[i] - 128) / 128;
        energy += sample * sample;
      }
      const rms = Math.sqrt(energy / entry.data.length);
      const target = Math.max(0, Math.min(1, (rms - 0.012) * 12));
      smoothed += (target - smoothed) * (target > smoothed ? 0.48 : 0.22);
      mouth.style.setProperty("--lip-open", smoothed.toFixed(3));
      entry.frame = requestAnimationFrame(tick);
    };
    const start = () => {
      if (!active || running) return;
      running = true;
      entry.context.resume().catch(() => {});
      if (!entry.frame) tick();
    };
    const stopLoop = () => {
      running = false;
      if (entry.frame) cancelAnimationFrame(entry.frame);
      entry.frame = 0;
      mouth.style.setProperty("--lip-open", "0");
    };
    const dispose = () => {
      if (!active) return;
      active = false;
      stopLoop();
      audio.removeEventListener("play", start);
      audio.removeEventListener("pause", stopLoop);
      audio.removeEventListener("ended", stopLoop);
    };
    audio.addEventListener("play", start);
    audio.addEventListener("pause", stopLoop);
    audio.addEventListener("ended", stopLoop);
    if (!audio.paused) start();
    return dispose;
  }
  window.TracerLipSync = Object.freeze({ attach });
})();