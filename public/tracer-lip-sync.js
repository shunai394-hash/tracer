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
      entry = { context, analyser, data: new Uint8Array(analyser.fftSize) };
      contexts.set(audio, entry);
    }
    let active = true;
    let running = false;
    let smoothed = 0;
    let frame = 0;
    const setMouth = value => mouth.style.setProperty("--lip-open", value.toFixed(3));
    const close = () => { smoothed = 0; setMouth(0); };
    const tick = () => {
      if (!active || !running) return;
      entry.analyser.getByteTimeDomainData(entry.data);
      let energy = 0;
      for (let i = 0; i < entry.data.length; i++) {
        const sample = (entry.data[i] - 128) / 128;
        energy += sample * sample;
      }
      const rms = Math.sqrt(energy / entry.data.length);
      const target = rms <= 0.022 ? 0 : Math.max(0, Math.min(0.48, (rms - 0.022) * 6.5 * gain));
      if (target === 0) {
        smoothed *= 0.48;
        if (smoothed < 0.012) smoothed = 0;
      } else {
        smoothed += (target - smoothed) * 0.52;
      }
      setMouth(smoothed);
      frame = requestAnimationFrame(tick);
    };
    const start = () => {
      if (!active || running) return;
      running = true;
      entry.context.resume().catch(() => {});
      if (!frame) tick();
    };
    const stopLoop = () => {
      running = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      close();
    };
    const dispose = () => {
      if (!active) return;
      active = false;
      stopLoop();
      audio.removeEventListener("play", start);
      audio.removeEventListener("pause", stopLoop);
      audio.removeEventListener("ended", stopLoop);
      audio.removeEventListener("emptied", stopLoop);
    };
    audio.addEventListener("play", start);
    audio.addEventListener("pause", stopLoop);
    audio.addEventListener("ended", stopLoop);
    audio.addEventListener("emptied", stopLoop);
    if (!audio.paused) start();
    return dispose;
  }
  function setGain(value) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) gain = Math.max(0.05, Math.min(1, parsed));
  }
  window.TracerLipSync = Object.freeze({ attach, setGain });
})();