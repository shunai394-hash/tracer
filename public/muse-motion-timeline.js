/* Muse Motion Timeline — isolated authoring prototype.
 * GSAP is loaded by the studio page; no global TRACER behavior is modified.
 */
(() => {
  "use strict";
  const root = document.getElementById("museMotionPanel");
  if (!root || root.dataset.initialized === "true") return;
  root.dataset.initialized = "true";

  const $ = (id) => root.querySelector("#" + id);
  const sceneList = $("museMotionScenes");
  const preview = $("museMotionPreview");
  const status = $("museMotionStatus");
  const playButton = $("museMotionPlay");
  const stopButton = $("museMotionStop");
  const addButton = $("museMotionAdd");
  const exportButton = $("museMotionExport");
  const syncButton = $("museMotionSync");
  let timeline = null;
  let narrationAudio = null;
  let bgmAudio = null;
  let selectedBgm = null;
  let nextId = 1;
  let scenes = [
    { id: nextId++, title: "オープニング", duration: 3, preset: "fade-up", text: "物語のはじまり" },
    { id: nextId++, title: "会話シーン", duration: 5, preset: "soft-zoom", text: "二人の出会い" },
    { id: nextId++, title: "エンディング", duration: 3, preset: "fade", text: "つづく" }
  ];

  const presets = [
    ["fade-up", "フェード＋上昇"],
    ["soft-zoom", "ゆるやかなズーム"],
    ["slide-left", "左からスライド"],
    ["pop", "ポップ"],
    ["fade", "フェード"]
  ];

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }

  function renderScenes() {
    sceneList.replaceChildren();
    scenes.forEach((scene, index) => {
      const row = document.createElement("div");
      row.className = "museMotionSceneRow";
      row.innerHTML = `
        <div class="museMotionSceneNumber">${index + 1}</div>
        <div class="museMotionSceneFields">
          <label>シーン名<input data-field="title" maxlength="60" value="${escapeHtml(scene.title)}"></label>
          <label>画面テキスト<input data-field="text" maxlength="120" value="${escapeHtml(scene.text)}"></label>
          <div class="museMotionSceneControls">
            <label>秒数<input data-field="duration" type="number" min="0.5" max="60" step="0.5" value="${scene.duration}"></label>
            <label>動き<select data-field="preset">${presets.map(([value,label]) => `<option value="${value}" ${scene.preset === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
            <button type="button" class="secondary museMotionRemove">削除</button>
          </div>
        </div>`;
      row.querySelectorAll("[data-field]").forEach((field) => {
        field.addEventListener("change", () => {
          const key = field.dataset.field;
          scene[key] = key === "duration" ? Math.min(60, Math.max(0.5, Number(field.value) || 1)) : field.value;
          if (key === "duration") field.value = scene.duration;
          updateSummary();
        });
      });
      row.querySelector(".museMotionRemove").addEventListener("click", () => {
        if (timeline) timeline.kill();
        scenes = scenes.filter((item) => item.id !== scene.id);
        renderScenes();
        updateSummary();
      });
      sceneList.append(row);
    });
    updateSummary();
  }

  function updateSummary() {
    const total = scenes.reduce((sum, scene) => sum + Number(scene.duration || 0), 0);
    $("museMotionTotal").textContent = total.toFixed(1) + "秒";
    $("museMotionCount").textContent = scenes.length + "シーン";
  }

  function setStatus(message) {
    status.textContent = message;
  }

  function resetPreview() {
    if (narrationAudio) { narrationAudio.pause(); narrationAudio.currentTime = 0; narrationAudio = null; }
    if (bgmAudio) { bgmAudio.pause(); bgmAudio.currentTime = 0; bgmAudio = null; }
    if (timeline) {
      timeline.kill();
      timeline = null;
    }
    if (window.gsap) window.gsap.set(preview, { clearProps: "all", opacity: 0, x: 0, y: 0, scale: 1 });
    preview.style.opacity = "0";
    preview.style.transform = "translate3d(0,0,0) scale(1)";
    preview.textContent = "プレビュー";
  }

  function animateScene(scene, index, tl) {
    const gsap = window.gsap;
    const start = scenes.slice(0, index).reduce((sum, item) => sum + Number(item.duration), 0);
    const duration = Number(scene.duration);
    const base = { opacity: 0, x: 0, y: 0, scale: 1 };
    const target = { opacity: 1, x: 0, y: 0, scale: 1 };
    if (scene.preset === "fade-up") { base.y = 42; }
    if (scene.preset === "soft-zoom") { base.scale = 0.88; target.scale = 1; }
    if (scene.preset === "slide-left") { base.x = 90; }
    if (scene.preset === "pop") { base.scale = 0.55; }
    tl.call(() => {
      preview.textContent = scene.text || scene.title;
      preview.dataset.scene = String(index + 1);
      gsap.set(preview, base);
      if (narrationAudio) { narrationAudio.pause(); narrationAudio.currentTime = 0; }
      narrationAudio = scene.audioUrl ? new Audio(scene.audioUrl) : null;
      if (narrationAudio) narrationAudio.play().catch(() => setStatus("セリフ音声の再生がブラウザーによりブロックされました。プレビューをもう一度押してください。"));
    }, null, start);
    tl.to(preview, {
      ...target,
      duration: Math.min(0.8, duration * 0.3),
      ease: scene.preset === "pop" ? "back.out(1.7)" : "power3.out"
    }, start);
    tl.to(preview, {
      opacity: 0,
      duration: Math.min(0.45, duration * 0.2),
      ease: "power1.in"
    }, Math.max(start + duration - 0.45, start + 0.1));
  }

  function play() {
    if (!scenes.length) { setStatus("シーンを1つ以上追加してください。"); return; }
    if (!window.gsap) {
      setStatus("GSAPを読み込めません。ネットワーク接続を確認してください。シーン構成の編集とJSON出力は利用できます。");
      return;
    }
    resetPreview();
    timeline = window.gsap.timeline({
      onComplete: () => { resetPreview(); setStatus("台本・セリフ音声・BGMのプレビューが完了しました。"); },
      onStart: () => setStatus("プレビュー再生中…")
    });
    if (selectedBgm?.url) { bgmAudio = new Audio(selectedBgm.url); bgmAudio.loop = Boolean(selectedBgm.loop); bgmAudio.volume = Math.min(1, Math.max(0, Number(selectedBgm.volume) || 0)); bgmAudio.play().catch(() => setStatus("BGM再生がブロックされました。")); }
    scenes.forEach((scene, index) => animateScene(scene, index, timeline));
    timeline.play(0);
  }

  function exportManifest() {
    const manifest = {
      format: "muse-motion-manifest",
      version: 1,
      createdAt: new Date().toISOString(),
      fps: 30,
      scenes: scenes.map((scene, index) => ({
        order: index + 1,
        title: scene.title,
        text: scene.text,
        durationSeconds: Number(scene.duration),
        motionPreset: scene.preset,
        speakerName: scene.speakerName || "",
        voiceName: scene.voiceName || "",
        voiceId: scene.voiceId || "",
        narrationAudioReady: Boolean(scene.audioReady)
      })),
      bgm: selectedBgm ? { name: selectedBgm.name, title: selectedBgm.title, genre: selectedBgm.genre, volume: selectedBgm.volume, loop: selectedBgm.loop } : null,
      totalDurationSeconds: scenes.reduce((sum, scene) => sum + Number(scene.duration), 0)
    };
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "muse-motion-manifest.json";
    link.click();
    URL.revokeObjectURL(url);
    setStatus("演出マニフェストを書き出しました。これは設計データであり、完成動画ではありません。");
  }


  function syncFromDrama() {
    const bridge = window.TracerMuseBridge;
    if (!bridge || typeof bridge.getProject !== "function" || typeof bridge.getLines !== "function") {
      setStatus("ドラマスタジオとの接続が見つかりません。スタジオを再読み込みしてください。");
      return;
    }
    const project = bridge.getProject();
    const lines = bridge.getLines();
    if (!lines.length) { setStatus("台本にセリフがありません。先にセリフを追加してください。"); return; }
    resetPreview();
    scenes = lines.map((line, index) => ({
      id: nextId++,
      title: (line.speakerName || "話者") + "・セリフ" + (index + 1),
      text: line.text || "",
      duration: line.durationSeconds || Math.max(2, Math.min(12, (String(line.text || "").length * 0.32))),
      preset: index === 0 ? "fade-up" : "soft-zoom",
      speakerName: line.speakerName,
      voiceName: line.voiceName,
      voiceId: line.voiceId,
      audioReady: line.audioReady,
      audioUrl: line.audioUrl || ""
    }));
    selectedBgm = typeof bridge.getBgm === "function" ? bridge.getBgm() : null;
    if (selectedBgm) selectedBgm.url = bridge.getBgmUrl ? bridge.getBgmUrl() : "";
    renderScenes();
    const ready = scenes.filter(scene => scene.audioReady).length;
    setStatus("台本を取り込みました："+(project.title || "無題")+" 第"+(project.episode || 1)+"話／"+scenes.length+"セリフ。生成済み音声 "+ready+"件。尺未確定のセリフは文字数からの仮見積もりです。");
  }

  addButton.addEventListener("click", () => {
    if (scenes.length >= 30) { setStatus("試作版では最大30シーンです。"); return; }
    scenes.push({ id: nextId++, title: "新しいシーン", duration: 3, preset: "fade-up", text: "テキストを入力" });
    renderScenes();
  });
  playButton.addEventListener("click", play);
  syncButton.addEventListener("click", syncFromDrama);
  stopButton.addEventListener("click", () => { resetPreview(); setStatus("プレビューを停止しました。"); });
  exportButton.addEventListener("click", exportManifest);
  renderScenes();
  if (!window.gsap) setStatus("GSAPの読み込みを待機中です。読み込めない場合もシーン編集・JSON出力は可能です。");
  else setStatus("シーンを編集し、プレビューまたは演出マニフェスト出力を実行できます。");
})();