      // ── State ─────────────────────────────────────────────────────────────────────
      const API = () => document.getElementById("apiUrl").value.replace(/\/$/, "");
      const MAX_FILE_BYTES = 250 * 1024 * 1024;

      // crypto.randomUUID() sólo existe en contextos seguros (HTTPS o localhost).
      // Serví por HTTP+IP (ej. http://104.128.64.125:5500) rompe esa función, así que
      // acá usamos randomUUID si está disponible y si no generamos un UUID v4 a mano.
      function genUUID() {
        if (window.crypto && typeof window.crypto.randomUUID === "function") {
          return window.crypto.randomUUID();
        }
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          const v = c === "x" ? r : (r & 0x3) | 0x8;
          return v.toString(16);
        });
      }

      function formatDbValue(value, digits = 1) {
        const n = Number(value);
        if (!Number.isFinite(n)) return "—";
        return `${n >= 0 ? "+" : ""}${n.toFixed(digits)} dB`;
      }
      function formatLinearThresholdToDb(value, digits = 1) {
        const db = 20 * Math.log10(Math.max(Number(value), 1e-9));
        return `${db >= 0 ? "+" : ""}${db.toFixed(digits)} dB`;
      }

      let selectedFile = null;
      let cachedFileBuffer = null; // ArrayBuffer cacheado al seleccionar el archivo
      let _previewSessionId = null; // UUID que identifica el archivo actual en el caché del servidor
      let _previewLibraryId = null; // id del archivo en la librería persistente del servidor, si se eligió de ahí
      let currentJobId = null;
      let pollInterval = null;
      let downloadUrl = null;

      // ── Cache de colores del tema ────────────────────────────────────────────────
      // Las variables --bg/--accent/etc. son fijas (no hay theme switcher), así que
      // evitamos forzar un recálculo de estilos (getComputedStyle) en cada redibujo
      // de canvas (EQ curve, waveform, FFT) — se lee una sola vez y se reusa.
      let _themeColorsCache = null;
      function themeColors() {
        if (_themeColorsCache) return _themeColorsCache;
        const styles = getComputedStyle(document.documentElement);
        const read = (name) => styles.getPropertyValue(name).trim();
        _themeColorsCache = {
          bg: read("--bg"),
          surface: read("--surface"),
          surface2: read("--surface2"),
          border: read("--border"),
          accent: read("--accent"),
          accent2: read("--accent2"),
          green: read("--green"),
          yellow: read("--yellow"),
          red: read("--red"),
          text: read("--text"),
          muted: read("--muted"),
          get: (varName) => read(varName), // fallback para nombres arbitrarios tipo '--foo'
        };
        return _themeColorsCache;
      }

      // ── Nombre del tema para la descarga ────────────────────────────────────────
      function currentTrackNameParam() {
        const input = document.getElementById("trackNameInput");
        const val = ((input && input.value) || "").trim();
        return val ? `?name=${encodeURIComponent(val)}` : "";
      }
      function getTrackBaseName() {
        const input = document.getElementById("trackNameInput");
        const val = ((input && input.value) || "").trim();
        if (val) return val;
        if (selectedFile) return selectedFile.name.replace(/\.[^/.]+$/, "");
        return "reporte";
      }
      async function downloadReport(jobId) {
        try {
          const res = await fetch(`${API()}/report/${jobId}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${getTrackBaseName()}_reporte.json`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        } catch (e) {
          alert("No se pudo descargar el reporte: " + e.message);
        }
      }
      function prefillTrackNameFromFile() {
        const input = document.getElementById("trackNameInput");
        if (!input || input.value.trim() || !selectedFile) return;
        const base = selectedFile.name.replace(/\.[^/.]+$/, "");
        input.value = base;
      }
      let abSnapshotA = null,
        abSnapshotB = null;
      let previewDebounceTimer = null,
        previewAbortController = null,
        previewAudioUrl = null,
        previewWS = null;
      let originalFFTCache = null;
      let previewBufs = { original: null, processed: null };
      let metersAudioCtx = null,
        metersSourceNode = null,
        metersAnalyserL = null,
        metersAnalyserR = null,
        metersRafId = null,
        metersSplitter = null;
      let metersLufsRingBuffer = [];
      const METERS_LUFS_WINDOW = 60;

      // ── Asistente de IA: estado ─────────────────────────────────────────────────
      let lastAnalysisData = null; // último dict de análisis (lufs, peak_db, spectrum, mix_advice, ...)
      let aiChatHistory = []; // [{role:'user'|'assistant', content:str}, ...]
      let aiAvailable = null; // null=sin chequear, true/false luego de /ai/status

      // ── Sliders ──────────────────────────────────────────────────────────────────
      const sliders = [
        ["s-ingain", "v-ingain", (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + " dB"],
        [
          "s-peak",
          "v-peak",
          (v) => {
            const db = 20 * Math.log10(Math.max(Number(v), 1e-9));
            return (db >= 0 ? "+" : "") + db.toFixed(1) + " dBTP";
          },
        ],
        ["s-lufstarget", "v-lufstarget", (v) => v.toFixed(1) + " LUFS"],
        ["s-thresh", "v-thresh", (v) => formatDbValue(v)],
        ["s-ratio", "v-ratio", (v) => v.toFixed(1) + ":1"],
        ["s-cattack", "v-cattack", (v) => v.toFixed(1) + " ms"],
        ["s-crelease", "v-crelease", (v) => Math.round(v) + " ms"],
        ["s-cmakeup", "v-cmakeup", (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + " dB"],
        ["s-glue-thresh", "v-glue-thresh", (v) => formatDbValue(v)],
        ["s-glue-ratio", "v-glue-ratio", (v) => v.toFixed(1) + ":1"],
        ["s-glue-attack", "v-glue-attack", (v) => v.toFixed(1) + " ms"],
        ["s-glue-release", "v-glue-release", (v) => Math.round(v) + " ms"],
        ["s-glue-makeup", "v-glue-makeup", (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + " dB"],
        // Compresión paralela
        ["parallelMix", "parallelMixVal", (v) => v.toFixed(2)],
        ["parallelThresh", "parallelThreshVal", (v) => formatDbValue(v)],
        ["parallelRatio", "parallelRatioVal", (v) => v.toFixed(1) + ":1"],
        ["parallelAttack", "parallelAttackVal", (v) => v.toFixed(1) + " ms"],
        ["parallelRelease", "parallelReleaseVal", (v) => Math.round(v) + " ms"],
        ["s-hp", "v-hp", (v) => (v >= 1000 ? (v / 1000).toFixed(1) + " kHz" : v + " Hz")],
        ["s-eq1freq", "v-eq1freq-disp", (v) => (v >= 1000 ? (v / 1000).toFixed(1) + " kHz" : Math.round(v) + " Hz")],
        ["s-eq1gain", "v-eq1gain", (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + " dB"],
        ["s-eq1q", "v-eq1q", (v) => v.toFixed(1)],
        ["s-eq2freq", "v-eq2freq-disp", (v) => (v >= 1000 ? (v / 1000).toFixed(1) + " kHz" : Math.round(v) + " Hz")],
        ["s-eq2gain", "v-eq2gain", (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + " dB"],
        ["s-eq2q", "v-eq2q", (v) => v.toFixed(1)],
        ["s-eq3freq", "v-eq3freq-disp", (v) => (v >= 1000 ? (v / 1000).toFixed(1) + " kHz" : Math.round(v) + " Hz")],
        ["s-eq3gain", "v-eq3gain", (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + " dB"],
        ["s-eq3q", "v-eq3q", (v) => v.toFixed(1)],
        ["s-eq4freq", "v-eq4freq-disp", (v) => (v >= 1000 ? (v / 1000).toFixed(1) + " kHz" : Math.round(v) + " Hz")],
        ["s-eq4gain", "v-eq4gain", (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + " dB"],
        ["s-eq4q", "v-eq4q", (v) => v.toFixed(1)],
        ["s-eq5freq", "v-eq5freq-disp", (v) => (v >= 1000 ? (v / 1000).toFixed(1) + " kHz" : Math.round(v) + " Hz")],
        ["s-eq5gain", "v-eq5gain", (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + " dB"],
        ["s-eq5q", "v-eq5q", (v) => v.toFixed(1)],
        ["s-eq6freq", "v-eq6freq-disp", (v) => (v >= 1000 ? (v / 1000).toFixed(1) + " kHz" : Math.round(v) + " Hz")],
        ["s-eq6gain", "v-eq6gain", (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + " dB"],
        ["s-eq6q", "v-eq6q", (v) => v.toFixed(1)],
        ["s-air", "v-air", (v) => (v >= 0 ? "+" : "") + parseFloat(v).toFixed(1) + " dB"],
        ["s-shelf-freq", "v-shelf-freq", (v) => (v >= 1000 ? (v / 1000).toFixed(1) + " kHz" : v + " Hz")],
        ["s-mb-sw-lowx", "v-mb-sw-lowx", (v) => v + " Hz"],
        ["s-mb-sw-highx", "v-mb-sw-highx", (v) => (v >= 1000 ? (v / 1000).toFixed(1) + " kHz" : v + " Hz")],
        ["s-mb-sw-low", "v-mb-sw-low", (v) => parseFloat(v).toFixed(2) + "x"],
        ["s-mb-sw-mid", "v-mb-sw-mid", (v) => parseFloat(v).toFixed(2) + "x"],
        ["s-mb-sw-high", "v-mb-sw-high", (v) => parseFloat(v).toFixed(2) + "x"],
        ["s-tatt", "v-tatt", (v) => (v >= 0 ? "+" : "") + v.toFixed(2)],
        ["s-tsus", "v-tsus", (v) => (v >= 0 ? "+" : "") + v.toFixed(2)],
        ["s-satdrive", "v-satdrive", (v) => Math.round(v * 100) + "%"],
        ["s-satmix", "v-satmix", (v) => Math.round(v * 100) + "%"],
        ["s-mgain", "v-mgain", (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + " dB"],
        ["s-sgain", "v-sgain", (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + " dB"],
        ["s-width", "v-width", (v) => parseFloat(v).toFixed(2) + "x"],
        ["s-haas", "v-haas", (v) => parseFloat(v).toFixed(1) + " ms"],
        ["s-bassmono", "v-bassmono", (v) => Math.round(v) + " Hz"],
        ["s-rsize", "v-rsize", (v) => parseFloat(v).toFixed(2)],
        ["s-rwet", "v-rwet", (v) => Math.round(v * 100) + "%"],
        [
          "s-ceiling",
          "v-ceiling",
          (v) => {
            const db = 20 * Math.log10(Math.max(Number(v), 1e-9));
            return (db >= 0 ? "+" : "") + db.toFixed(1) + " dBTP";
          },
        ],
        ["s-lrelease", "v-lrelease", (v) => Math.round(v) + " ms"],
        // Multiband
        ["s-mb-lowx", "v-mb-lowx", (v) => (v >= 1000 ? (v / 1000).toFixed(1) + " kHz" : v + " Hz")],
        ["s-dyneq-freq", "v-dyneq-freq", (v) => (v >= 1000 ? (v / 1000).toFixed(1) + " kHz" : v + " Hz")],
        ["s-dyneq-q", "v-dyneq-q", (v) => parseFloat(v).toFixed(1)],
        ["s-dyneq-thresh", "v-dyneq-thresh", (v) => (v >= 0 ? "+" : "") + parseFloat(v).toFixed(1) + " dB"],
        ["s-dyneq-ratio", "v-dyneq-ratio", (v) => parseFloat(v).toFixed(1) + ":1"],
        ["s-dyneq-attack", "v-dyneq-attack", (v) => parseFloat(v).toFixed(1) + " ms"],
        ["s-dyneq-release", "v-dyneq-release", (v) => Math.round(v) + " ms"],
        ["s-dyneq-maxred", "v-dyneq-maxred", (v) => parseFloat(v).toFixed(1) + " dB"],
        ["s-mono-freq", "v-mono-freq", (v) => Math.round(v) + " Hz"],
        ["s-mono-amount", "v-mono-amount", (v) => Math.round(v * 100) + "%"],
        ["s-lp-taps", "v-lp-taps", (v) => Math.round(v)],
        ["s-mb-highx", "v-mb-highx", (v) => (v >= 1000 ? (v / 1000).toFixed(1) + " kHz" : v + " Hz")],
        ["s-mb-low-th", "v-mb-low-th", (v) => formatDbValue(v)],
        ["s-mb-low-ratio", "v-mb-low-ratio", (v) => v.toFixed(1) + ":1"],
        ["s-mb-low-att", "v-mb-low-att", (v) => v.toFixed(1) + " ms"],
        ["s-mb-low-rel", "v-mb-low-rel", (v) => Math.round(v) + " ms"],
        ["s-mb-low-mu", "v-mb-low-mu", (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + " dB"],
        ["s-mb-mid-th", "v-mb-mid-th", (v) => formatDbValue(v)],
        ["s-mb-mid-ratio", "v-mb-mid-ratio", (v) => v.toFixed(1) + ":1"],
        ["s-mb-mid-att", "v-mb-mid-att", (v) => v.toFixed(1) + " ms"],
        ["s-mb-mid-rel", "v-mb-mid-rel", (v) => Math.round(v) + " ms"],
        ["s-mb-mid-mu", "v-mb-mid-mu", (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + " dB"],
        ["s-mb-high-th", "v-mb-high-th", (v) => formatDbValue(v)],
        ["s-mb-high-ratio", "v-mb-high-ratio", (v) => v.toFixed(1) + ":1"],
        ["s-mb-high-att", "v-mb-high-att", (v) => v.toFixed(1) + " ms"],
        ["s-mb-high-rel", "v-mb-high-rel", (v) => Math.round(v) + " ms"],
        ["s-mb-high-mu", "v-mb-high-mu", (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + " dB"],
        // Reference matching
        ["s-ref-boost", "v-ref-boost", (v) => "+" + v.toFixed(1) + " dB"],
        ["s-ref-cut", "v-ref-cut", (v) => v.toFixed(1) + " dB"],
        ["s-ref-dynmargin", "v-ref-dynmargin", (v) => v.toFixed(1) + " dB"],
        ["s-ref-stereoblend", "v-ref-stereoblend", (v) => Math.round(v) + "%"],
        // Low-pass
        ["s-lp-cutoff", "v-lp-cutoff", (v) => (v >= 1000 ? (v / 1000).toFixed(1) + " kHz" : Math.round(v) + " Hz")],
        // Noise reduction
        ["s-nr-strength", "v-nr-strength", (v) => parseFloat(v).toFixed(2)],
        ["s-nr-noise-sample-sec", "v-nr-noise-sample-sec", (v) => parseFloat(v).toFixed(1) + " s"],
        // Dynamic EQ resonancias
        ["s-reso-freq", "v-reso-freq", (v) => (v >= 1000 ? (v / 1000).toFixed(1) + " kHz" : Math.round(v) + " Hz")],
        ["s-reso-q", "v-reso-q", (v) => parseFloat(v).toFixed(1)],
        ["s-reso-thresh", "v-reso-thresh", (v) => parseFloat(v).toFixed(1) + " dB"],
        ["s-reso-ratio", "v-reso-ratio", (v) => parseFloat(v).toFixed(1) + ":1"],
        ["s-reso-attack", "v-reso-attack", (v) => parseFloat(v).toFixed(1) + " ms"],
        ["s-reso-release", "v-reso-release", (v) => Math.round(v) + " ms"],
        ["s-reso-maxred", "v-reso-maxred", (v) => parseFloat(v).toFixed(1) + " dB"],
        // M/S EQ
        [
          "s-mseq-mid-freq",
          "v-mseq-mid-freq",
          (v) => (v >= 1000 ? (v / 1000).toFixed(1) + " kHz" : Math.round(v) + " Hz"),
        ],
        ["s-mseq-mid-gain", "v-mseq-mid-gain", (v) => (v >= 0 ? "+" : "") + parseFloat(v).toFixed(1) + " dB"],
        ["s-mseq-mid-q", "v-mseq-mid-q", (v) => parseFloat(v).toFixed(1)],
        [
          "s-mseq-side-freq",
          "v-mseq-side-freq",
          (v) => (v >= 1000 ? (v / 1000).toFixed(1) + " kHz" : Math.round(v) + " Hz"),
        ],
        ["s-mseq-side-gain", "v-mseq-side-gain", (v) => (v >= 0 ? "+" : "") + parseFloat(v).toFixed(1) + " dB"],
        ["s-mseq-side-q", "v-mseq-side-q", (v) => parseFloat(v).toFixed(1)],
        // Compresor M/S
        ["s-mscomp-mid-thresh", "v-mscomp-mid-thresh", (v) => parseFloat(v).toFixed(1) + " dB"],
        ["s-mscomp-mid-ratio", "v-mscomp-mid-ratio", (v) => parseFloat(v).toFixed(1) + ":1"],
        ["s-mscomp-mid-attack", "v-mscomp-mid-attack", (v) => parseFloat(v).toFixed(1) + " ms"],
        ["s-mscomp-mid-release", "v-mscomp-mid-release", (v) => Math.round(v) + " ms"],
        ["s-mscomp-mid-makeup", "v-mscomp-mid-makeup", (v) => (v >= 0 ? "+" : "") + parseFloat(v).toFixed(1) + " dB"],
        ["s-mscomp-side-thresh", "v-mscomp-side-thresh", (v) => parseFloat(v).toFixed(1) + " dB"],
        ["s-mscomp-side-ratio", "v-mscomp-side-ratio", (v) => parseFloat(v).toFixed(1) + ":1"],
        ["s-mscomp-side-attack", "v-mscomp-side-attack", (v) => parseFloat(v).toFixed(1) + " ms"],
        ["s-mscomp-side-release", "v-mscomp-side-release", (v) => Math.round(v) + " ms"],
        ["s-mscomp-side-makeup", "v-mscomp-side-makeup", (v) => (v >= 0 ? "+" : "") + parseFloat(v).toFixed(1) + " dB"],
        // Clipper
        ["s-clip-ceiling", "v-clip-ceiling", (v) => parseFloat(v).toFixed(2)],
        ["s-clip-drive", "v-clip-drive", (v) => (v >= 0 ? "+" : "") + parseFloat(v).toFixed(1) + " dB"],
      ];
      sliders.forEach(([sid, vid, fmt]) => {
        const s = document.getElementById(sid),
          v = document.getElementById(vid);
        if (!s || !v) return;
        s.addEventListener("input", () => {
          v.textContent = fmt(parseFloat(s.value));
        });
      });

      // ── Multiband tabs ──────────────────────────────────────────────────────────
      document.querySelectorAll(".mb-tab").forEach((tab) => {
        tab.addEventListener("click", () => {
          document.querySelectorAll(".mb-tab").forEach((t) => t.classList.remove("active"));
          tab.classList.add("active");
          const band = tab.dataset.band;
          document.querySelectorAll(".mb-panel").forEach((p) => p.classList.remove("active"));
          document.getElementById("mb-panel-" + band).classList.add("active");
        });
      });

      // ── Workflow rail / etapas ─────────────────────────────────────────────────
      const workflowCards = Array.from(document.querySelectorAll(".process-card-collapsible"));
      const workflowChips = Array.from(document.querySelectorAll(".workflow-chip"));
      function syncWorkflowState() {
        const openIndex = workflowCards.findIndex((card) => card.open);
        const currentIndex = openIndex >= 0 ? openIndex : 0;
        workflowChips.forEach((chip, index) => {
          chip.classList.toggle("active", index === currentIndex);
          chip.classList.toggle("done", index < currentIndex);
          chip.style.cursor = "pointer";
        });
      }
      workflowCards.forEach((card, index) => {
        card.addEventListener("toggle", syncWorkflowState);
        card.dataset.stageIndex = index;
      });
      workflowChips.forEach((chip, index) => {
        chip.addEventListener("click", () => {
          workflowCards.forEach((card, cardIndex) => {
            card.open = cardIndex === index;
          });
          syncWorkflowState();
        });
      });
      syncWorkflowState();

      // ── Presets ──────────────────────────────────────────────────────────────────
      let activePreset = null;
      const sliderIdToParam = {
        "s-ingain": "input_gain_db",
        "s-peak": "target_peak",
        "s-thresh": "comp_threshold_db",
        "s-ratio": "comp_ratio",
        "s-cattack": "comp_attack_ms",
        "s-crelease": "comp_release_ms",
        "s-cmakeup": "comp_makeup_db",
        "s-glue-thresh": "glue_threshold_db",
        "s-glue-ratio": "glue_ratio",
        "s-glue-attack": "glue_attack_ms",
        "s-glue-release": "glue_release_ms",
        "s-glue-makeup": "glue_makeup_db",
        "s-hp": "hp_cutoff",
        "s-air": "high_shelf_gain_db",
        "s-shelf-freq": "high_shelf_freq_hz",
        "s-eq1freq": "eq1_freq",
        "s-eq1gain": "eq1_gain",
        "s-eq1q": "eq1_q",
        "s-eq2freq": "eq2_freq",
        "s-eq2gain": "eq2_gain",
        "s-eq2q": "eq2_q",
        "s-eq3freq": "eq3_freq",
        "s-eq3gain": "eq3_gain",
        "s-eq3q": "eq3_q",
        "s-eq4freq": "eq4_freq",
        "s-eq4gain": "eq4_gain",
        "s-eq4q": "eq4_q",
        "s-eq5freq": "eq5_freq",
        "s-eq5gain": "eq5_gain",
        "s-eq5q": "eq5_q",
        "s-eq6freq": "eq6_freq",
        "s-eq6gain": "eq6_gain",
        "s-eq6q": "eq6_q",
        "s-tatt": "transient_attack",
        "s-tsus": "transient_sustain",
        "s-satdrive": "saturation_drive",
        "s-satmix": "saturation_mix",
        "s-mgain": "mid_gain_db",
        "s-sgain": "side_gain_db",
        "s-width": "stereo_width_amount",
        "s-haas": "haas_delay_ms",
        "s-bassmono": "enhancer_bass_mono_freq",
        "s-rsize": "reverb_size",
        "s-rwet": "reverb_wet",
        "s-ceiling": "limiter_ceiling",
        "s-lrelease": "limiter_release_ms",
        "s-lufstarget": "target_lufs",
        // multiband
        "s-mb-lowx": "mb_low_crossover",
        "s-mb-highx": "mb_high_crossover",
        "s-mb-low-th": "mb_low_threshold_db",
        "s-mb-low-ratio": "mb_low_ratio",
        "s-mb-low-att": "mb_low_attack_ms",
        "s-mb-low-rel": "mb_low_release_ms",
        "s-mb-low-mu": "mb_low_makeup_db",
        "s-mb-mid-th": "mb_mid_threshold_db",
        "s-mb-mid-ratio": "mb_mid_ratio",
        "s-mb-mid-att": "mb_mid_attack_ms",
        "s-mb-mid-rel": "mb_mid_release_ms",
        "s-mb-mid-mu": "mb_mid_makeup_db",
        "s-mb-high-th": "mb_high_threshold_db",
        "s-mb-high-ratio": "mb_high_ratio",
        "s-mb-high-att": "mb_high_attack_ms",
        "s-mb-high-rel": "mb_high_release_ms",
        "s-mb-high-mu": "mb_high_makeup_db",
        "s-dyneq-freq": "dyneq_freq",
        "s-dyneq-q": "dyneq_q",
        "s-dyneq-thresh": "dyneq_threshold_db",
        "s-dyneq-ratio": "dyneq_ratio",
        "s-dyneq-attack": "dyneq_attack_ms",
        "s-dyneq-release": "dyneq_release_ms",
        "s-dyneq-maxred": "dyneq_max_reduction_db",
        "s-reso-freq": "reso_freq",
        "s-reso-q": "reso_q",
        "s-reso-thresh": "reso_threshold_db",
        "s-reso-ratio": "reso_ratio",
        "s-reso-attack": "reso_attack_ms",
        "s-reso-release": "reso_release_ms",
        "s-reso-maxred": "reso_max_reduction_db",
        "s-mono-freq": "low_end_mono_freq",
        "s-mono-amount": "low_end_mono_amount",
        "s-lp-taps": "linear_phase_taps",
        "s-mseq-mid-freq": "ms_mid_freq",
        "s-mseq-mid-gain": "ms_mid_gain",
        "s-mseq-mid-q": "ms_mid_q",
        "s-mseq-side-freq": "ms_side_freq",
        "s-mseq-side-gain": "ms_side_gain",
        "s-mseq-side-q": "ms_side_q",
        "s-mscomp-mid-thresh": "ms_comp_mid_threshold_db",
        "s-mscomp-mid-ratio": "ms_comp_mid_ratio",
        "s-mscomp-mid-attack": "ms_comp_mid_attack_ms",
        "s-mscomp-mid-release": "ms_comp_mid_release_ms",
        "s-mscomp-mid-makeup": "ms_comp_mid_makeup_db",
        "s-mscomp-side-thresh": "ms_comp_side_threshold_db",
        "s-mscomp-side-ratio": "ms_comp_side_ratio",
        "s-mscomp-side-attack": "ms_comp_side_attack_ms",
        "s-mscomp-side-release": "ms_comp_side_release_ms",
        "s-mscomp-side-makeup": "ms_comp_side_makeup_db",
      };

      function applyPresetToUI(presetData) {
        Object.entries(sliderIdToParam).forEach(([sliderId, paramKey]) => {
          if (presetData[paramKey] == null) return;
          const el = document.getElementById(sliderId);
          if (!el) return;
          el.value = presetData[paramKey];
          el.dispatchEvent(new Event("input"));
        });
        if (presetData.use_lufs_normalize != null)
          document.getElementById("s-uselufs").checked = !!presetData.use_lufs_normalize;
        if (presetData.use_stereo_enhancer != null)
          document.getElementById("s-enhancer").checked = !!presetData.use_stereo_enhancer;
        if (presetData.comp_stereo_link != null)
          document.getElementById("s-comp-link").checked = !!presetData.comp_stereo_link;
        if (presetData.nr_bypass != null) document.getElementById("s-nr-bypass").checked = !!presetData.nr_bypass;
        if (presetData.nr_strength != null) {
          document.getElementById("s-nr-strength").value = presetData.nr_strength;
          document.getElementById("v-nr-strength").textContent = parseFloat(presetData.nr_strength).toFixed(2);
        }
        if (presetData.nr_noise_sample_sec != null) {
          document.getElementById("s-nr-noise-sample-sec").value = presetData.nr_noise_sample_sec;
          document.getElementById("v-nr-noise-sample-sec").textContent =
            parseFloat(presetData.nr_noise_sample_sec).toFixed(1) + "s";
        }
        if (presetData.parallel_bypass != null) {
          const cb = document.getElementById("parallelBypass");
          cb.checked = !!presetData.parallel_bypass;
          cb.dispatchEvent(new Event("change"));  // trigger visual dim
        }
        if (presetData.parallel_mix != null) {
          const el = document.getElementById("parallelMix");
          if (el) { el.value = presetData.parallel_mix; el.dispatchEvent(new Event("input")); }
        }
        if (presetData.parallel_threshold_db != null) {
          const el = document.getElementById("parallelThresh");
          if (el) { el.value = presetData.parallel_threshold_db; el.dispatchEvent(new Event("input")); }
        }
        if (presetData.glue_bypass != null) document.getElementById("s-glue-bypass").checked = !!presetData.glue_bypass;
        if (presetData.saturation_mode) document.getElementById("s-satmode").value = presetData.saturation_mode;
        if (presetData.oversample_mode) document.getElementById("s-oversample").value = presetData.oversample_mode;
        if (presetData.mb_bypass != null) document.getElementById("mb-bypass").checked = !!presetData.mb_bypass;
        if (presetData.dyneq_bypass != null)
          document.getElementById("s-dyneq-bypass").checked = !!presetData.dyneq_bypass;
        if (presetData.reso_bypass != null)
          document.getElementById("s-reso-bypass").checked = !!presetData.reso_bypass;
        // BUGFIX: faltaba este wiring — el checkbox de bypass del EQ M/S
        // bandeada nunca se actualizaba al cargar un preset (mismo patrón
        // de bug que parallel_bypass/parallel_mix/parallel_threshold_db,
        // arreglado antes).
        if (presetData.ms_eq_bypass != null)
          document.getElementById("s-mseq-bypass").checked = !!presetData.ms_eq_bypass;
        if (presetData.ms_comp_bypass != null)
          document.getElementById("s-mscomp-bypass").checked = !!presetData.ms_comp_bypass;
        if (presetData.eq_mode) document.getElementById("s-eq-mode").value = presetData.eq_mode;
        drawEQCurve();
        schedulePreview();
      }

      async function loadAndApplyPreset(name) {
        try {
          const res = await fetch(`${API()}/preset/${name}`);
          if (!res.ok) throw new Error(await res.text());
          const data = await res.json();
          applyPresetToUI(data);
          activePreset = name;
          document
            .querySelectorAll(".preset-btn")
            .forEach((b) => b.classList.toggle("active", b.dataset.preset === name));
        } catch (e) {
          console.error("Preset error:", e);
        }
      }
      document.querySelectorAll(".preset-btn").forEach((btn) => {
        btn.addEventListener("click", () => loadAndApplyPreset(btn.dataset.preset));
      });

      // ── Cargar preset desde archivo JSON ────────────────────────────────────────
      document.getElementById("btnLoadPresetJson").addEventListener("click", () => {
        document.getElementById("presetJsonInput").click();
      });
      document.getElementById("presetJsonInput").addEventListener("change", async (e) => {
        const file = e.target.files[0];
        const statusEl = document.getElementById("presetLoadStatus");
        if (!file) return;
        statusEl.style.color = "var(--muted)";
        statusEl.textContent = "Leyendo " + file.name + "…";
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          // admite tanto { params: {...} } / { settings: {...} } como el objeto plano de parámetros
          const presetData = data.params || data.settings || data;
          applyPresetToUI(presetData);
          document.querySelectorAll(".preset-btn.active").forEach((b) => b.classList.remove("active"));
          activePreset = data.name || file.name.replace(/\.json$/i, "");
          statusEl.style.color = "var(--green)";
          statusEl.textContent = `✓ Preset "${activePreset}" cargado desde JSON`;
        } catch (err) {
          console.error("Error cargando preset JSON:", err);
          statusEl.style.color = "var(--red)";
          statusEl.textContent = "Error: JSON inválido o parámetros no reconocidos";
        } finally {
          e.target.value = "";
        }
      });
      ["input", "change"].forEach((evt) => {
        document.querySelectorAll(".param input[type=range], select, input[type=checkbox]").forEach((el) => {
          el.addEventListener(evt, () => {
            if (!el.dataset.fromPreset) {
              document.querySelectorAll(".preset-btn.active").forEach((b) => b.classList.remove("active"));
              activePreset = null;
            }
          });
        });
      });

      // Targets de loudness por plataforma — debe coincidir con
      // PLATFORM_LOUDNESS_TARGETS en mastering.py (backend). Se usa para
      // auto-configurar la normalización LUFS al elegir una plataforma:
      // antes, elegir "Apple Music (−16 LUFS)" en el combo solo ajustaba el
      // techo del limiter (true_peak_db) — el checkbox "Normalizar por LUFS"
      // y su target quedaban totalmente desconectados del selector, así que
      // el loudness real del master nunca terminaba de acercarse al target
      // que la propia etiqueta del combo prometía.
      const PLATFORM_LUFS_TARGETS = {
        spotify: -14.0,
        youtube: -14.0,
        apple_music: -16.0,
        tidal: -14.0,
        club: -9.0,
        cd: -9.0,
      };
      document.getElementById("s-platform").addEventListener("change", (e) => {
        const lufsTarget = PLATFORM_LUFS_TARGETS[e.target.value];
        if (lufsTarget == null) return; // "— Manual —": no tocar la config existente
        const lufsSlider = document.getElementById("s-lufstarget");
        lufsSlider.value = lufsTarget;
        lufsSlider.dispatchEvent(new Event("input", { bubbles: true }));
        const useLufsChk = document.getElementById("s-uselufs");
        if (!useLufsChk.checked) {
          useLufsChk.checked = true;
          useLufsChk.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });

      document.getElementById("s-platform").addEventListener("change", schedulePreview);

      // ── File handling ────────────────────────────────────────────────────────────
      const dropZone = document.getElementById("dropZone");
      const fileInput = document.getElementById("fileInput");
      let uppy = null;
      if (window.Uppy && window.Uppy.Uppy && window.Uppy.FileInput) {
        fileInput.style.pointerEvents = "none";
        uppy = new window.Uppy.Uppy({
          autoProceed: false,
          allowMultipleUploads: false,
          restrictions: { maxNumberOfFiles: 1, allowedFileTypes: ["audio/*"] },
        });
        uppy.use(window.Uppy.FileInput, {
          target: "#uppyPicker",
          pretty: true,
          locale: { filesSelected: { 0: "Elegir archivo", 1: "1 archivo seleccionado" } },
        });
        uppy.on("file-added", (file) => {
          if (file && file.data) setFile(file.data);
        });
        uppy.on("files-added", (files) => {
          const picked = Object.values(files || {}).find((f) => f && f.data);
          if (picked && picked.data) setFile(picked.data);
        });
      }
      dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.add("dragover");
      });
      dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
      dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("dragover");
        if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
      });
      fileInput.addEventListener("change", () => {
        if (fileInput.files[0]) setFile(fileInput.files[0]);
      });

      function setFile(f, libraryId = null) {
        const warn = document.getElementById("fileSizeWarn");
        if (f.size > MAX_FILE_BYTES) {
          warn.textContent = `⚠ Archivo de ${(f.size / 1024 / 1024).toFixed(1)} MB — máximo 200 MB`;
          return;
        }
        warn.textContent = "";
        selectedFile = f;
        // Nuevo archivo → nuevo session_id para que el servidor descarte el caché anterior
        _previewSessionId = genUUID();
        // Si viene de la librería del servidor, el preview puede saltarse el
        // upload por completo (el server ya lo tiene en disco). Si es un
        // archivo local nuevo (drag&drop / selector), esto queda en null.
        _previewLibraryId = libraryId;
        document.getElementById("fileName").textContent = `${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`;
        ["btnMaster", "btnAnalyze", "btnAdvice", "btnSpectrum", "btnStems", "btnAB", "btnAutoMaster", "btnAiSuggest"].forEach((id) => {
          document.getElementById(id).disabled = false;
        });
        updateRefButtonState();
        document.getElementById("btnDownload").style.display = "none";
        document.getElementById("btnReport").style.display = "none";
        const trackNameInputEl = document.getElementById("trackNameInput");
        if (trackNameInputEl) {
          trackNameInputEl.value = "";
          trackNameInputEl.style.display = "none";
        }
        document.getElementById("emptyState")?.remove();
        clearResults();

        originalFFTCache = null;
        cachedFileBuffer = null; // resetear caché del buffer anterior
        previewBufs = { original: null, processed: null };
        if (previewAudioUrl) {
          URL.revokeObjectURL(previewAudioUrl);
          previewAudioUrl = null;
        }
        document.getElementById("previewWrap").style.display = "none";
        document.getElementById("previewAudioWrap").innerHTML = "";
        hideLiveSpectrum();
        hideDynEqRecommendation();
        setPreviewStatus("En espera…");

        loadFileBuffer(f);
        schedulePreview();

        // Guardar en la librería persistente del servidor, salvo que el
        // archivo YA venga de ahí (libraryId != null) — evita duplicados al
        // volver a elegir un archivo que ya está guardado.
        if (!libraryId && document.getElementById("saveToLibraryChk")?.checked) {
          uploadCurrentFileToLibrary(f);
        }
      }

      // ── Librería persistente (archivos guardados en el servidor) ────────────────
      async function refreshLibraryList() {
        const listEl = document.getElementById("libraryList");
        try {
          const res = await fetch(`${API()}/library`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          renderLibraryList(data.files || []);
        } catch (e) {
          console.error("[librería] error al listar:", e);
          listEl.innerHTML = `<div style="opacity:.6;padding:6px 2px;">No se pudo cargar la librería.</div>`;
        }
      }

      function _formatLibraryDuration(sec) {
        if (sec == null) return "";
        const m = Math.floor(sec / 60);
        const s = Math.round(sec % 60).toString().padStart(2, "0");
        return `${m}:${s}`;
      }

      function renderLibraryList(files) {
        const listEl = document.getElementById("libraryList");
        if (!files.length) {
          listEl.innerHTML = `<div style="opacity:.6;padding:6px 2px;">Todavía no guardaste ningún archivo.</div>`;
          return;
        }
        listEl.innerHTML = "";
        for (const f of files) {
          const row = document.createElement("div");
          row.style.cssText = "display:flex;align-items:center;gap:6px;padding:5px 2px;border-bottom:1px solid rgba(255,255,255,.06);";
          const info = document.createElement("div");
          info.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;";
          info.title = f.original_filename;
          info.textContent = `${f.original_filename} — ${_formatLibraryDuration(f.duration_sec)}`;
          info.addEventListener("click", () => useLibraryFile(f.id, f.original_filename));
          const delBtn = document.createElement("button");
          delBtn.type = "button";
          delBtn.textContent = "🗑";
          delBtn.title = "Borrar de la librería";
          delBtn.style.cssText = "background:none;border:none;color:inherit;opacity:.6;cursor:pointer;flex-shrink:0;";
          delBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            if (!confirm(`¿Borrar "${f.original_filename}" de la librería?`)) return;
            await deleteLibraryFile(f.id);
          });
          row.appendChild(info);
          row.appendChild(delBtn);
          listEl.appendChild(row);
        }
      }

      async function uploadCurrentFileToLibrary(f) {
        try {
          const fd = new FormData();
          fd.append("file", f);
          const res = await fetch(`${API()}/library/upload`, { method: "POST", body: fd });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await refreshLibraryList();
        } catch (e) {
          // No es crítico para el flujo principal (mastering/preview siguen
          // funcionando con el archivo local) — solo se loguea.
          console.error("[librería] error al guardar:", e);
        }
      }

      async function useLibraryFile(fileId, filename) {
        const listEl = document.getElementById("libraryList");
        try {
          setPreviewStatus("Trayendo archivo de la librería…");
          const res = await fetch(`${API()}/library/${fileId}/download`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          const file = new File([blob], filename, { type: blob.type });
          setFile(file, fileId); // libraryId != null → no se vuelve a subir en el preview
        } catch (e) {
          console.error("[librería] error al usar archivo:", e);
          alert("No se pudo traer el archivo de la librería.");
        }
      }

      async function deleteLibraryFile(fileId) {
        try {
          const res = await fetch(`${API()}/library/${fileId}`, { method: "DELETE" });
          if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
          await refreshLibraryList();
        } catch (e) {
          console.error("[librería] error al borrar:", e);
        }
      }

      document.getElementById("btnRefreshLibrary")?.addEventListener("click", refreshLibraryList);
      refreshLibraryList();

      async function loadFileBuffer(f) {
        cachedFileBuffer = await f.arrayBuffer(); // cachear para reusar en previews
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        try {
          const buf = await ctx.decodeAudioData(cachedFileBuffer.slice(0));
          previewBufs.original = buf;
          drawWaveform(buf);
          computeAndCacheOriginalFFT(buf);
          setupLiveMeters(buf);
        } finally {
          ctx.close();
        }
      }

      // ── Referencia (track de referencia para matching) ──────────────────────────
      let selectedRefFile = null;
      const dropZoneRef = document.getElementById("dropZoneRef");
      const refFileInput = document.getElementById("refFileInput");
      dropZoneRef.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZoneRef.classList.add("dragover");
      });
      dropZoneRef.addEventListener("dragleave", () => dropZoneRef.classList.remove("dragover"));
      dropZoneRef.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZoneRef.classList.remove("dragover");
        if (e.dataTransfer.files[0]) setRefFile(e.dataTransfer.files[0]);
      });
      refFileInput.addEventListener("change", () => {
        if (refFileInput.files[0]) setRefFile(refFileInput.files[0]);
      });

      function setRefFile(f) {
        if (f.size > MAX_FILE_BYTES) {
          document.getElementById("refFileName").textContent =
            `⚠ Archivo de ${(f.size / 1024 / 1024).toFixed(1)} MB — máximo 200 MB`;
          return;
        }
        selectedRefFile = f;
        document.getElementById("refFileName").textContent = `${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`;
        updateRefButtonState();
      }
      function updateRefButtonState() {
        document.getElementById("btnMasterRef").disabled = !(selectedFile && selectedRefFile);
      }

      // ── EQ Curve ─────────────────────────────────────────────────────────────────
      function getEQParams() {
        const hp = parseFloat(document.getElementById("s-hp").value);
        const lpBypass = document.getElementById("s-lp-bypass")?.checked ?? true;
        const lp = lpBypass ? null : parseFloat(document.getElementById("s-lp-cutoff").value);
        const air = parseFloat(document.getElementById("s-air").value);
        const shelfFreq = parseFloat(document.getElementById("s-shelf-freq").value);
        const bands = [];
        for (let i = 1; i <= 6; i++) {
          bands.push({
            freq: parseFloat(document.getElementById(`s-eq${i}freq`).value),
            gain: parseFloat(document.getElementById(`s-eq${i}gain`).value),
            q: parseFloat(document.getElementById(`s-eq${i}q`).value),
          });
        }
        return { hp, lp, air, shelfFreq, bands };
      }

      function drawEQCurve() {
        const canvas = document.getElementById("eqCurveCanvas");
        const dpr = window.devicePixelRatio || 1;
        const W = canvas.clientWidth || 280,
          H = 140;
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const { surface2: bg, border: borderC, accent: accentC } = themeColors();
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);

        const { hp, lp, air, shelfFreq, bands } = getEQParams();
        const SR = 44100;

        function peakResponse(f, freq, gainDb, q) {
          if (gainDb === 0) return 0;
          const A = Math.pow(10, gainDb / 40);
          const w0 = (2 * Math.PI * freq) / SR;
          const alpha = Math.sin(w0) / (2 * q);
          const b0 = 1 + alpha * A,
            b1 = -2 * Math.cos(w0),
            b2 = 1 - alpha * A;
          const a0 = 1 + alpha / A,
            a1 = -2 * Math.cos(w0),
            a2 = 1 - alpha / A;
          const w = (2 * Math.PI * f) / SR;
          const cosW = Math.cos(w),
            sinW = Math.sin(w);
          const numR = b0 / a0 + (b1 / a0) * cosW + (b2 / a0) * Math.cos(2 * w);
          const numI = (b1 / a0) * sinW + (b2 / a0) * Math.sin(2 * w);
          const denR = 1 + (a1 / a0) * cosW + (a2 / a0) * Math.cos(2 * w);
          const denI = (a1 / a0) * sinW + (a2 / a0) * Math.sin(2 * w);
          const mag = Math.sqrt((numR * numR + numI * numI) / (denR * denR + denI * denI));
          return 20 * Math.log10(mag + 1e-12);
        }
        function hpResponse(f, cutoff) {
          if (f <= 0) return -100;
          const r = f / cutoff;
          return 20 * Math.log10((r * r) / (Math.sqrt(1 + r * r * r * r) + 1e-12) + 1e-12);
        }
        function lpResponse(f, cutoff) {
          if (!cutoff || f <= 0) return 0;
          const r = f / cutoff;
          return 20 * Math.log10(1 / (Math.sqrt(1 + r * r * r * r) + 1e-12) + 1e-12);
        }
        function highShelfResponse(f, cutoff, gainDb) {
          if (gainDb === 0) return 0;
          const A = Math.pow(10, gainDb / 40);
          const w0 = (2 * Math.PI * cutoff) / SR;
          const cos_w0 = Math.cos(w0),
            sin_w0 = Math.sin(w0);
          const alpha = (sin_w0 / 2) * Math.sqrt(2);
          const sqrtA = Math.sqrt(A);
          const b0 = A * (A + 1 + (A - 1) * cos_w0 + 2 * sqrtA * alpha);
          const b1 = -2 * A * (A - 1 + (A + 1) * cos_w0);
          const b2 = A * (A + 1 + (A - 1) * cos_w0 - 2 * sqrtA * alpha);
          const a0 = A + 1 - (A - 1) * cos_w0 + 2 * sqrtA * alpha;
          const a1 = 2 * (A - 1 - (A + 1) * cos_w0);
          const a2 = A + 1 - (A - 1) * cos_w0 - 2 * sqrtA * alpha;
          const w = (2 * Math.PI * f) / SR;
          const cosW = Math.cos(w),
            sinW = Math.sin(w);
          const numR = b0 / a0 + (b1 / a0) * cosW + (b2 / a0) * Math.cos(2 * w);
          const numI = (b1 / a0) * sinW + (b2 / a0) * Math.sin(2 * w);
          const denR = 1 + (a1 / a0) * cosW + (a2 / a0) * Math.cos(2 * w);
          const denI = (a1 / a0) * sinW + (a2 / a0) * Math.sin(2 * w);
          const mag = Math.sqrt((numR * numR + numI * numI) / (denR * denR + denI * denI));
          return 20 * Math.log10(mag + 1e-12);
        }

        const N = W;
        const freqs = [];
        for (let i = 0; i < N; i++) {
          freqs.push(Math.pow(10, Math.log10(20) + (i / (N - 1)) * (Math.log10(20000) - Math.log10(20))));
        }
        const gains = freqs.map((f) => {
          let g = hpResponse(f, hp);
          if (lp) g += lpResponse(f, lp);
          bands.forEach((b) => {
            g += peakResponse(f, b.freq, b.gain, b.q);
          });
          g += highShelfResponse(f, shelfFreq || 8000, air);
          return g;
        });
        const maxG = 18;
        const padL = 32,
          padT = 8,
          padB = 18,
          padR = 6;
        const plotW = W - padL - padR,
          plotH = H - padT - padB;
        const yOf = (g) => padT + plotH / 2 - (g / maxG) * (plotH / 2 - 2);
        const xOfFreq = (f) => padL + ((Math.log10(f) - Math.log10(20)) / (Math.log10(20000) - Math.log10(20))) * plotW;

        // Grid horizontal (dB)
        ctx.font = "9px monospace";
        [-18, -12, -6, 0, 6, 12, 18].forEach((db) => {
          const y = yOf(db);
          ctx.beginPath();
          ctx.moveTo(padL, y);
          ctx.lineTo(padL + plotW, y);
          ctx.strokeStyle = db === 0 ? "rgba(139,108,255,.35)" : borderC;
          ctx.lineWidth = db === 0 ? 1 : 0.5;
          ctx.stroke();
          ctx.fillStyle = db === 0 ? accentC : "#6b678a";
          ctx.fillText((db >= 0 ? "+" : "") + db, 2, y + 3);
        });

        // Grid vertical (freq)
        [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].forEach((f) => {
          const x = xOfFreq(f);
          if (x < padL || x > padL + plotW) return;
          ctx.beginPath();
          ctx.moveTo(x, padT);
          ctx.lineTo(x, padT + plotH);
          ctx.strokeStyle = borderC;
          ctx.lineWidth = 0.5;
          ctx.stroke();
          const lbl = f >= 1000 ? f / 1000 + "k" : String(f);
          ctx.fillStyle = "#6b678a";
          ctx.font = "8px monospace";
          ctx.fillText(lbl, x - 8, H - 4);
        });

        // Curve
        const curvePoints = gains.map((g, i) => {
          const f = freqs[i];
          return [
            padL + ((Math.log10(f) - Math.log10(20)) / (Math.log10(20000) - Math.log10(20))) * plotW,
            Math.max(padT + 2, Math.min(padT + plotH - 2, yOf(g))),
          ];
        });
        // Fill under curve
        ctx.beginPath();
        curvePoints.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.lineTo(curvePoints[curvePoints.length - 1][0], yOf(0));
        ctx.lineTo(curvePoints[0][0], yOf(0));
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
        grad.addColorStop(0, "rgba(139,108,255,.25)");
        grad.addColorStop(1, "rgba(139,108,255,.03)");
        ctx.fillStyle = grad;
        ctx.fill();
        // Stroke
        ctx.beginPath();
        curvePoints.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.strokeStyle = accentC;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Throttle: un solo repintado por frame aunque varios sliders disparen a la vez
      let _eqRafPending = false;
      function scheduleEQCurve() {
        if (_eqRafPending) return;
        _eqRafPending = true;
        requestAnimationFrame(() => {
          _eqRafPending = false;
          drawEQCurve();
        });
      }
      [
        "s-hp",
        "s-lp-cutoff",
        "s-eq1freq",
        "s-eq1gain",
        "s-eq1q",
        "s-eq2freq",
        "s-eq2gain",
        "s-eq2q",
        "s-eq3freq",
        "s-eq3gain",
        "s-eq3q",
        "s-eq4freq",
        "s-eq4gain",
        "s-eq4q",
        "s-eq5freq",
        "s-eq5gain",
        "s-eq5q",
        "s-eq6freq",
        "s-eq6gain",
        "s-eq6q",
        "s-air",
        "s-shelf-freq",
      ].forEach((id) => {
        document.getElementById(id)?.addEventListener("input", scheduleEQCurve);
      });
      document.getElementById("s-lp-bypass")?.addEventListener("change", scheduleEQCurve);
      drawEQCurve();

      // ── Waveform ────────────────────────────────────────────────────────────────
      function drawWaveform(audioBuffer) {
        const container = document.getElementById("content");
        let wrap = document.getElementById("waveformWrap");
        if (!wrap) {
          wrap = document.createElement("div");
          wrap.id = "waveformWrap";
          wrap.className = "waveform-wrap";
          wrap.innerHTML = `<h3>Waveform <span style="color:var(--muted);font-size:.7rem;font-weight:400;font-family:var(--mono)">${audioBuffer.duration.toFixed(1)}s · ${audioBuffer.sampleRate}Hz · ${audioBuffer.numberOfChannels}ch</span></h3><canvas id="waveformCanvas"></canvas><div class="waveform-legend"><span style="color:var(--muted)">■</span> Original&nbsp;&nbsp;<span style="color:var(--accent)">■</span> Masterizado</div>`;
          container.prepend(wrap);
        }
        const canvas = document.getElementById("waveformCanvas");
        renderWaveformToCanvas(canvas, audioBuffer, "var(--muted)");
      }

      function renderWaveformToCanvas(canvas, audioBuffer, color = "var(--accent)", alpha = 1) {
        const dpr = window.devicePixelRatio || 1;
        const W = canvas.clientWidth || 600,
          H = 100;
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const theme = themeColors();
        ctx.fillStyle = theme.surface2;
        ctx.fillRect(0, 0, W, H);
        const data = audioBuffer.getChannelData(0);
        const step = Math.ceil(data.length / W);
        const resolvedColor = color.startsWith("var(") ? theme.get(color.slice(4, -1)) : color;
        ctx.strokeStyle = resolvedColor;
        ctx.lineWidth = 1;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        for (let i = 0; i < W; i++) {
          let min = 1,
            max = -1;
          for (let j = 0; j < step; j++) {
            const v = data[i * step + j] || 0;
            if (v < min) min = v;
            if (v > max) max = v;
          }
          const yMin = (1 - (min + 1) / 2) * H,
            yMax = (1 - (max + 1) / 2) * H;
          if (i === 0) ctx.moveTo(i, yMin);
          else ctx.lineTo(i, yMin);
          ctx.lineTo(i, yMax);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // ── Loudness meter ──────────────────────────────────────────────────────────
      function showLoudnessMeter(lufsValue) {
        let wrap = document.getElementById("loudnessMeterWrap");
        if (!wrap) {
          wrap = document.createElement("div");
          wrap.id = "loudnessMeterWrap";
          wrap.className = "loudness-meter";
          wrap.innerHTML = `<h3>Loudness Meter (LUFS)</h3><div class="lufs-display"><div><div class="lufs-number" id="lufsNumber">---</div><div class="lufs-label">LUFS integrado</div></div><div style="flex:1"><div class="lufs-bar-track"><div class="lufs-bar-fill" id="lufsBarFill"></div></div><div class="lufs-zones"><span>-40</span><span>-24</span><span>-18</span><span>-14</span><span>-9</span><span>-6</span><span>0</span></div></div></div><div style="font-size:.75rem;color:var(--muted);font-family:var(--mono)" id="lufsTarget">Target Spotify/YouTube: -14 LUFS · Club: -9 LUFS</div>`;
          document.getElementById("content").prepend(wrap);
        }
        document.getElementById("lufsNumber").textContent = lufsValue.toFixed(1);
        const pct = Math.max(0, Math.min(100, ((lufsValue + 40) / 40) * 100));
        const fill = document.getElementById("lufsBarFill");
        fill.style.width = pct + "%";
        fill.style.background =
          lufsValue > -6
            ? "var(--red)"
            : lufsValue > -9
              ? "var(--yellow)"
              : lufsValue >= -18
                ? "var(--green)"
                : "var(--muted)";
      }

      // ── Params builder ──────────────────────────────────────────────────────────
      function collectMasterParamsObj() {
        const platform = document.getElementById("s-platform").value;
        const obj = {
          input_gain_db: document.getElementById("s-ingain").value,
          target_peak: document.getElementById("s-peak").value,
          use_lufs_normalize: document.getElementById("s-uselufs").checked,
          target_lufs: document.getElementById("s-lufstarget").value,
          comp_threshold_db: document.getElementById("s-thresh").value,
          comp_ratio: document.getElementById("s-ratio").value,
          comp_attack_ms: document.getElementById("s-cattack").value,
          comp_release_ms: document.getElementById("s-crelease").value,
          comp_makeup_db: document.getElementById("s-cmakeup").value,
          comp_stereo_link: document.getElementById("s-comp-link").checked,
          oversample_mode: document.getElementById("s-oversample").value,
          nr_bypass: document.getElementById("s-nr-bypass").checked,
          nr_strength: document.getElementById("s-nr-strength").value,
          nr_noise_sample_sec: document.getElementById("s-nr-noise-sample-sec").value,
          glue_bypass: document.getElementById("s-glue-bypass").checked,
          glue_threshold_db: document.getElementById("s-glue-thresh").value,
          glue_ratio: document.getElementById("s-glue-ratio").value,
          glue_attack_ms: document.getElementById("s-glue-attack").value,
          glue_release_ms: document.getElementById("s-glue-release").value,
          glue_makeup_db: document.getElementById("s-glue-makeup").value,
          clipper_bypass: document.getElementById("s-clip-bypass").checked,
          clipper_mode: document.getElementById("s-clip-mode").value,
          clipper_ceiling: document.getElementById("s-clip-ceiling").value,
          clipper_drive_db: document.getElementById("s-clip-drive").value,
          hp_cutoff: document.getElementById("s-hp").value,
          lp_bypass: document.getElementById("s-lp-bypass").checked,
          lp_cutoff: document.getElementById("s-lp-cutoff").value,
          high_shelf_gain_db: document.getElementById("s-air").value,
          high_shelf_freq_hz: document.getElementById("s-shelf-freq").value,
          eq1_freq: document.getElementById("s-eq1freq").value,
          eq1_gain: document.getElementById("s-eq1gain").value,
          eq1_q: document.getElementById("s-eq1q").value,
          eq2_freq: document.getElementById("s-eq2freq").value,
          eq2_gain: document.getElementById("s-eq2gain").value,
          eq2_q: document.getElementById("s-eq2q").value,
          eq3_freq: document.getElementById("s-eq3freq").value,
          eq3_gain: document.getElementById("s-eq3gain").value,
          eq3_q: document.getElementById("s-eq3q").value,
          eq4_freq: document.getElementById("s-eq4freq").value,
          eq4_gain: document.getElementById("s-eq4gain").value,
          eq4_q: document.getElementById("s-eq4q").value,
          eq5_freq: document.getElementById("s-eq5freq").value,
          eq5_gain: document.getElementById("s-eq5gain").value,
          eq5_q: document.getElementById("s-eq5q").value,
          eq6_freq: document.getElementById("s-eq6freq").value,
          eq6_gain: document.getElementById("s-eq6gain").value,
          eq6_q: document.getElementById("s-eq6q").value,
          transient_attack: document.getElementById("s-tatt").value,
          transient_sustain: document.getElementById("s-tsus").value,
          saturation_drive: document.getElementById("s-satdrive").value,
          saturation_mode: document.getElementById("s-satmode").value,
          saturation_mix: document.getElementById("s-satmix").value,
          mid_gain_db: document.getElementById("s-mgain").value,
          side_gain_db: document.getElementById("s-sgain").value,
          stereo_width_amount: document.getElementById("s-width").value,
          use_stereo_enhancer: document.getElementById("s-enhancer").checked,
          haas_delay_ms: document.getElementById("s-haas").value,
          enhancer_bass_mono_freq: document.getElementById("s-bassmono").value,
          reverb_size: document.getElementById("s-rsize").value,
          reverb_wet: document.getElementById("s-rwet").value,
          limiter_ceiling: document.getElementById("s-ceiling").value,
          limiter_release_ms: document.getElementById("s-lrelease").value,
          output_format: document.getElementById("s-format").value,
          output_bit_depth: document.getElementById("s-bitdepth").value,
          // multiband
          mb_low_crossover: document.getElementById("s-mb-lowx").value,
          mb_high_crossover: document.getElementById("s-mb-highx").value,
          mb_low_threshold_db: document.getElementById("s-mb-low-th").value,
          mb_low_ratio: document.getElementById("s-mb-low-ratio").value,
          mb_low_attack_ms: document.getElementById("s-mb-low-att").value,
          mb_low_release_ms: document.getElementById("s-mb-low-rel").value,
          mb_low_makeup_db: document.getElementById("s-mb-low-mu").value,
          mb_mid_threshold_db: document.getElementById("s-mb-mid-th").value,
          mb_mid_ratio: document.getElementById("s-mb-mid-ratio").value,
          mb_mid_attack_ms: document.getElementById("s-mb-mid-att").value,
          mb_mid_release_ms: document.getElementById("s-mb-mid-rel").value,
          mb_mid_makeup_db: document.getElementById("s-mb-mid-mu").value,
          mb_high_threshold_db: document.getElementById("s-mb-high-th").value,
          mb_high_ratio: document.getElementById("s-mb-high-ratio").value,
          mb_high_attack_ms: document.getElementById("s-mb-high-att").value,
          mb_high_release_ms: document.getElementById("s-mb-high-rel").value,
          mb_high_makeup_db: document.getElementById("s-mb-high-mu").value,
          mb_bypass: document.getElementById("mb-bypass").checked,
          // Multiband Stereo Width
          mb_stereo_bypass: document.getElementById("mb-stereo-bypass").checked,
          mb_stereo_low_width: document.getElementById("s-mb-sw-low").value,
          mb_stereo_mid_width: document.getElementById("s-mb-sw-mid").value,
          mb_stereo_high_width: document.getElementById("s-mb-sw-high").value,
          mb_stereo_low_crossover: document.getElementById("s-mb-sw-lowx").value,
          mb_stereo_high_crossover: document.getElementById("s-mb-sw-highx").value,
        };
        // Dynamic EQ
        obj.parallel_bypass = document.getElementById("parallelBypass").checked;
        obj.parallel_mix = document.getElementById("parallelMix").value;
        obj.parallel_threshold_db = document.getElementById("parallelThresh").value;
        obj.parallel_ratio = document.getElementById("parallelRatio").value;
        obj.parallel_attack_ms = document.getElementById("parallelAttack").value;
        obj.parallel_release_ms = document.getElementById("parallelRelease").value;
        obj.ms_eq_bypass = document.getElementById("s-mseq-bypass").checked;
        obj.ms_mid_freq = document.getElementById("s-mseq-mid-freq").value;
        obj.ms_mid_gain = document.getElementById("s-mseq-mid-gain").value;
        obj.ms_mid_q = document.getElementById("s-mseq-mid-q").value;
        obj.ms_side_freq = document.getElementById("s-mseq-side-freq").value;
        obj.ms_side_gain = document.getElementById("s-mseq-side-gain").value;
        obj.ms_side_q = document.getElementById("s-mseq-side-q").value;
        obj.ms_comp_bypass = document.getElementById("s-mscomp-bypass").checked;
        obj.ms_comp_mid_threshold_db = document.getElementById("s-mscomp-mid-thresh").value;
        obj.ms_comp_mid_ratio = document.getElementById("s-mscomp-mid-ratio").value;
        obj.ms_comp_mid_attack_ms = document.getElementById("s-mscomp-mid-attack").value;
        obj.ms_comp_mid_release_ms = document.getElementById("s-mscomp-mid-release").value;
        obj.ms_comp_mid_makeup_db = document.getElementById("s-mscomp-mid-makeup").value;
        obj.ms_comp_side_threshold_db = document.getElementById("s-mscomp-side-thresh").value;
        obj.ms_comp_side_ratio = document.getElementById("s-mscomp-side-ratio").value;
        obj.ms_comp_side_attack_ms = document.getElementById("s-mscomp-side-attack").value;
        obj.ms_comp_side_release_ms = document.getElementById("s-mscomp-side-release").value;
        obj.ms_comp_side_makeup_db = document.getElementById("s-mscomp-side-makeup").value;
        obj.dyneq_bypass = document.getElementById("s-dyneq-bypass").checked;
        obj.dyneq_freq = document.getElementById("s-dyneq-freq").value;
        obj.dyneq_q = document.getElementById("s-dyneq-q").value;
        obj.dyneq_threshold_db = document.getElementById("s-dyneq-thresh").value;
        obj.dyneq_ratio = document.getElementById("s-dyneq-ratio").value;
        obj.dyneq_attack_ms = document.getElementById("s-dyneq-attack").value;
        obj.dyneq_release_ms = document.getElementById("s-dyneq-release").value;
        obj.dyneq_max_reduction_db = document.getElementById("s-dyneq-maxred").value;
        // Dynamic EQ — banda de resonancias (etapa 3)
        obj.reso_bypass = document.getElementById("s-reso-bypass").checked;
        obj.reso_freq = document.getElementById("s-reso-freq").value;
        obj.reso_q = document.getElementById("s-reso-q").value;
        obj.reso_threshold_db = document.getElementById("s-reso-thresh").value;
        obj.reso_ratio = document.getElementById("s-reso-ratio").value;
        obj.reso_attack_ms = document.getElementById("s-reso-attack").value;
        obj.reso_release_ms = document.getElementById("s-reso-release").value;
        obj.reso_max_reduction_db = document.getElementById("s-reso-maxred").value;
        // Low-End Mono Maker
        obj.low_end_mono_freq = document.getElementById("s-mono-freq").value;
        obj.low_end_mono_amount = document.getElementById("s-mono-amount").value;
        // EQ Mode
        obj.eq_mode = document.getElementById("s-eq-mode").value;
        obj.linear_phase_taps = document.getElementById("s-lp-taps").value;
        const platformTargetVal = document.getElementById("s-platform")?.value || "";
        if (platformTargetVal) obj.platform_target = platformTargetVal;
        return obj;
      }
      function buildParams() {
        const obj = collectMasterParamsObj();
        // URLSearchParams convierte null/undefined en el string literal "null"/"undefined",
        // lo cual rompe la validación de FastAPI (pattern regex). Se filtran esos valores
        // para que el backend reciba el parámetro directamente omitido y use su default.
        Object.keys(obj).forEach((k) => {
          if (obj[k] === null || obj[k] === undefined) delete obj[k];
        });
        return new URLSearchParams(obj);
      }

      // ── Vista previa de parámetros corregidos antes de masterizar ───────────────
      const PARAM_PREVIEW_GROUPS = [
        {
          title: "Entrada / Loudness",
          keys: ["input_gain_db", "target_peak", "use_lufs_normalize", "target_lufs", "platform_target"],
        },
        {
          title: "Compresor",
          keys: [
            "comp_threshold_db",
            "comp_ratio",
            "comp_attack_ms",
            "comp_release_ms",
            "comp_makeup_db",
            "comp_stereo_link",
            "oversample_mode",
          ],
        },
        {
          title: "EQ",
          keys: [
            "hp_cutoff",
            "high_shelf_gain_db",
            "high_shelf_freq_hz",
            "eq1_freq",
            "eq1_gain",
            "eq1_q",
            "eq2_freq",
            "eq2_gain",
            "eq2_q",
            "eq3_freq",
            "eq3_gain",
            "eq3_q",
            "eq4_freq",
            "eq4_gain",
            "eq4_q",
            "eq5_freq",
            "eq5_gain",
            "eq5_q",
            "eq6_freq",
            "eq6_gain",
            "eq6_q",
          ],
        },
        {
          title: "Transient / Saturación",
          keys: ["transient_attack", "transient_sustain", "saturation_drive", "saturation_mode", "saturation_mix"],
        },
        {
          title: "Estéreo",
          keys: [
            "mid_gain_db",
            "side_gain_db",
            "stereo_width_amount",
            "use_stereo_enhancer",
            "haas_delay_ms",
            "enhancer_bass_mono_freq",
          ],
        },
        {
          title: "Glue Compressor",
          keys: [
            "glue_bypass",
            "glue_threshold_db",
            "glue_ratio",
            "glue_attack_ms",
            "glue_release_ms",
            "glue_makeup_db",
          ],
        },
        {
          title: "Reverb / Limiter / Salida",
          keys: [
            "reverb_size",
            "reverb_wet",
            "limiter_ceiling",
            "limiter_release_ms",
            "output_format",
            "output_bit_depth",
          ],
        },
        {
          title: "Multibanda — Compresión",
          keys: [
            "mb_bypass",
            "mb_low_crossover",
            "mb_high_crossover",
            "mb_low_threshold_db",
            "mb_low_ratio",
            "mb_low_attack_ms",
            "mb_low_release_ms",
            "mb_low_makeup_db",
            "mb_mid_threshold_db",
            "mb_mid_ratio",
            "mb_mid_attack_ms",
            "mb_mid_release_ms",
            "mb_mid_makeup_db",
            "mb_high_threshold_db",
            "mb_high_ratio",
            "mb_high_attack_ms",
            "mb_high_release_ms",
            "mb_high_makeup_db",
          ],
        },
        {
          title: "Multibanda — Ancho estéreo",
          keys: [
            "mb_stereo_bypass",
            "mb_stereo_low_width",
            "mb_stereo_mid_width",
            "mb_stereo_high_width",
            "mb_stereo_low_crossover",
            "mb_stereo_high_crossover",
          ],
        },
        {
          title: "Dynamic EQ / De-esser",
          keys: [
            "dyneq_bypass",
            "dyneq_freq",
            "dyneq_q",
            "dyneq_threshold_db",
            "dyneq_ratio",
            "dyneq_attack_ms",
            "dyneq_release_ms",
            "dyneq_max_reduction_db",
          ],
        },
        {
          title: "Dynamic EQ / Resonancias",
          keys: [
            "reso_bypass",
            "reso_freq",
            "reso_q",
            "reso_threshold_db",
            "reso_ratio",
            "reso_attack_ms",
            "reso_release_ms",
            "reso_max_reduction_db",
          ],
        },
        { title: "Low-End Mono Maker", keys: ["low_end_mono_freq", "low_end_mono_amount"] },
        {
          title: "EQ Mid/Side",
          keys: [
            "ms_eq_bypass", "ms_mid_freq", "ms_mid_gain", "ms_mid_q", "ms_side_freq", "ms_side_gain", "ms_side_q",
            "ms_comp_bypass",
            "ms_comp_mid_threshold_db", "ms_comp_mid_ratio", "ms_comp_mid_attack_ms",
            "ms_comp_mid_release_ms", "ms_comp_mid_makeup_db",
            "ms_comp_side_threshold_db", "ms_comp_side_ratio", "ms_comp_side_attack_ms",
            "ms_comp_side_release_ms", "ms_comp_side_makeup_db",
          ],
        },
        { title: "Modo EQ", keys: ["eq_mode", "linear_phase_taps"] },
      ];
      const PARAM_LABELS = {
        input_gain_db: "Ganancia entrada (dB)",
        target_peak: "Peak objetivo",
        use_lufs_normalize: "Normalizar LUFS",
        target_lufs: "LUFS objetivo",
        platform_target: "Plataforma",
        comp_threshold_db: "Threshold (dB)",
        comp_ratio: "Ratio",
        comp_attack_ms: "Attack",
        comp_release_ms: "Release",
        comp_makeup_db: "Makeup",
        comp_stereo_link: "Stereo link L/R",
        oversample_mode: "Oversampling",
        hp_cutoff: "High-pass (Hz)",
        high_shelf_gain_db: "Shelf ganancia (dB)",
        high_shelf_freq_hz: "Shelf freq (Hz)",
        eq1_freq: "EQ1 freq",
        eq1_gain: "EQ1 ganancia",
        eq1_q: "EQ1 Q",
        eq2_freq: "EQ2 freq",
        eq2_gain: "EQ2 ganancia",
        eq2_q: "EQ2 Q",
        eq3_freq: "EQ3 freq",
        eq3_gain: "EQ3 ganancia",
        eq3_q: "EQ3 Q",
        eq4_freq: "EQ4 freq",
        eq4_gain: "EQ4 ganancia",
        eq4_q: "EQ4 Q",
        eq5_freq: "EQ5 freq",
        eq5_gain: "EQ5 ganancia",
        eq5_q: "EQ5 Q",
        eq6_freq: "EQ6 freq",
        eq6_gain: "EQ6 ganancia",
        eq6_q: "EQ6 Q",
        transient_attack: "Transient attack",
        transient_sustain: "Transient sustain",
        saturation_drive: "Saturación drive",
        saturation_mode: "Saturación modo",
        saturation_mix: "Saturación mix",
        mid_gain_db: "Mid gain (dB)",
        side_gain_db: "Side gain (dB)",
        stereo_width_amount: "Ancho estéreo",
        use_stereo_enhancer: "Stereo enhancer",
        haas_delay_ms: "Haas delay (ms)",
        enhancer_bass_mono_freq: "Bass mono freq",
        nr_bypass: "Bypass noise reduction",
        nr_strength: "Intensidad NR",
        nr_noise_sample_sec: "Muestra ruido (s)",
        glue_bypass: "Bypass glue",
        glue_threshold_db: "Threshold (dB)",
        glue_ratio: "Ratio",
        glue_attack_ms: "Attack",
        glue_release_ms: "Release",
        glue_makeup_db: "Makeup",
        reverb_size: "Reverb tamaño",
        reverb_wet: "Reverb wet",
        limiter_ceiling: "Limiter ceiling",
        limiter_release_ms: "Limiter release (ms)",
        output_format: "Formato salida",
        output_bit_depth: "Bit depth",
        mb_bypass: "Bypass multibanda",
        mb_low_crossover: "Cruce low (Hz)",
        mb_high_crossover: "Cruce high (Hz)",
        mb_low_threshold_db: "Low threshold (dB)",
        mb_low_ratio: "Low ratio",
        mb_low_attack_ms: "Low attack",
        mb_low_release_ms: "Low release",
        mb_low_makeup_db: "Low makeup",
        mb_mid_threshold_db: "Mid threshold (dB)",
        mb_mid_ratio: "Mid ratio",
        mb_mid_attack_ms: "Mid attack",
        mb_mid_release_ms: "Mid release",
        mb_mid_makeup_db: "Mid makeup",
        mb_high_threshold_db: "High threshold (dB)",
        mb_high_ratio: "High ratio",
        mb_high_attack_ms: "High attack",
        mb_high_release_ms: "High release",
        mb_high_makeup_db: "High makeup",
        mb_stereo_bypass: "Bypass ancho MB",
        mb_stereo_low_width: "Ancho low",
        mb_stereo_mid_width: "Ancho mid",
        mb_stereo_high_width: "Ancho high",
        dyneq_bypass: "Bypass Dynamic EQ",
        dyneq_freq: "Freq (Hz)",
        dyneq_q: "Q",
        dyneq_threshold_db: "Threshold (dB)",
        dyneq_ratio: "Ratio",
        dyneq_attack_ms: "Attack (ms)",
        dyneq_release_ms: "Release (ms)",
        dyneq_max_reduction_db: "Reducción máx. (dB)",
        reso_bypass: "Bypass Resonancias",
        reso_freq: "Freq (Hz)",
        reso_q: "Q",
        reso_threshold_db: "Threshold (dB)",
        reso_ratio: "Ratio",
        reso_attack_ms: "Attack (ms)",
        reso_release_ms: "Release (ms)",
        reso_max_reduction_db: "Reducción máx. (dB)",
        low_end_mono_freq: "Corte mono (Hz)",
        low_end_mono_amount: "Cantidad mono",
        ms_eq_bypass: "Bypass EQ M/S",
        ms_mid_freq: "Mid freq (Hz)",
        ms_mid_gain: "Mid ganancia",
        ms_mid_q: "Mid Q",
        ms_side_freq: "Side freq (Hz)",
        ms_side_gain: "Side ganancia",
        ms_side_q: "Side Q",
        ms_comp_bypass: "Bypass Comp M/S",
        ms_comp_mid_threshold_db: "Mid threshold (dB)",
        ms_comp_mid_ratio: "Mid ratio",
        ms_comp_mid_attack_ms: "Mid attack",
        ms_comp_mid_release_ms: "Mid release",
        ms_comp_mid_makeup_db: "Mid makeup",
        ms_comp_side_threshold_db: "Side threshold (dB)",
        ms_comp_side_ratio: "Side ratio",
        ms_comp_side_attack_ms: "Side attack",
        ms_comp_side_release_ms: "Side release",
        ms_comp_side_makeup_db: "Side makeup",
        eq_mode: "Modo EQ",
        linear_phase_taps: "FIR Taps",
        mb_stereo_low_crossover: "Cruce low (Hz)",
        mb_stereo_high_crossover: "Cruce high (Hz)",
      };
      function formatParamValue(v, key) {
        const n = parseFloat(v);
        if (key && key.includes("ratio") && !Number.isNaN(n)) return `Ratio ${n.toFixed(1)}:1`;
        if (key && key.includes("threshold_db") && !Number.isNaN(n)) return `Threshold ${formatDbValue(n)}`;
        if (key && key.includes("attack_ms") && !Number.isNaN(n)) return `Attack ${n.toFixed(1)} ms`;
        if (key && key.includes("release_ms") && !Number.isNaN(n)) return `Release ${Math.round(n)} ms`;
        if (key && key.includes("makeup_db") && !Number.isNaN(n))
          return `Makeup ${n >= 0 ? "+" : ""}${n.toFixed(1)} dB`;
        if (v === true) return "Sí";
        if (v === false) return "No";
        if (v === "" || v == null) return "—";
        return v;
      }
      function renderParamsPreview(
        paramsObj,
        {
          onConfirm,
          onCancel,
          confirmLabel = "✅ Confirmar y masterizar",
          readOnly = false,
          title = "🔎 Parámetros corregidos — revisá antes de masterizar",
        } = {},
      ) {
        const panel = document.createElement("div");
        panel.className = "params-preview";
        let html = `<h3>${title}</h3>`;
        PARAM_PREVIEW_GROUPS.forEach((group) => {
          const items = group.keys.filter((k) => paramsObj[k] !== undefined);
          if (!items.length) return;
          html += `<div class="pp-group"><div class="pp-group-title">${group.title}</div><div class="pp-grid">`;
          items.forEach((k) => {
            html += `<div class="pp-item"><span>${PARAM_LABELS[k] || k}</span><span>${formatParamValue(paramsObj[k], k)}</span></div>`;
          });
          html += `</div></div>`;
        });
        if (!readOnly) {
          html += `<div class="pp-actions">
      <button class="btn btn-secondary" id="ppCancelBtn">✕ Cancelar</button>
      <button class="btn btn-primary" id="ppConfirmBtn">${confirmLabel}</button>
    </div>`;
        }
        panel.innerHTML = html;
        getContent().prepend(panel);
        if (!readOnly) {
          panel.querySelector("#ppConfirmBtn").addEventListener("click", () => {
            panel.remove();
            onConfirm && onConfirm();
          });
          panel.querySelector("#ppCancelBtn").addEventListener("click", () => {
            panel.remove();
            onCancel && onCancel();
          });
        }
        return panel;
      }

      // ── Analysis / Mastering / etc ──────────────────────────────────────────────
      function getContent() {
        return document.getElementById("content");
      }
      function clearResults() {
        const c = getContent();
        c.querySelectorAll(
          ".status-bar,.analysis-grid,.spectrum-wrap,.fft-wrap,.advice-panel,.ab-wrap,.loudness-meter,.professional-meter,.waveform-wrap,.ref-match-panel,.stems-wrap",
        ).forEach((el) => el.remove());
      }
      function showStatus(id, text, state, progress, stage) {
        let bar = document.getElementById("statusBar");
        if (!bar) {
          bar = document.createElement("div");
          bar.className = "status-bar";
          bar.id = "statusBar";
          bar.innerHTML = `
      <div class="status-bar-top">
        <div class="status-dot" id="statusDot"></div>
        <span class="status-text" id="statusText"></span>
        <span class="progress-pct" id="progressPct"></span>
        <span class="status-time" id="statusTime"></span>
      </div>
      <div class="progress-wrap" id="progressWrap"><div class="progress-bar" id="progressBar"></div></div>`;
          getContent().prepend(bar);
        }
        const active = state === "processing" || state === "queued";
        document.getElementById("statusDot").className = "status-dot " + state;
        document.getElementById("statusText").textContent = stage ? `${text} — ${stage}` : text;

        const wrap = document.getElementById("progressWrap");
        const pbar = document.getElementById("progressBar");
        const pct = document.getElementById("progressPct");
        wrap.style.display = active ? "block" : "none";

        if (active && typeof progress === "number" && !isNaN(progress)) {
          // Progreso real reportado por el backend (etapa a etapa de la cadena DSP).
          pbar.classList.remove("indeterminate");
          pbar.style.width = Math.max(0, Math.min(100, progress)) + "%";
          pct.textContent = Math.round(progress) + "%";
        } else if (active) {
          // Todavía sin dato de progreso (por ejemplo justo al encolar el job).
          pbar.classList.add("indeterminate");
          pbar.style.width = "";
          pct.textContent = "";
        } else {
          pbar.classList.remove("indeterminate");
          pct.textContent = "";
        }
      }

      // ── MASTER (corregido) ──────────────────────────────────────────────────────
      async function submitMasterJob() {
        clearResults();
        showStatus(null, "Enviando archivo…", "queued");
        document.getElementById("btnMaster").disabled = true;

        const fd = new FormData();
        // Si el archivo vino de la librería del servidor, mandamos library_id
        // en vez de volver a subir los bytes — el backend lo lee directo de
        // su disco. Si es un archivo local nuevo, se sube como siempre.
        if (_previewLibraryId) {
          fd.append("library_id", _previewLibraryId);
        } else {
          fd.append("file", selectedFile);
        }

        try {
          const params = buildParams();
          const url = `${API()}/master?${params.toString()}`;
          console.log("📤 Enviando a:", url);
          console.log("📁 Archivo:", selectedFile.name, selectedFile.size, "bytes");
          const res = await fetch(url, { method: "POST", body: fd });
          console.log("📥 Respuesta:", res.status, res.statusText);
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
          }
          const data = await res.json();
          currentJobId = data.job_id;
          showStatus(null, `Job ${currentJobId.slice(0, 8)}… en cola`, "queued");
          startPolling(currentJobId);
        } catch (e) {
          console.error("❌ Error al enviar:", e);
          showStatus(null, "Error: " + e.message, "error");
          document.getElementById("btnMaster").disabled = false;
        }
      }

      document.getElementById("btnMaster").addEventListener("click", () => {
        if (!selectedFile) {
          showStatus(null, "Selecciona un archivo primero", "error");
          return;
        }
        clearResults();
        const paramsObj = collectMasterParamsObj();
        renderParamsPreview(paramsObj, { onConfirm: submitMasterJob });
      });

      // Master (enqueue) from Paso 1 — reuses existing submitMasterJob flow
      document.getElementById("btnMasterAsync").addEventListener("click", () => {
        document.getElementById("btnMaster").click();
      });

      // Master (sync) — immediate processing and download
      async function submitMasterSync() {
        if (!selectedFile) {
          showStatus(null, "Selecciona un archivo primero", "error");
          return;
        }
        clearResults();
        showStatus(null, "Procesando (sync)…", "processing");
        const fd = new FormData();
        if (_previewLibraryId) fd.append("library_id", _previewLibraryId);
        else fd.append("file", selectedFile);
        try {
          const params = buildParams();
          const url = `${API()}/master/sync?${params.toString()}`;
          const res = await fetch(url, { method: "POST", body: fd });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
          }
          const blob = await res.blob();
          let filename = "mastered.wav";
          const cd = res.headers.get("content-disposition");
          if (cd) {
            const m = cd.match(/filename\*=UTF-8''([^;]+)/) || cd.match(/filename=\"?([^\";]+)\"?/);
            if (m) filename = decodeURIComponent(m[1]);
          }
          const link = document.createElement("a");
          link.href = URL.createObjectURL(blob);
          link.download = filename;
          document.body.appendChild(link);
          link.click();
          link.remove();
          showStatus(null, "Master sync completado ✓", "done");
        } catch (e) {
          console.error("Error en master sync:", e);
          showStatus(null, "Error: " + e.message, "error");
        }
      }

      document.getElementById("btnMasterSync").addEventListener("click", async () => {
        if (!selectedFile) {
          showStatus(null, "Selecciona un archivo primero", "error");
          return;
        }
        clearResults();
        const paramsObj = collectMasterParamsObj();
        renderParamsPreview(paramsObj, { onConfirm: submitMasterSync, confirmLabel: "Master (descarga)" });
      });

      // ── AUTO-MASTERING IA (la IA decide todo y encola el job) ───────────────────
      document.getElementById("btnAutoMaster").addEventListener("click", async () => {
        if (!selectedFile) {
          showStatus(null, "Selecciona un archivo primero", "error");
          return;
        }
        clearResults();
        showStatus(null, "🤖 La IA está analizando tu track…", "processing");
        const autoBtn = document.getElementById("btnAutoMaster");
        const masterBtn = document.getElementById("btnMaster");
        autoBtn.disabled = true;
        masterBtn.disabled = true;

        // Abrimos el panel del asistente para mostrar en vivo qué está decidiendo.
        const panel = aiEl("aiPanel");
        if (!panel.classList.contains("open")) panel.classList.add("open");
        aiEl("aiSuggestions").innerHTML = "";
        aiShowTyping();

        const fd = new FormData();
        fd.append("file", selectedFile);
        try {
          const fmt = document.getElementById("s-format") ? document.getElementById("s-format").value : "wav";
          const params = new URLSearchParams({ output_format: fmt });
          const res = await fetch(`${API()}/ai/auto-master?${params}`, { method: "POST", body: fd });
          aiHideTyping();
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
          }
          const data = await res.json();
          currentJobId = data.job_id;
          setAiContext(data.analysis);

          const d = data.ai_decision || {};
          const platformLabel = d.platform ? d.platform : "sin target específico";
          aiAppendMessage(
            "assistant",
            `🤖 Auto-Mastering en marcha — la IA calculó los parámetros a medida de este track (no usó un preset fijo).\nPlataforma: ${platformLabel}` +
              (d.reasoning ? `\n\n${d.reasoning}` : ""),
          );
          // Vista informativa de todos los parámetros que la IA calculó para este track.
          const { platform, reasoning, ...aiParams } = d;
          if (Object.keys(aiParams).length) {
            renderParamsPreview(aiParams, {
              readOnly: true,
              title: "🤖 Parámetros calculados por la IA para este track",
            });
          }

          showStatus(null, `IA calculó los parámetros — procesando…`, "queued");
          startPolling(currentJobId);
        } catch (e) {
          aiHideTyping();
          console.error("Error en auto-master IA:", e);
          aiAppendNote("Error en el auto-mastering: " + e.message);
          showStatus(null, "Error: " + e.message, "error");
        } finally {
          autoBtn.disabled = false;
          masterBtn.disabled = false;
        }
      });

      // ── SUGERIR CON IA (analiza y decide, pero NO masteriza directo) ────────────
      // A diferencia de "Auto-Mastering IA" (que encola el job de una), este botón
      // carga los parámetros calculados por la IA en los controles normales de la
      // cadena — se puede escuchar el preview, tocar cualquier slider a mano, y
      // recién ahí mandar a masterizar con el botón "▶ Masterizar" de siempre.
      document.getElementById("btnAiSuggest").addEventListener("click", async () => {
        if (!selectedFile) {
          showStatus(null, "Selecciona un archivo primero", "error");
          return;
        }
        clearResults();
        showStatus(null, "🤖 La IA está analizando tu track…", "processing");
        const suggestBtn = document.getElementById("btnAiSuggest");
        const autoBtn2 = document.getElementById("btnAutoMaster");
        const masterBtn2 = document.getElementById("btnMaster");
        suggestBtn.disabled = true;
        autoBtn2.disabled = true;
        masterBtn2.disabled = true;

        const panel2 = aiEl("aiPanel");
        if (!panel2.classList.contains("open")) panel2.classList.add("open");
        aiEl("aiSuggestions").innerHTML = "";
        aiShowTyping();

        const fd2 = new FormData();
        if (_previewLibraryId) {
          fd2.append("library_id", _previewLibraryId);
        } else {
          fd2.append("file", selectedFile);
        }
        try {
          const res = await fetch(`${API()}/ai/suggest`, { method: "POST", body: fd2 });
          aiHideTyping();
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
          }
          const data = await res.json();
          setAiContext(data.analysis);

          const d = data.ai_decision || {};
          const platformLabel = d.platform ? d.platform : "sin target específico";
          aiAppendMessage(
            "assistant",
            `🤖 Analicé el track y armé una propuesta de cadena a medida (no un preset fijo).\nPlataforma: ${platformLabel}\n\nCargué los parámetros en los controles — escuchá el preview, ajustá lo que quieras, y confirmá cuando estés conforme.` +
              (d.reasoning ? `\n\n${d.reasoning}` : ""),
          );

          const { platform, reasoning, ...aiParams } = d;
          if (Object.keys(aiParams).length) {
            // Carga los sliders/checkboxes/selects con los valores sugeridos
            // (misma función que usan los presets) — dispara el preview solo.
            applyPresetToUI(aiParams);
            document.querySelectorAll(".preset-btn.active").forEach((b) => b.classList.remove("active"));
            activePreset = null;
            renderParamsPreview(aiParams, {
              title: "🤖 Parámetros sugeridos por la IA — revisá y confirmá para masterizar",
              confirmLabel: "✅ Confirmar y masterizar",
              onConfirm: submitMasterJob,
            });
          }
          showStatus(null, "Parámetros cargados — revisá y confirmá cuando quieras", "done");
        } catch (e) {
          aiHideTyping();
          console.error("Error en /ai/suggest:", e);
          aiAppendNote("Error al pedir la sugerencia de la IA: " + e.message);
          showStatus(null, "Error: " + e.message, "error");
        } finally {
          suggestBtn.disabled = false;
          autoBtn2.disabled = false;
          masterBtn2.disabled = false;
        }
      });

      // ── ANALYZE (corregido) ──────────────────────────────────────────────────
      document.getElementById("btnAnalyze").addEventListener("click", async () => {
        if (!selectedFile) return;
        clearResults();
        showStatus(null, "Analizando…", "processing");
        const fd = new FormData();
        fd.append("file", selectedFile);
        try {
          const res = await fetch(`${API()}/analyze`, { method: "POST", body: fd });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
          }
          const data = await res.json();
          showStatus(null, "Análisis completado", "done");
          if (data.lufs != null) showLoudnessMeter(data.lufs);
          renderAnalysisSingle(data);
          if (data.mix_advice) renderAdvicePanel(data.mix_advice, "Evaluación de la mezcla");
          if (data.fft_spectrum) renderFFT([{ label: "Espectro", data: data.fft_spectrum }]);
          setAiContext(data);
        } catch (e) {
          console.error("Error en análisis:", e);
          showStatus(null, "Error: " + e.message, "error");
        }
      });

      // ── ADVICE (corregido) ──────────────────────────────────────────────────────
      document.getElementById("btnAdvice").addEventListener("click", async () => {
        if (!selectedFile) return;
        clearResults();
        showStatus(null, "Analizando mezcla…", "processing");
        const fd = new FormData();
        fd.append("file", selectedFile);
        try {
          const res = await fetch(`${API()}/mix-advice`, { method: "POST", body: fd });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
          }
          const data = await res.json();
          showStatus(null, "Evaluación completada", "done");
          if (data.analysis?.lufs != null) showLoudnessMeter(data.analysis.lufs);
          renderAdvicePanel(data, "Evaluación de la mezcla");
          if (data.analysis?.fft_spectrum) renderFFT([{ label: "Espectro", data: data.analysis.fft_spectrum }]);
          if (data.analysis)
            setAiContext({ ...data.analysis, mix_advice: { issues: data.issues, tips: data.tips, score: data.score } });
        } catch (e) {
          console.error("Error en consejos:", e);
          showStatus(null, "Error: " + e.message, "error");
        }
      });

      // ── SPECTRUM (corregido) ──────────────────────────────────────────────────
      document.getElementById("btnSpectrum").addEventListener("click", async () => {
        if (!selectedFile) return;
        clearResults();
        showStatus(null, "Calculando FFT…", "processing");
        const fd = new FormData();
        fd.append("file", selectedFile);
        try {
          const res = await fetch(`${API()}/spectrum?n_fft=4096&n_bins=96`, { method: "POST", body: fd });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
          }
          const data = await res.json();
          showStatus(null, "Spectrum listo", "done");
          renderFFT([{ label: "Espectro", data }]);
        } catch (e) {
          console.error("Error en spectrum:", e);
          showStatus(null, "Error: " + e.message, "error");
        }
      });

      // ── STEM SEPARATION (#13 — Demucs) ──────────────────────────────────────────
      document.getElementById("btnStems").addEventListener("click", async () => {
        if (!selectedFile) return;
        clearResults();
        showStatus(null, "Separando en stems…", "processing", 0, "En cola…");
        document.getElementById("btnStems").disabled = true;
        const fd = new FormData();
        fd.append("file", selectedFile);
        try {
          const res = await fetch(`${API()}/stems/separate`, { method: "POST", body: fd });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
          }
          const data = await res.json();
          pollStemsJob(data.job_id);
        } catch (e) {
          console.error("Error separando stems:", e);
          showStatus(null, "Error: " + e.message, "error");
          document.getElementById("btnStems").disabled = false;
        }
      });

      function pollStemsJob(jobId) {
        const interval = setInterval(async () => {
          try {
            const res = await fetch(`${API()}/job/${jobId}`);
            const data = await res.json();
            if (data.status === "queued" || data.status === "processing") {
              showStatus(null, "Separando stems…", "processing", data.progress, data.stage);
            } else if (data.status === "done") {
              clearInterval(interval);
              showStatus(null, "Stems listos ✓", "done");
              document.getElementById("btnStems").disabled = false;
              renderStemsPanel(data.stem_analysis, jobId, data.available_stems || []);
            } else if (data.status === "error") {
              clearInterval(interval);
              showStatus(null, "Error: " + data.error, "error");
              document.getElementById("btnStems").disabled = false;
            }
          } catch (e) {
            console.error("Poll stems error:", e);
          }
        }, 1500);
      }

      function renderStemsPanel(stemAnalysis, jobId, availableStems) {
        if (!stemAnalysis) return;
        const wrap = document.createElement("div");
        wrap.className = "stems-wrap";

        const cards = Object.values(stemAnalysis.stems || {})
          .map(
            (s) => `
    <div class="stem-card ${s.is_silent ? "silent" : ""}">
      <div class="stem-title">${s.label || s.name}</div>
      <div class="stem-metric"><span>Peak</span><span>${s.peak_db} dB</span></div>
      <div class="stem-metric"><span>RMS</span><span>${s.rms_db} dB</span></div>
      ${s.lufs != null ? `<div class="stem-metric"><span>LUFS</span><span>${s.lufs}</span></div>` : ""}
      <div class="stem-metric"><span>Banda dominante</span><span>${(s.dominant_band || "—").replace("_", " ")}</span></div>
      ${availableStems.includes(s.name) ? `<a class="stem-dl" href="${API()}/stems/download/${jobId}/${s.name}" target="_blank">⬇ Descargar ${s.name}.wav</a>` : ""}
    </div>
  `,
          )
          .join("");

        const recs = stemAnalysis.recommendations || [];
        const recsHtml = recs.length
          ? recs
              .map(
                (r) => `
        <div class="stem-rec ${r.type === "kick_bass_collision" ? "kick-bass" : ""}">
          ${r.message}
          <div class="rec-score">Score de colisión: ${r.score}${r.band_hz ? ` · Banda: ${r.band_hz[0]}-${r.band_hz[1]} Hz` : ""}</div>
        </div>
      `,
              )
              .join("")
          : `<div style="color:var(--muted);font-size:.78rem">${stemAnalysis.summary || "Sin colisiones detectadas."}</div>`;

        wrap.innerHTML = `
    <h3>Stems (Demucs)</h3>
    <div class="stem-cards">${cards}</div>
    <h3 style="margin-top:1.2rem">Recomendaciones</h3>
    ${recsHtml}
  `;
        getContent().prepend(wrap);
      }

      // ── Polling ──────────────────────────────────────────────────────────────────
      function startPolling(jobId) {
        if (pollInterval) clearInterval(pollInterval);
        pollInterval = setInterval(async () => {
          try {
            const res = await fetch(`${API()}/job/${jobId}`);
            const data = await res.json();
            if (data.status === "queued") {
              showStatus(null, "En cola…", "queued", data.progress, data.stage);
            } else if (data.status === "processing") {
              showStatus(null, "Masterizando…", "processing", data.progress, data.stage);
            } else if (data.status === "done") {
              clearInterval(pollInterval);
              showStatus(null, "Mastering completado ✓", "done");
              document.getElementById("btnMaster").disabled = false;
              downloadUrl = `${API()}/download/${jobId}`;
              const btn = document.getElementById("btnDownload");
              btn.style.display = "block";
              const nameInput = document.getElementById("trackNameInput");
              nameInput.style.display = "block";
              prefillTrackNameFromFile();
              btn.onclick = () => window.open(downloadUrl + currentTrackNameParam(), "_blank");
              const rBtn = document.getElementById("btnReport");
              rBtn.style.display = "block";
              rBtn.onclick = () => downloadReport(jobId);
              if (data.analysis_before?.lufs != null)
                showLoudnessMeter(data.analysis_after?.lufs ?? data.analysis_before.lufs);
              renderAnalysisComparison(data.analysis_before, data.analysis_after);
              if (data.mix_advice_before) renderAdvicePanel(data.mix_advice_before, "Evaluación", "— Antes");
              if (data.mix_advice_after) renderAdvicePanel(data.mix_advice_after, "Evaluación", "— Después");
              // NOTA: ya NO se llama acá a renderChainMeters(data.chain_meters).
              // Ese chain_meters corresponde al render FINAL de la canción
              // entera (job /master), pero las barras de GR (Comp/Multibanda/
              // Glue/De-esser/Dynamic) son el panel de "meters en tiempo
              // real", que debe reflejar SOLO el preview en vivo (WS
              // /ws/master-stream, ya recortado a preview_seconds) — nunca
              // estadísticas de la canción completa, que las pisaban acá.
              // BUGFIX: sin esto, Laia seguía usando el análisis PRE-mastering (o nada)
              // para responder preguntas sobre el resultado ya masterizado, lo que hacía
              // que sus respuestas parecieran genéricas / desactualizadas.
              if (data.analysis_after) setAiContext({ ...data.analysis_after, mix_advice: data.mix_advice_after });
            } else if (data.status === "error") {
              clearInterval(pollInterval);
              showStatus(null, "Error: " + data.error, "error");
              document.getElementById("btnMaster").disabled = false;
            }
          } catch (e) {
            console.error("Poll error:", e);
          }
        }, 1500);
      }

      // ── MASTER CON REFERENCIA ────────────────────────────────────────────────────
      function collectReferenceParamsObj() {
        return {
          eq_max_boost_db: document.getElementById("s-ref-eq").checked
            ? document.getElementById("s-ref-boost").value
            : "0",
          eq_max_cut_db: document.getElementById("s-ref-eq").checked ? document.getElementById("s-ref-cut").value : "0",
          match_loudness: document.getElementById("s-ref-loudness").checked,
          match_dynamics: document.getElementById("s-ref-dynamics").checked,
          match_stereo_width: document.getElementById("s-ref-stereo").checked,
          output_format: document.getElementById("s-format").value,
          output_bit_depth: document.getElementById("s-bitdepth").value,
          dynamics_margin_db: document.getElementById("s-ref-dynmargin").value,
          stereo_blend: (parseFloat(document.getElementById("s-ref-stereoblend").value) / 100).toFixed(2),
        };
      }
      const REF_PARAM_LABELS = {
        eq_max_boost_db: "EQ boost máx (dB)",
        eq_max_cut_db: "EQ cut máx (dB)",
        match_loudness: "Igualar loudness",
        match_dynamics: "Igualar dinámica",
        match_stereo_width: "Igualar ancho estéreo",
        output_format: "Formato salida",
        output_bit_depth: "Bit depth",
        dynamics_margin_db: "Margen dinámica (dB)",
        stereo_blend: "Mezcla estéreo",
      };

      async function submitReferenceMasterJob() {
        clearResults();
        showStatus(null, "Enviando archivos…", "queued");
        document.getElementById("btnMasterRef").disabled = true;

        const fd = new FormData();
        fd.append("file", selectedFile);
        fd.append("reference_file", selectedRefFile);

        const params = new URLSearchParams(collectReferenceParamsObj());

        try {
          const url = `${API()}/master/reference?${params.toString()}`;
          const res = await fetch(url, { method: "POST", body: fd });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
          }
          const data = await res.json();
          currentJobId = data.job_id;
          showStatus(null, `Job ${currentJobId.slice(0, 8)}… en cola (matching por referencia)`, "queued");
          startReferencePolling(currentJobId);
        } catch (e) {
          console.error("❌ Error al enviar (referencia):", e);
          showStatus(null, "Error: " + e.message, "error");
          document.getElementById("btnMasterRef").disabled = false;
        }
      }

      document.getElementById("btnMasterRef").addEventListener("click", () => {
        if (!selectedFile || !selectedRefFile) {
          showStatus(null, "Seleccioná tu track y un track de referencia", "error");
          return;
        }
        clearResults();
        const paramsObj = collectReferenceParamsObj();
        const panel = document.createElement("div");
        panel.className = "params-preview";
        let html = `<h3>🔎 Parámetros corregidos — matching por referencia</h3><div class="pp-group"><div class="pp-grid">`;
        Object.entries(paramsObj).forEach(([k, v]) => {
          html += `<div class="pp-item"><span>${REF_PARAM_LABELS[k] || k}</span><span>${formatParamValue(v)}</span></div>`;
        });
        html += `</div></div><div class="pp-actions">
    <button class="btn btn-secondary" id="ppRefCancelBtn">✕ Cancelar</button>
    <button class="btn btn-primary" id="ppRefConfirmBtn">✅ Confirmar y masterizar</button>
  </div>`;
        panel.innerHTML = html;
        getContent().prepend(panel);
        panel.querySelector("#ppRefConfirmBtn").addEventListener("click", () => {
          panel.remove();
          submitReferenceMasterJob();
        });
        panel.querySelector("#ppRefCancelBtn").addEventListener("click", () => panel.remove());
      });

      function startReferencePolling(jobId) {
        if (pollInterval) clearInterval(pollInterval);
        pollInterval = setInterval(async () => {
          try {
            const res = await fetch(`${API()}/job/${jobId}`);
            const data = await res.json();
            if (data.status === "queued") {
              showStatus(null, "En cola…", "queued", data.progress, data.stage);
            } else if (data.status === "processing") {
              showStatus(null, "Masterizando por referencia…", "processing", data.progress, data.stage);
            } else if (data.status === "done") {
              clearInterval(pollInterval);
              showStatus(null, "Masterizado por referencia ✓", "done");
              document.getElementById("btnMasterRef").disabled = false;
              downloadUrl = `${API()}/download/${jobId}`;
              const btn = document.getElementById("btnDownload");
              btn.style.display = "block";
              const nameInput = document.getElementById("trackNameInput");
              nameInput.style.display = "block";
              prefillTrackNameFromFile();
              btn.onclick = () => window.open(downloadUrl + currentTrackNameParam(), "_blank");
              const rBtn = document.getElementById("btnReport");
              rBtn.style.display = "block";
              rBtn.onclick = () => downloadReport(jobId);
              if (data.analysis_before?.lufs != null)
                showLoudnessMeter(data.analysis_after?.lufs ?? data.analysis_before.lufs);
              if (data.reference_match) renderReferenceMatch(data.reference_match, data.analysis_reference);
              renderAnalysisComparison(data.analysis_before, data.analysis_after);
              if (data.analysis_reference?.fft_spectrum && data.analysis_after?.fft_spectrum) {
                renderFFT([
                  { label: "Referencia", data: data.analysis_reference.fft_spectrum, color: "var(--accent2)" },
                  { label: "Resultado", data: data.analysis_after.fft_spectrum, color: "var(--green)" },
                ]);
              }
              if (data.mix_advice_after) renderAdvicePanel(data.mix_advice_after, "Evaluación", "— Resultado");
              // BUGFIX: mismo problema que en el mastering normal — sin esto Laia
              // quedaba hablando con datos viejos (o sin análisis) del resultado
              // masterizado por referencia.
              if (data.analysis_after) setAiContext({ ...data.analysis_after, mix_advice: data.mix_advice_after });
            } else if (data.status === "error") {
              clearInterval(pollInterval);
              showStatus(null, "Error: " + data.error, "error");
              document.getElementById("btnMasterRef").disabled = false;
            }
          } catch (e) {
            console.error("Poll error (referencia):", e);
          }
        }, 1500);
      }

      function renderReferenceMatch(rm, refAnalysis) {
        const panel = document.createElement("div");
        panel.className = "ref-match-panel";
        const pct = rm.after?.match_percent ?? 0;
        const report = rm.intelligent_report || {};
        const dynBands = rm.dynamics_by_band || {};
        const stereoBands = rm.stereo_width_by_band || {};
        const lra = rm.lra || {};

        const dynRows = ["low", "mid", "high"]
          .map((name) => {
            const b = dynBands[name];
            if (!b) return "";
            const label = name === "low" ? "Graves" : name === "mid" ? "Medios" : "Agudos";
            const text = b.applied
              ? `comprimida (gap ${b.gap_db} dB, ratio ${b.ratio}:1)`
              : `sin cambios (gap ${b.gap_db} dB)`;
            return `<div class="ref-match-step">${label}: <b>${text}</b></div>`;
          })
          .join("");

        const stereoRows = ["low", "mid", "high"]
          .map((name) => {
            const k = stereoBands[name];
            if (k === undefined) return "";
            const label = name === "low" ? "Graves" : name === "mid" ? "Medios" : "Agudos";
            return `<div class="ref-match-step">${label}: <b>${k}x</b></div>`;
          })
          .join("");

        const lraText = lra.applied
          ? `LRA ${lra.own_lra} → acercado a ${lra.ref_lra} LU (ratio ${lra.ratio}:1)`
          : `LRA propio: ${lra.own_lra ?? "--"} LU · referencia: ${lra.ref_lra ?? "--"} LU`;

        const tipsHtml = (report.tips || []).map((t) => `<li>${t}</li>`).join("");
        const issuesHtml = (report.issues || []).map((t) => `<li style="color:var(--red,#e05)">${t}</li>`).join("");

        panel.innerHTML = `
    <h3>🎯 Match con referencia</h3>
    <div class="ref-match-score-row">
      <div class="ref-match-score-circle"><span class="score-num">${pct}%</span><span class="score-label">MATCH TONAL</span></div>
      <div>
        <div style="font-size:.85rem">Similitud tonal final con la referencia</div>
        <div style="font-size:.75rem;color:var(--muted);margin-top:.2rem">Antes: ${rm.before?.match_percent ?? "--"}% → Tras EQ: ${rm.after_eq?.match_percent ?? "--"}% → Final: ${pct}%</div>
        ${report.overall_score !== undefined ? `<div style="font-size:.8rem;margin-top:.3rem">Puntaje inteligente general: <b>${report.overall_score}/100 (${report.grade})</b></div>` : ""}
      </div>
    </div>
    <div class="ref-match-steps">
      <div class="ref-match-step">Loudness: <b>${rm.loudness_gain_applied_db >= 0 ? "+" : ""}${rm.loudness_gain_applied_db} dB</b></div>
      <div class="ref-match-step">Techo limiter: <b>${(20 * Math.log10(rm.limiter_ceiling)).toFixed(2)} dBFS</b></div>
      <div class="ref-match-step">LUFS referencia: <b>${refAnalysis?.lufs ?? "--"}</b></div>
      <div class="ref-match-step" style="flex-basis:100%">${lraText}</div>
    </div>
    <div style="margin-top:.7rem;font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.08em">Dinámica por banda</div>
    <div class="ref-match-steps">${dynRows}</div>
    <div style="margin-top:.7rem;font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.08em">Ancho estéreo por banda</div>
    <div class="ref-match-steps">${stereoRows}</div>
    ${issuesHtml ? `<ul style="margin-top:.7rem;font-size:.78rem;padding-left:1.1rem">${issuesHtml}</ul>` : ""}
    ${tipsHtml ? `<ul style="margin-top:.5rem;font-size:.78rem;color:var(--muted);padding-left:1.1rem">${tipsHtml}</ul>` : ""}
  `;
        getContent().appendChild(panel);
      }

      document.getElementById("btnAB").addEventListener("click", () => {
        if (!selectedFile) return;
        showABPanel();
      });
      function showABPanel() {
        let wrap = document.getElementById("abPanelWrap");
        if (wrap) return;
        clearResults();
        wrap = document.createElement("div");
        wrap.id = "abPanelWrap";
        wrap.className = "ab-wrap";
        wrap.innerHTML = `
    <h3>⚡ Comparación A/B</h3>
    <p style="font-size:.8rem;color:var(--muted);margin-bottom:1rem">Guardá dos versiones (A y B) y comparalas.</p>
    <div class="ab-controls">
      <button class="ab-btn" id="abCaptureA">📸 Capturar A</button>
      <button class="ab-btn" id="abCaptureB">📸 Capturar B</button>
      <button class="ab-btn" id="abPlayA" disabled>▶ A</button>
      <button class="ab-btn" id="abPlayB" disabled>▶ B</button>
    </div>
    <div id="abStatus" style="font-family:var(--mono);font-size:.75rem;color:var(--muted)">Capturá A y B.</div>
    <div id="abAudioWrap" style="margin-top:1rem"></div>
  `;
        document.getElementById("content").appendChild(wrap);
        document.getElementById("abCaptureA").onclick = () => captureAB("A");
        document.getElementById("abCaptureB").onclick = () => captureAB("B");
        document.getElementById("abPlayA").onclick = () => playAB("A");
        document.getElementById("abPlayB").onclick = () => playAB("B");
      }

      async function captureAB(slot) {
        if (!selectedFile) {
          document.getElementById("abStatus").textContent = "Selecciona un archivo primero.";
          return;
        }
        const status = document.getElementById("abStatus");
        status.textContent = `Capturando ${slot}…`;
        const fd = new FormData();
        fd.append("file", selectedFile);
        try {
          const params = buildParams();
          params.set("preview_seconds", "10");
          const url = `${API()}/preview?${params.toString()}`;
          const res = await fetch(url, { method: "POST", body: fd });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
          }
          const blob = await res.blob();
          if (slot === "A") {
            abSnapshotA = { blob, label: "A" };
            document.getElementById("abPlayA").disabled = false;
            document.getElementById("abPlayA").classList.add("active-a");
          } else {
            abSnapshotB = { blob, label: "B" };
            document.getElementById("abPlayB").disabled = false;
            document.getElementById("abPlayB").classList.add("active-b");
          }
          status.textContent = `${slot} capturado ✓. ${abSnapshotA && abSnapshotB ? "Ambos listos." : ""}`;
        } catch (e) {
          console.error("Error capturando:", e);
          status.textContent = "Error: " + e.message;
        }
      }

      function playAB(slot) {
        const snap = slot === "A" ? abSnapshotA : abSnapshotB;
        if (!snap) return;
        const wrap = document.getElementById("abAudioWrap");
        const url = URL.createObjectURL(snap.blob);
        wrap.innerHTML = `<div style="font-family:var(--mono);font-size:.75rem;color:${slot === "A" ? "var(--accent)" : "var(--yellow)"};margin-bottom:.3rem">▶ ${slot}</div><audio controls autoplay src="${url}" style="width:100%"></audio>`;
      }

      // ── Advice ──────────────────────────────────────────────────────────────────
      function renderAdvicePanel(adviceData, title, subtitle) {
        const panel = document.createElement("div");
        panel.className = "advice-panel";
        const score = adviceData.score ?? 0,
          grade = adviceData.grade ?? "";
        const issues = adviceData.issues ?? [],
          tips = adviceData.tips ?? [];
        const gradeClass =
          grade === "Excelente"
            ? "grade-ex"
            : grade === "Buena"
              ? "grade-good"
              : grade === "Aceptable"
                ? "grade-ok"
                : "grade-bad";
        const issuesHtml = issues.length
          ? `<ul class="advice-issues">${issues.map((i) => `<li>${i}</li>`).join("")}</ul>`
          : "";
        const tipsHtml = tips.length ? `<ul class="advice-tips">${tips.map((t) => `<li>${t}</li>`).join("")}</ul>` : "";
        panel.innerHTML = `<h3>${title}${subtitle ? ` <span style="color:var(--muted);font-weight:400">${subtitle}</span>` : ""}</h3><div class="advice-score-row"><div class="advice-score-circle"><span class="score-num">${score}</span><span class="score-label">/ 100</span></div><div><div class="advice-grade ${gradeClass}">${grade}</div><div style="font-size:.75rem;color:var(--muted);margin-top:.2rem">${issues.length} problema${issues.length !== 1 ? "s" : ""}</div></div></div>${issuesHtml}${tipsHtml}`;
        getContent().appendChild(panel);
      }

      // ── FFT ──────────────────────────────────────────────────────────────────────
      // ── Visualizador de espectro en tiempo real (streaming chunk a chunk) ─────────
      // Recibe el array bands_db (32 bandas log) que viene en metrics.spectrum
      // y dibuja un bar graph animado sobre el canvas jobSpectrumCanvas.
      // BUGFIX: esta función se llamaba también "drawLiveSpectrum", igual que la
      // función de más abajo (canvas, dataL, dataR, sampleRate) que dibuja el
      // espectro del monitor de entrada en vivo. Al haber DOS declaraciones
      // "function drawLiveSpectrum" en el mismo scope global, la segunda
      // pisaba a la primera (hoisting), y la llamada de acá (con 1 solo
      // argumento, bandsDb) terminaba ejecutando la función equivocada —
      // tratando el array bandsDb como si fuera un elemento <canvas>, lo que
      // tiraba "canvas.getContext is not a function" cada vez que llegaba
      // espectro por streaming durante el render. Se renombra a drawJobSpectrum
      // para que ambas funciones convivan sin pisarse.
      let _liveSpecSmooth = null; // suavizado exponencial entre chunks

      function drawJobSpectrum(bandsDb) {
        const canvas = document.getElementById("jobSpectrumCanvas");
        if (!canvas) return;
        const wrap = document.getElementById("liveSpectrumWrap");
        if (wrap) wrap.style.display = "block";

        const dpr = window.devicePixelRatio || 1;
        const cssW = canvas.parentElement.clientWidth || 600;
        const cssH = 80;
        canvas.width = cssW * dpr;
        canvas.height = cssH * dpr;
        const ctx = canvas.getContext("2d");
        ctx.scale(dpr, dpr);

        const N = bandsDb.length;
        // Suavizado exponencial para evitar parpadeo entre chunks
        if (!_liveSpecSmooth || _liveSpecSmooth.length !== N) {
          _liveSpecSmooth = Float32Array.from(bandsDb);
        } else {
          const alpha = 0.35; // mayor = más rápido, menor = más suave
          for (let i = 0; i < N; i++) {
            _liveSpecSmooth[i] = alpha * bandsDb[i] + (1 - alpha) * _liveSpecSmooth[i];
          }
        }

        ctx.clearRect(0, 0, cssW, cssH);

        const gap = 2;
        const barW = (cssW - gap * (N - 1)) / N;
        const DB_MIN = -80,
          DB_MAX = 0;

        for (let i = 0; i < N; i++) {
          const db = Math.max(DB_MIN, Math.min(DB_MAX, _liveSpecSmooth[i]));
          const t = (db - DB_MIN) / (DB_MAX - DB_MIN); // 0..1
          const h = Math.max(1, t * (cssH - 4));
          const x = i * (barW + gap);
          const y = cssH - h - 2;

          // Gradiente: azul (graves) → verde (medios) → rojo (agudos), intensidad por nivel
          const hue = 240 - i * (240 / N); // 240 (azul) → 0 (rojo)
          const light = 35 + t * 30;
          ctx.fillStyle = `hsl(${hue},80%,${light}%)`;
          ctx.beginPath();
          ctx.roundRect(x, y, barW, h, 2);
          ctx.fill();
        }

        // Línea de referencia -18 dBFS
        const refT = (-18 - DB_MIN) / (DB_MAX - DB_MIN);
        const refY = cssH - refT * (cssH - 4) - 2;
        ctx.strokeStyle = "rgba(255,255,255,0.15)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(0, refY);
        ctx.lineTo(cssW, refY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(255,255,255,0.3)";
        ctx.font = "9px monospace";
        ctx.fillText("-18 dB", 4, refY - 3);
      }

      function hideLiveSpectrum() {
        const wrap = document.getElementById("liveSpectrumWrap");
        if (wrap) wrap.style.display = "none";
        _liveSpecSmooth = null;
      }

      // ── Dynamic EQ — recomendación en vivo (resonancias / sibilancia) ───────────
      // Viene en metrics.dynamic_eq_recommendation de cada chunk de /ws/master-stream
      // (ver streaming_engine.py). Se recalcula cada ~6s de audio, no en cada chunk,
      // así que comparamos por "summary" para no re-renderizar (y resetear el botón
      // "Aplicado") en cada uno de los chunks que repiten la misma detección.
      let _lastDynEqRec = null;
      let _lastDynEqRecSummary = null;

      function renderDynEqRecommendation(rec) {
        if (!rec) return;
        _lastDynEqRec = rec;
        if (rec.summary === _lastDynEqRecSummary) return;
        _lastDynEqRecSummary = rec.summary;

        const wrap = document.getElementById("dynEqRecWrap");
        const body = document.getElementById("dynEqRecBody");
        if (!wrap || !body) return;
        wrap.style.display = "block";

        const resonances = rec.resonances || [];
        const sib = rec.sibilance || {};

        let html = `<div style="margin-bottom:.5rem">${rec.summary || ""}</div>`;

        if (resonances.length) {
          html += `<div style="margin-bottom:.4rem"><b>Resonancias detectadas:</b><ul style="margin:.25rem 0 0;padding-left:1.1rem">`;
          resonances.slice(0, 4).forEach((r, i) => {
            html += `<li>${r.freq_hz.toFixed(0)} Hz (+${r.excess_db.toFixed(1)} dB)${i === 0 ? ' — <span style="color:var(--lilac)">se usará para Reso</span>' : ""}</li>`;
          });
          html += `</ul></div>`;
        }

        if (sib.present) {
          html += `<div style="margin-bottom:.4rem"><b>Sibilancia:</b> ${sib.band_hz[0].toFixed(0)}-${sib.band_hz[1].toFixed(0)} Hz, severidad ${sib.severity_db.toFixed(1)} dB (${sib.frames_flagged_pct.toFixed(1)}% de cuadros)</div>`;
        }

        if (!resonances.length && !sib.present) {
          html += `<div style="color:var(--muted)">Sin problemas relevantes detectados en este momento del track.</div>`;
        }

        html += `<div style="display:flex;gap:.4rem;margin-top:.5rem">
      <button class="ai-suggestion-apply-btn" id="dynEqApplyBtn" style="flex:1">✓ Aplicar a Reso / De-esser</button>
    </div>`;

        body.innerHTML = html;

        const applyBtn = document.getElementById("dynEqApplyBtn");
        if (applyBtn) {
          applyBtn.addEventListener("click", () => {
            if (!_lastDynEqRec || !_lastDynEqRec.recommended_params) return;
            applyPresetToUI(_lastDynEqRec.recommended_params);
            applyBtn.textContent = "✓ Aplicado";
            applyBtn.disabled = true;
          });
        }
      }

      function hideDynEqRecommendation() {
        const wrap = document.getElementById("dynEqRecWrap");
        if (wrap) wrap.style.display = "none";
        const body = document.getElementById("dynEqRecBody");
        if (body) body.innerHTML = "";
        _lastDynEqRec = null;
        _lastDynEqRecSummary = null;
      }

      function drawFFTOnCanvas(canvas, series) {
        const dpr = window.devicePixelRatio || 1;
        const cssWidth = canvas.clientWidth || 600,
          cssHeight = 220;
        canvas.width = cssWidth * dpr;
        canvas.height = cssHeight * dpr;
        const ctx = canvas.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, cssWidth, cssHeight);
        const allDb = series.flatMap((s) => s.data.magnitudes_db);
        const minDb = Math.min(...allDb, -80),
          maxDb = Math.max(...allDb, -10);
        const padL = 36,
          padB = 18,
          padT = 8,
          padR = 8;
        const plotW = cssWidth - padL - padR,
          plotH = cssHeight - padT - padB;
        const theme = themeColors();
        const colorOf = (c) => {
          if (!c) return theme.accent;
          const m = c.match(/var\((--[a-z0-9-]+)\)/);
          return m ? theme.get(m[1]) : c;
        };
        const borderColor = theme.border,
          mutedColor = theme.muted;
        ctx.strokeStyle = borderColor;
        ctx.fillStyle = mutedColor;
        ctx.font = "10px monospace";
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
          const db = maxDb - (i / 4) * (maxDb - minDb);
          const y = padT + (i / 4) * plotH;
          ctx.beginPath();
          ctx.moveTo(padL, y);
          ctx.lineTo(padL + plotW, y);
          ctx.stroke();
          ctx.fillText(Math.round(db) + "dB", 2, y + 3);
        }
        const freqs = series[0].data.frequencies_hz;
        const fMin = Math.max(freqs[0], 20),
          fMax = freqs[freqs.length - 1];
        const xForFreq = (f) =>
          padL + ((Math.log10(f) - Math.log10(fMin)) / (Math.log10(fMax) - Math.log10(fMin))) * plotW;
        [20, 100, 1000, 10000, 20000].forEach((f) => {
          if (f < fMin || f > fMax) return;
          const x = xForFreq(f);
          ctx.beginPath();
          ctx.moveTo(x, padT);
          ctx.lineTo(x, padT + plotH);
          ctx.stroke();
          ctx.fillText(f >= 1000 ? f / 1000 + "k" : f, x - 8, cssHeight - 4);
        });
        series.forEach((s) => {
          const freqs = s.data.frequencies_hz,
            mags = s.data.magnitudes_db;
          ctx.beginPath();
          ctx.strokeStyle = colorOf(s.color);
          ctx.lineWidth = 2;
          freqs.forEach((f, i) => {
            const x = xForFreq(Math.max(f, fMin));
            const norm = (mags[i] - minDb) / (maxDb - minDb);
            const y = padT + plotH - Math.max(0, Math.min(1, norm)) * plotH;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.stroke();
        });
        let lx = padL + 6,
          ly = padT + 6;
        series.forEach((s) => {
          ctx.fillStyle = colorOf(s.color);
          ctx.fillRect(lx, ly - 7, 8, 8);
          ctx.fillStyle = mutedColor;
          ctx.fillText(s.label, lx + 12, ly);
          lx += 12 + ctx.measureText(s.label).width + 16;
        });
      }

      function renderFFT(series) {
        const wrap = document.createElement("div");
        wrap.className = "fft-wrap";
        const legendHtml = series
          .map(
            (s) =>
              `<span style="color:${s.color || "var(--accent)"}">■</span> <span style="color:var(--muted);margin-right:1rem;font-size:.72rem;font-family:var(--mono)">${s.label}</span>`,
          )
          .join("");
        wrap.innerHTML = `<h3>Spectrum Analyzer (FFT)</h3><canvas></canvas><div style="margin-top:.6rem">${legendHtml}</div>`;
        getContent().appendChild(wrap);
        drawFFTOnCanvas(wrap.querySelector("canvas"), series);
      }

      function renderSpectrum(datasets, labels) {
        const wrap = document.createElement("div");
        wrap.className = "spectrum-wrap";
        const bandNames = {
          sub_bass: "Sub",
          bass: "Bass",
          low_mid: "Lo-Mid",
          mid: "Mid",
          upper_mid: "Hi-Mid",
          presence: "Pres",
          air: "Air",
        };
        const keys = Object.keys(bandNames);
        const FLOOR_DB = -80;
        const clamp = (v) => Math.max(v, FLOOR_DB);
        const allVals = datasets.flatMap((d) => keys.map((k) => clamp(d.spectrum[k] ?? FLOOR_DB)));
        const minV = Math.min(...allVals) - 5,
          maxV = Math.max(...allVals) + 5;
        const norm = (v) => Math.max(0, Math.min(100, ((clamp(v) - minV) / (maxV - minV)) * 100));
        const barsHtml = keys
          .map((k) => {
            const [d0, d1] = datasets;
            const v0 = norm(d0?.spectrum[k] ?? FLOOR_DB);
            const v1 = d1 ? norm(d1.spectrum[k] ?? FLOOR_DB) : null;
            return `<div class="bar-wrap"><div class="bar-track"><div class="bar-before" style="height:${v0}%"></div>${v1 != null ? `<div class="bar-after" style="height:${v1}%"></div>` : ""}</div><div class="bar-label">${bandNames[k]}</div></div>`;
          })
          .join("");
        const legendHtml =
          datasets.length === 2
            ? `<div class="legend"><span class="l-before">Antes</span><span class="l-after">Después</span></div>`
            : `<div class="legend"><span class="l-before">Espectro</span></div>`;
        wrap.innerHTML = `<h3>Espectro por bandas</h3><div class="spectrum-bars">${barsHtml}</div>${legendHtml}`;
        getContent().appendChild(wrap);
      }

      function metricsHtml(a, b) {
        const rows = [
          [
            "LUFS",
            a.lufs,
            b?.lufs,
            (v) => `${v} LUFS`,
            (v) => (v >= -14 && v <= -8 ? "good" : v >= -18 && v < -14 ? "warn" : "bad"),
          ],
          ["RMS", a.rms_db, b?.rms_db, (v) => `${v} dB`, () => "neutral"],
          ["Peak", a.peak_db, b?.peak_db, (v) => `${v} dBFS`, (v) => (v > -0.5 ? "warn" : "good")],
          [
            "Rango dinámico",
            a.dynamic_range_db,
            b?.dynamic_range_db,
            (v) => `${v} dB`,
            (v) => (v < 6 ? "bad" : v <= 12 ? "good" : "warn"),
          ],
          ["BPM", a.bpm, b?.bpm, (v) => `${v}`, () => "neutral"],
          ["Duración", a.duration_sec, null, (v) => `${v} s`, () => "neutral"],
          ["Sample rate", a.sample_rate, null, (v) => `${v} Hz`, () => "neutral"],
          ["Canales", a.channels, null, (v) => (v === 1 ? "Mono" : "Estéreo"), () => "neutral"],
        ];
        return rows
          .map(
            ([label, va, vb, fmt, cls]) =>
              `<div class="metric-row"><span class="metric-label">${label}</span><span class="metric-value ${cls(va)}">${fmt(va)}${b && vb != null ? ' <span class="delta ' + (vb > va ? "up" : "down") + '">' + (vb > va ? "+" : "") + (vb - va).toFixed(1) + "</span>" : ""}</span></div>`,
          )
          .join("");
      }

      function renderAnalysisSingle(a) {
        const grid = document.createElement("div");
        grid.className = "analysis-grid";
        grid.innerHTML = `<div class="analysis-panel"><h3>Métricas del audio</h3>${metricsHtml(a, null)}</div>`;
        getContent().appendChild(grid);
        renderProfessionalMeter(a);
        renderSpectrum([a], ["before"]);
      }

      function renderAnalysisComparison(before, after) {
        const grid = document.createElement("div");
        grid.className = "analysis-grid";
        grid.innerHTML = `<div class="analysis-panel"><h3>Antes</h3>${metricsHtml(before, null)}</div><div class="analysis-panel"><h3>Después</h3>${metricsHtml(after, before)}</div>`;
        getContent().appendChild(grid);
        renderProfessionalMeter(after);
        renderSpectrum([before, after], ["before", "after"]);
        if (before.fft_spectrum && after.fft_spectrum) {
          renderFFT([
            { label: "Antes", data: before.fft_spectrum, color: "var(--muted)" },
            { label: "Después", data: after.fft_spectrum, color: "var(--accent)" },
          ]);
        }
      }

      // ── Preview ──────────────────────────────────────────────────────────────────
      function setPreviewStatus(text) {
        const el = document.getElementById("previewStatus");
        if (el) el.textContent = text;
      }
      function renderProfessionalMeter(a) {
        if (!a) return;
        const existing = document.querySelector(".professional-meter");
        if (existing) existing.remove();
        const wrap = document.createElement("div");
        wrap.className = "professional-meter";
        const rows = [
          {
            label: "True Peak",
            value: a.true_peak_db,
            unit: "dBTP",
            status: a.true_peak_db > -0.5 ? "bad" : a.true_peak_db > -1.2 ? "warn" : "good",
            hint: "Inter-sample peak real",
          },
          {
            label: "PLR",
            value: a.plr_db,
            unit: "dB",
            status: a.plr_db > 10 ? "good" : a.plr_db > 6 ? "warn" : "bad",
            hint: "Peak-to-Loudness Ratio",
          },
          {
            label: "Dinámica",
            value: a.dynamic_range_db,
            unit: "dB",
            status: a.dynamic_range_db >= 10 ? "good" : a.dynamic_range_db >= 6 ? "warn" : "bad",
            hint: "Rango dinámico global",
          },
          {
            label: "Correlación estéreo",
            value: a.stereo_correlation,
            unit: "",
            status: a.stereo_correlation < 0.85 ? "warn" : "good",
            hint: "L/R total",
          },
          {
            label: "Mono compatibilidad",
            value: a.mono_compatibility_db,
            unit: "dB",
            status: a.mono_compatibility_db < -5 ? "bad" : a.mono_compatibility_db < -3 ? "warn" : "good",
            hint: "Pérdida al sumar L+R",
          },
          {
            label: "Loudness",
            value: a.lufs,
            unit: "LUFS",
            status: a.lufs >= -14 && a.lufs <= -9 ? "good" : a.lufs >= -18 && a.lufs < -14 ? "warn" : "bad",
            hint: "LUFS integrado",
          },
        ];
        const cards = rows
          .map((item) => {
            const suffix = item.unit ? ` ${item.unit}` : "";
            return `<div class="professional-meter-card"><strong>${item.label}</strong><span class="metric-value ${item.status}">${item.value != null ? item.value.toFixed(item.unit === "" ? 3 : 1) + suffix : "--"}</span><em>${item.hint}</em></div>`;
          })
          .join("");
        const warnings = [];
        if (a.true_peak_db != null && a.true_peak_db > -0.5) warnings.push("True peak peligroso: ajustá el ceiling para evitar clipping inter-sample.");
        if (a.mono_compatibility_db != null && a.mono_compatibility_db < -5) warnings.push("Compatibilidad mono baja: el mix puede colapsar al sumarlo a mono.");
        if (a.stereo_correlation != null && a.stereo_correlation < 0.8) warnings.push("Correlación estéreo baja: el paneo o los efectos pueden generar huecos o cancelaciones.");
        if (a.dynamic_range_db != null && a.dynamic_range_db < 6) warnings.push("Dinámica muy comprimida: cuidado con el limiteador para no aplastar el groove.");
        if (a.lufs != null && a.lufs > -9) warnings.push("El loudness ya es alto para streaming, mantené el ceiling conservador.");
        wrap.innerHTML = `
          <h3>Professional Metering</h3>
          <div class="professional-meter-grid">${cards}</div>
          ${warnings.length ? `<div class="professional-meter-warning">${warnings.map((line) => `• ${line}`).join("<br>")}</div>` : ""}
        `;
        getContent().appendChild(wrap);
      }

      function setPreviewUpdating(v) {
        const dot = document.getElementById("previewDot");
        if (dot) dot.classList.toggle("updating", v);
      }

      // ── FFT Web Worker ────────────────────────────────────────────────────────────
      // El cálculo corre off-thread para no bloquear la UI
      const _fftWorkerCode = `
function fftInPlace(re,im){const n=re.length;if(n<=1)return;for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){[re[i],re[j]]=[re[j],re[i]];[im[i],im[j]]=[im[j],im[i]]}}for(let len=2;len<=n;len<<=1){const ang=-2*Math.PI/len,wRe=Math.cos(ang),wIm=Math.sin(ang);for(let i=0;i<n;i+=len){let cR=1,cI=0;for(let k=0;k<len/2;k++){const uR=re[i+k],uI=im[i+k],vR=re[i+k+len/2]*cR-im[i+k+len/2]*cI,vI=re[i+k+len/2]*cI+im[i+k+len/2]*cR;re[i+k]=uR+vR;im[i+k]=uI+vI;re[i+k+len/2]=uR-vR;im[i+k+len/2]=uI-vI;const nr=cR*wRe-cI*wIm,ni=cR*wIm+cI*wRe;cR=nr;cI=ni}}}}
function simpleFFTMag(real){const n=real.length,re=Float64Array.from(real),im=new Float64Array(n);fftInPlace(re,im);const half=n/2+1,mag=new Float64Array(half);for(let i=0;i<half;i++)mag[i]=Math.sqrt(re[i]*re[i]+im[i]*im[i]);return mag;}
function computeFFTFromBuffer(mono,sr,nBins=96){let n=4096;if(mono.length<n)n=Math.max(64,Math.pow(2,Math.floor(Math.log2(Math.max(mono.length,64)))));const hop=Math.floor(n/2);const win=new Float32Array(n);for(let i=0;i<n;i++)win[i]=.5-.5*Math.cos(2*Math.PI*i/(n-1));const frames=[];for(let start=0;start+n<=mono.length;start+=hop){const frame=new Float32Array(n);for(let i=0;i<n;i++)frame[i]=mono[start+i]*win[i];frames.push(simpleFFTMag(frame));if(frames.length>=60)break;}if(!frames.length){const f=new Float32Array(n);for(let i=0;i<Math.min(n,mono.length);i++)f[i]=mono[i]*win[i];frames.push(simpleFFTMag(f));}const nBinsFFT=frames[0].length,avg=new Float64Array(nBinsFFT);frames.forEach(f=>{for(let i=0;i<nBinsFFT;i++)avg[i]+=f[i]/frames.length});const freqs=new Float64Array(nBinsFFT);for(let i=0;i<nBinsFFT;i++)freqs[i]=(i*sr)/n;const nyquist=sr/2,edges=[];for(let i=0;i<=nBins;i++)edges.push(Math.pow(10,Math.log10(20)+(i/nBins)*(Math.log10(nyquist)-Math.log10(20))));const binDb=[],binFreq=[];for(let i=0;i<nBins;i++){const lo=edges[i],hi=edges[i+1];let sum=0,count=0;for(let j=0;j<freqs.length;j++)if(freqs[j]>=lo&&freqs[j]<hi){sum+=avg[j];count++}binDb.push(20*Math.log10((count>0?sum/count:1e-9)+1e-9));binFreq.push((lo+hi)/2);}return{frequencies_hz:binFreq,magnitudes_db:binDb};}
self.onmessage = function(e) {
  const { id, mono, sr, nBins } = e.data;
  const result = computeFFTFromBuffer(mono, sr, nBins);
  self.postMessage({ id, result }, []);
};
`;
      const _fftWorkerBlob = new Blob([_fftWorkerCode], { type: "application/javascript" });
      const _fftWorkerUrl = URL.createObjectURL(_fftWorkerBlob);
      const _fftWorker = new Worker(_fftWorkerUrl);
      let _fftCallbacks = {};
      let _fftCallId = 0;
      _fftWorker.onmessage = function (e) {
        const { id, result } = e.data;
        if (_fftCallbacks[id]) {
          _fftCallbacks[id](result);
          delete _fftCallbacks[id];
        }
      };
      function computeFFTFromBuffer(mono, sr, nBins = 96) {
        // Versión síncrona de respaldo (usada sólo si el worker no está listo)
        return _computeFFTSync(mono, sr, nBins);
      }
      function _computeFFTSync(mono, sr, nBins = 96) {
        let n = 4096;
        if (mono.length < n) n = Math.max(64, Math.pow(2, Math.floor(Math.log2(Math.max(mono.length, 64)))));
        const hop = Math.floor(n / 2);
        const win = new Float32Array(n);
        for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
        const frames = [];
        for (let start = 0; start + n <= mono.length; start += hop) {
          const frame = new Float32Array(n);
          for (let i = 0; i < n; i++) frame[i] = mono[start + i] * win[i];
          frames.push(simpleFFTMag(frame));
          if (frames.length >= 60) break;
        }
        if (!frames.length) {
          const f = new Float32Array(n);
          for (let i = 0; i < Math.min(n, mono.length); i++) f[i] = mono[i] * win[i];
          frames.push(simpleFFTMag(f));
        }
        const nBinsFFT = frames[0].length,
          avg = new Float64Array(nBinsFFT);
        frames.forEach((f) => {
          for (let i = 0; i < nBinsFFT; i++) avg[i] += f[i] / frames.length;
        });
        const freqs = new Float64Array(nBinsFFT);
        for (let i = 0; i < nBinsFFT; i++) freqs[i] = (i * sr) / n;
        const nyquist = sr / 2,
          edges = [];
        for (let i = 0; i <= nBins; i++)
          edges.push(Math.pow(10, Math.log10(20) + (i / nBins) * (Math.log10(nyquist) - Math.log10(20))));
        const binDb = [],
          binFreq = [];
        for (let i = 0; i < nBins; i++) {
          const lo = edges[i],
            hi = edges[i + 1];
          let sum = 0,
            count = 0;
          for (let j = 0; j < freqs.length; j++)
            if (freqs[j] >= lo && freqs[j] < hi) {
              sum += avg[j];
              count++;
            }
          binDb.push(20 * Math.log10((count > 0 ? sum / count : 1e-9) + 1e-9));
          binFreq.push((lo + hi) / 2);
        }
        return { frequencies_hz: binFreq, magnitudes_db: binDb };
      }
      function computeFFTAsync(mono, sr, nBins = 96) {
        return new Promise((resolve) => {
          const id = ++_fftCallId;
          _fftCallbacks[id] = resolve;
          // Transferir el buffer para evitar copia de memoria
          const transfer = mono.buffer.byteLength > 0 ? [mono.buffer] : [];
          _fftWorker.postMessage({ id, mono, sr, nBins }, transfer);
        });
      }

      function simpleFFTMag(real) {
        const n = real.length,
          re = Float64Array.from(real),
          im = new Float64Array(n);
        fftInPlace(re, im);
        const half = n / 2 + 1,
          mag = new Float64Array(half);
        for (let i = 0; i < half; i++) mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
        return mag;
      }

      function fftInPlace(re, im) {
        const n = re.length;
        if (n <= 1) return;
        for (let i = 1, j = 0; i < n; i++) {
          let bit = n >> 1;
          for (; j & bit; bit >>= 1) j ^= bit;
          j ^= bit;
          if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
          }
        }
        for (let len = 2; len <= n; len <<= 1) {
          const ang = (-2 * Math.PI) / len,
            wRe = Math.cos(ang),
            wIm = Math.sin(ang);
          for (let i = 0; i < n; i += len) {
            let cR = 1,
              cI = 0;
            for (let k = 0; k < len / 2; k++) {
              const uR = re[i + k],
                uI = im[i + k],
                vR = re[i + k + len / 2] * cR - im[i + k + len / 2] * cI,
                vI = re[i + k + len / 2] * cI + im[i + k + len / 2] * cR;
              re[i + k] = uR + vR;
              im[i + k] = uI + vI;
              re[i + k + len / 2] = uR - vR;
              im[i + k + len / 2] = uI - vI;
              const nr = cR * wRe - cI * wIm,
                ni = cR * wIm + cI * wRe;
              cR = nr;
              cI = ni;
            }
          }
        }
      }

      function computeAndCacheOriginalFFT(audioBuffer) {
        const sr = audioBuffer.sampleRate;
        const c0 = audioBuffer.getChannelData(0);
        const mono =
          audioBuffer.numberOfChannels > 1
            ? (() => {
                const c1 = audioBuffer.getChannelData(1),
                  m = new Float32Array(c0.length);
                for (let i = 0; i < c0.length; i++) m[i] = (c0[i] + c1[i]) / 2;
                return m;
              })()
            : c0;
        // Usar worker async para no bloquear la UI al cargar el archivo
        computeFFTAsync(mono, sr, 96).then((result) => {
          originalFFTCache = result;
        });
      }

      function schedulePreview() {
        if (!document.getElementById("s-livepreview").checked || !selectedFile) return;
        clearTimeout(previewDebounceTimer);
        setPreviewStatus("Esperando…");
        previewDebounceTimer = setTimeout(runLivePreview, 600);
      }

      function wsUrlFor(path) {
        const apiUrl = new URL(API());
        return `${apiUrl.protocol === "https:" ? "wss" : "ws"}://${apiUrl.host}${path}`;
      }

      function wavBlobFromPcm16(chunks, sampleRate, channels) {
        // BUGFIX: el backend (streaming_engine.master_stream_to_pcm16) manda
        // los chunks como PCM FLOAT32 (4 bytes/sample, sin truncar a int16 —
        // ver docstring de esa función). Este header, sin embargo, declaraba
        // formato=1 (PCM entero) y bitsPerSample=16. decodeAudioData confiaba
        // en ese header y leía cada par de bytes de un float32 como si fuera
        // una muestra int16: el patrón de bits de un float da valores int16
        // gigantes/aleatorios → ruido de banda ancha a nivel casi full-scale
        // al reproducir el preview. Ahora el header declara correctamente
        // formato=3 (IEEE float) y bitsPerSample=32, que es lo que realmente
        // viaja por el socket. (El nombre de la función se mantiene por
        // compatibilidad con los callers existentes.)
        const dataSize = chunks.reduce((n, b) => n + b.byteLength, 0);
        const BYTES_PER_SAMPLE = 4; // float32
        const header = new ArrayBuffer(44);
        const view = new DataView(header);
        const write = (off, str) => {
          for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
        };
        write(0, "RIFF");
        view.setUint32(4, 36 + dataSize, true);
        write(8, "WAVE");
        write(12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 3, true); // 3 = IEEE float (antes: 1 = PCM entero)
        view.setUint16(22, channels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * channels * BYTES_PER_SAMPLE, true);
        view.setUint16(32, channels * BYTES_PER_SAMPLE, true);
        view.setUint16(34, 32, true); // 32-bit (antes: 16)
        write(36, "data");
        view.setUint32(40, dataSize, true);
        return new Blob([header, ...chunks], { type: "audio/wav" });
      }

      async function runLivePreview() {
        if (!selectedFile) return;
        if (previewAbortController) previewAbortController.abort();
        if (previewWS) {
          try {
            previewWS.close();
          } catch (e) {}
          previewWS = null;
        }
        // Detener cualquier espectro previo del reproductor
        try { stopPreviewSpectrum(); } catch (e) {}
        previewAbortController = new AbortController();
        const wrap = document.getElementById("previewWrap");
        wrap.style.display = "block";
        setPreviewUpdating(true);
        setPreviewStatus("Streaming preview + meters en tiempo real…");

        try {
          const ws = new WebSocket(wsUrlFor("/ws/master-stream"));
          previewWS = ws;
          const pcmChunks = [];
          let sampleRate = 44100,
            channels = 2,
            lastMetrics = null;
          previewAbortController.signal.addEventListener("abort", () => {
            try {
              ws.close();
            } catch (e) {}
          });

          await new Promise((resolve, reject) => {
            ws.binaryType = "arraybuffer";
            ws.onopen = async () => {
              const cfg = Object.fromEntries(buildParams().entries());
              cfg.chunk_seconds = 0.35;
              cfg.output_format = "wav";
              cfg.preview_seconds = 10;
              cfg.session_id = _previewSessionId; // para que el servidor identifique la sesión y evite re-upload
              if (_previewLibraryId) cfg.library_id = _previewLibraryId; // archivo elegido desde la librería del server
              console.log("[preview] enviando config al backend:", cfg);
              ws.send(JSON.stringify(cfg));
              // BUGFIX: antes acá mismo, sin esperar nada, ya se leía el
              // archivo completo y se mandaba en trozos — pasaba SIEMPRE,
              // cache hit o no, porque no había ninguna espera de por medio.
              // Por eso el ahorro de banda de session_id/library_id nunca
              // funcionaba de verdad: el servidor podía reusar su caché,
              // pero el cliente igual subía el archivo entero en paralelo.
              // Ahora el envío de bytes se movió a ws.onmessage, disparado
              // únicamente por el evento explícito "need_upload" del
              // servidor — si hay cache o library_id server-side, el
              // servidor manda "use_cache" en su lugar y acá no se sube
              // absolutamente nada.
            };
            const uploadFile = async () => {
              // Usar buffer cacheado en lugar de releer el archivo desde disco
              const buf = cachedFileBuffer || (await selectedFile.arrayBuffer());
              if (!cachedFileBuffer) cachedFileBuffer = buf;

              // El archivo se envía en trozos (256KB) en vez de un único
              // frame binario gigante. Esto evita bloquear el event loop
              // del navegador/servidor con payloads enormes y permite
              // aplicar backpressure real: si el socket todavía tiene datos
              // pendientes de enviar (bufferedAmount alto), esperamos antes
              // de encolar el siguiente trozo en vez de amontonar todo de
              // una. Al terminar, se avisa al backend con un frame de texto
              // {"event":"upload_complete"} para que sepa que ya puede
              // ensamblar el archivo completo y arrancar el procesamiento.
              const CHUNK_SIZE = 256 * 1024; // 256KB por trozo
              const BACKPRESSURE_LIMIT = CHUNK_SIZE * 4;
              for (let offset = 0; offset < buf.byteLength; offset += CHUNK_SIZE) {
                if (ws.readyState !== WebSocket.OPEN) break;
                const slice = buf.slice(offset, offset + CHUNK_SIZE);
                while (ws.bufferedAmount > BACKPRESSURE_LIMIT) {
                  await new Promise((r) => setTimeout(r, 20));
                }
                ws.send(slice);
              }
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ event: "upload_complete" }));
              }
            };
            ws.onmessage = (ev) => {
              if (typeof ev.data === "string") {
                const msg = JSON.parse(ev.data);
                if (msg.event === "use_cache") {
                  // El servidor ya tiene el audio (caché de sesión o
                  // librería) → solo mandamos parámetros, sin subir nada.
                  ws.send(JSON.stringify({ event: "params_only" }));
                  return;
                }
                if (msg.event === "need_upload") {
                  // Única señal que dispara la subida real del archivo.
                  uploadFile();
                  return;
                }
                if (msg.event === "lufs_safety") {
                  // Corrección de input_gain_db calculada por el safety-check
                  // de LUFS antes de arrancar el stream de chunks.
                  setPreviewStatus(
                    `Ajustando loudness: gain corregido a ${msg.corrected_input_gain_db >= 0 ? "+" : ""}${msg.corrected_input_gain_db} dB (objetivo ${msg.target_lufs} LUFS)…`,
                  );
                  return;
                }
                if (msg.event === "chunk") {
                  lastMetrics = msg.metrics || null;
                  sampleRate = msg.sample_rate || sampleRate;
                  channels = msg.channels || channels;
                  updateMainMetersFromMetrics(lastMetrics);
                  if (lastMetrics?.spectrum?.bands_db) drawJobSpectrum(lastMetrics.spectrum.bands_db);
                  if (lastMetrics?.dynamic_eq_recommendation)
                    renderDynEqRecommendation(lastMetrics.dynamic_eq_recommendation);
                  const pct = lastMetrics?.progress_pct != null ? ` ${lastMetrics.progress_pct.toFixed(1)}%` : "";
                  setPreviewStatus(`Meters en vivo${pct}…`);
                } else if (msg.event === "done") resolve();
                else if (msg.event === "error") reject(new Error(msg.message || "Error de streaming"));
              } else {
                pcmChunks.push(ev.data);
              }
            };
            ws.onerror = (ev) => {
              console.error("[preview] error de WebSocket:", ev);
              reject(new Error("No se pudo abrir /ws/master-stream"));
            };
            ws.onclose = (ev) => {
              console.log(
                "[preview] WebSocket cerrado — code:",
                ev.code,
                "reason:",
                ev.reason,
                "wasClean:",
                ev.wasClean,
              );
              if (!lastMetrics) {
                const detail = [];
                if (ev.code) detail.push(`código ${ev.code}`);
                if (ev.reason) detail.push(`"${ev.reason}"`);
                const extra = detail.length
                  ? ` (${detail.join(" — ")})`
                  : " — el servidor cerró la conexión sin dar motivo, revisá los logs del backend";
                reject(new Error("Streaming cerrado antes de recibir audio" + extra));
              }
            };
          });

          // ── FFT del preview (desde el PCM float32 del WS - suficiente para visualización) ──
          const blob16 = wavBlobFromPcm16(pcmChunks, sampleRate, channels);
          const ab16 = await blob16.arrayBuffer();
          const audCtxFFT = new (window.AudioContext || window.webkitAudioContext)();
          let decodedBuf;
          try {
            decodedBuf = await audCtxFFT.decodeAudioData(ab16.slice(0));
          } finally {
            audCtxFFT.close();
          }
          const mono =
            decodedBuf.numberOfChannels > 1
              ? (() => {
                  const c0 = decodedBuf.getChannelData(0),
                    c1 = decodedBuf.getChannelData(1),
                    m = new Float32Array(c0.length);
                  for (let i = 0; i < c0.length; i++) m[i] = (c0[i] + c1[i]) / 2;
                  return m;
                })()
              : decodedBuf.getChannelData(0);
          const previewFFT = await computeFFTAsync(mono, decodedBuf.sampleRate, 96);
          const series = [];
          if (originalFFTCache) series.push({ label: "Original", data: originalFFTCache, color: "var(--muted)" });
          series.push({ label: "Con tus ajustes", data: previewFFT, color: "var(--accent)" });
          drawFFTOnCanvas(document.getElementById("previewCanvas"), series);
          hideLiveSpectrum();

          // ── Audio player: /preview HTTP → process_audio completo (dither + encode real) ──
          // El WS stream es para meters/FFT en vivo (rápido, baja latencia). Para lo que
          // realmente se ESCUCHA usamos /preview, que corre la cadena idéntica al master
          // final: misma función (process_audio), mismo dither TPDF, mismo encode. Así el
          // preview que escuchás nunca difiere del master real (importa sobre todo cerca
          // del techo, con clipper/limiter agresivos).
          setPreviewStatus("Procesando audio de alta calidad…");
          try {
            const hqParams = buildParams();
            hqParams.set("preview_seconds", "30"); // más largo para el player
            hqParams.set("output_format", "wav");
            hqParams.set("output_bit_depth", "24");
            const hqUrl = `${API()}/preview?${hqParams.toString()}`;
            const hqFormData = new FormData();
            hqFormData.append("file", selectedFile);
            const hqResp = await fetch(hqUrl, {
              method: "POST",
              body: hqFormData,
              signal: previewAbortController.signal,
            });
            if (hqResp.ok) {
              const hqBlob = await hqResp.blob();
              if (previewAudioUrl) URL.revokeObjectURL(previewAudioUrl);
              previewAudioUrl = URL.createObjectURL(hqBlob);
              document.getElementById("previewAudioWrap").innerHTML =
                `<audio controls src="${previewAudioUrl}" style="width:100%"></audio>
                 <div style="font-size:.7rem;color:var(--muted);margin-top:.2rem">▲ 24-bit WAV · cadena completa · idéntico al master final</div>`;
              const _audioEl = document.querySelector('#previewAudioWrap audio');
              if (_audioEl) startPreviewSpectrum(_audioEl);
              setPreviewStatus("Preview listo ✓ · 24-bit · cadena completa");
            } else {
              // Fallback: usar el PCM del WS si /preview falla
              if (previewAudioUrl) URL.revokeObjectURL(previewAudioUrl);
              previewAudioUrl = URL.createObjectURL(blob16);
              document.getElementById("previewAudioWrap").innerHTML = `<audio controls src="${previewAudioUrl}"></audio>`;
              const _audioEl2 = document.querySelector('#previewAudioWrap audio');
              if (_audioEl2) startPreviewSpectrum(_audioEl2);
              setPreviewStatus("Preview listo (calidad estándar — /preview no disponible)");
            }
          } catch (hqErr) {
            if (hqErr.name === "AbortError") return;
            // Fallback silencioso
            if (previewAudioUrl) URL.revokeObjectURL(previewAudioUrl);
            previewAudioUrl = URL.createObjectURL(blob16);
              document.getElementById("previewAudioWrap").innerHTML = `<audio controls src="${previewAudioUrl}"></audio>`;
              const _audioEl3 = document.querySelector('#previewAudioWrap audio');
              if (_audioEl3) startPreviewSpectrum(_audioEl3);
            setPreviewStatus("Preview listo ✓ · meters actualizados en tiempo real");
          }
          setPreviewUpdating(false);
        } catch (e) {
          if (e.name === "AbortError") return;
          setPreviewUpdating(false);
          setPreviewStatus("Error: " + e.message);
        } finally {
          previewWS = null;
        }
      }

      const previewTriggerIds = [
        "s-ingain",
        "s-peak",
        "s-uselufs",
        "s-lufstarget",
        "s-thresh",
        "s-ratio",
        "s-cattack",
        "s-crelease",
        "s-cmakeup",
        "s-comp-link",
        "s-oversample",
        "s-glue-bypass",
        "s-glue-thresh",
        "s-glue-ratio",
        "s-glue-attack",
        "s-glue-release",
        "s-glue-makeup",
        "s-hp",
        "s-air",
        "s-shelf-freq",
        "s-mb-sw-lowx",
        "s-mb-sw-highx",
        "s-mb-sw-low",
        "s-mb-sw-mid",
        "s-mb-sw-high",
        "s-eq1freq",
        "s-eq1gain",
        "s-eq1q",
        "s-eq2freq",
          "s-eq2gain",
          "s-eq2q",
        "s-eq3freq",
        "s-eq3gain",
        "s-eq3q",
        "s-eq4freq",
          "s-eq4gain",
          "s-eq4q",
        "s-eq5freq",
        "s-eq5gain",
        "s-eq5q",
        "s-eq6freq",
        "s-eq6gain",
        "s-eq6q",
        "s-tatt",
        "s-tsus",
        "s-satdrive",
        "s-satmode",
        "s-satmix",
        "s-mgain",
        "s-sgain",
        "s-width",
        "s-enhancer",
        "s-haas",
        "s-bassmono",
        "s-rsize",
        "s-rwet",
        "s-ceiling",
        "s-lrelease",
        "s-format",
        "s-mb-lowx",
        "s-mb-highx",
        "s-mb-low-th",
        "s-mb-low-ratio",
        "s-mb-low-att",
        "s-mb-low-rel",
        "s-mb-low-mu",
        "s-mb-mid-th",
        "s-mb-mid-ratio",
        "s-mb-mid-att",
        "s-mb-mid-rel",
        "s-mb-mid-mu",
        "s-mb-high-th",
        "s-mb-high-ratio",
        "s-mb-high-att",
        "s-mb-high-rel",
        "s-mb-high-mu",
        "mb-bypass",
        "s-dyneq-bypass",
        "s-dyneq-freq",
        "s-dyneq-q",
        "s-dyneq-thresh",
        "s-dyneq-ratio",
        "s-dyneq-attack",
        "s-dyneq-release",
        "s-dyneq-maxred",
        "s-reso-bypass",
        "s-reso-freq",
        "s-reso-q",
        "s-reso-thresh",
        "s-reso-ratio",
        "s-reso-attack",
        "s-reso-release",
        "s-reso-maxred",
        "s-mono-freq",
        "s-mono-amount",
        "s-eq-mode",
        "s-lp-taps",
      ];
      previewTriggerIds.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        const evt = el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input";
        el.addEventListener(evt, schedulePreview);
      });

      // ── Dashboard ────────────────────────────────────────────────────────────────
      let dashboardWS = null,
        dashboardPollTimer = null;
      function renderDashboard(stats) {
        document.getElementById("dashCpu").textContent = stats.cpu_percent.toFixed(1) + "%";
        document.getElementById("dashCpuBar").style.width = Math.min(100, stats.cpu_percent) + "%";
        document.getElementById("dashRam").textContent = stats.ram_percent.toFixed(1) + "%";
        document.getElementById("dashRamBar").style.width = Math.min(100, stats.ram_percent) + "%";
        document.getElementById("dashQueueTotal").textContent = stats.queue.total;
        document.getElementById("dashQueued").textContent = `en cola: ${stats.queue.queued}`;
        document.getElementById("dashProcessing").textContent = `procesando: ${stats.queue.processing}`;
        if (stats.active_job) {
          const eta = stats.active_job.eta_sec;
          document.getElementById("dashEta").textContent = eta != null ? `~${eta}s restante` : "Procesando…";
          document.getElementById("dashActiveFile").textContent = stats.active_job.filename || "";
        } else {
          document.getElementById("dashEta").textContent = "Inactivo";
          document.getElementById("dashActiveFile").textContent = "";
        }
      }
      function startDashboardPolling() {
        stopDashboard();
        dashboardPollTimer = setInterval(async () => {
          try {
            const res = await fetch(`${API()}/dashboard`);
            if (!res.ok) return;
            renderDashboard(await res.json());
          } catch (e) {}
        }, 2000);
      }
      function stopDashboard() {
        if (dashboardWS) {
          try {
            dashboardWS.close();
          } catch (e) {}
          dashboardWS = null;
        }
        if (dashboardPollTimer) {
          clearInterval(dashboardPollTimer);
          dashboardPollTimer = null;
        }
      }
      function startDashboard() {
        stopDashboard();
        let wsUrl;
        try {
          const apiUrl = new URL(API());
          wsUrl = `${apiUrl.protocol === "https:" ? "wss" : "ws"}://${apiUrl.host}/ws/dashboard`;
        } catch (e) {
          startDashboardPolling();
          return;
        }
        try {
          dashboardWS = new WebSocket(wsUrl);
          dashboardWS.onmessage = (ev) => {
            try {
              renderDashboard(JSON.parse(ev.data));
            } catch (e) {}
          };
          dashboardWS.onerror = () => {
            stopDashboard();
            startDashboardPolling();
          };
          dashboardWS.onclose = () => {
            if (!dashboardPollTimer) startDashboardPolling();
          };
        } catch (e) {
          startDashboardPolling();
        }
      }
      document.getElementById("dashToggle").addEventListener("click", () => {
        const body = document.getElementById("dashboardBody");
        const hidden = body.style.display === "none";
        body.style.display = hidden ? "block" : "none";
        document.getElementById("dashToggle").textContent = hidden ? "ocultar" : "mostrar";
      });
      startDashboard();
      document.getElementById("apiUrl").addEventListener("change", startDashboard);

      // ── Live Meters ──────────────────────────────────────────────────────────────
      function dbFromLinear(v) {
        return v > 1e-9 ? 20 * Math.log10(v) : -100;
      }

      function setupLiveMeters(audioBuffer) {
        teardownLiveMeters();
        document.getElementById("metersWrap").style.display = "block";
        metersAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const src = metersAudioCtx.createBufferSource();
        src.buffer = audioBuffer;
        src.loop = true;
        metersSplitter = metersAudioCtx.createChannelSplitter(2);
        metersAnalyserL = metersAudioCtx.createAnalyser();
        metersAnalyserR = metersAudioCtx.createAnalyser();
        metersAnalyserL.fftSize = 2048;
        metersAnalyserR.fftSize = 2048;
        metersAnalyserL.minDecibels = -85;
        metersAnalyserL.maxDecibels = -5;
        metersAnalyserR.minDecibels = -85;
        metersAnalyserR.maxDecibels = -5;
        metersAnalyserL.smoothingTimeConstant = 0.7;
        metersAnalyserR.smoothingTimeConstant = 0.7;
        const gain = metersAudioCtx.createGain();
        gain.gain.value = 0;
        src.connect(metersSplitter);
        metersSplitter.connect(metersAnalyserL, 0);
        if (audioBuffer.numberOfChannels > 1) metersSplitter.connect(metersAnalyserR, 1);
        else metersSplitter.connect(metersAnalyserR, 0);
        metersAnalyserL.connect(gain);
        gain.connect(metersAudioCtx.destination);
        // Algunos navegadores mantienen el AudioContext en 'suspended' hasta
        // que haya una interacción del usuario. Intentamos reanudarlo antes
        // de arrancar la fuente para asegurar que el loop de análisis corra.
        try {
          if (metersAudioCtx.state === "suspended") {
            metersAudioCtx.resume().catch(() => {});
          }
        } catch (e) {}
        // Arrancar la fuente una vez solicitado el resume (siempre que sea posible)
        try {
          src.start(0);
        } catch (e) {
          /* si falla, start se intentará al reanudar */
        }
        metersSourceNode = src;
        metersLufsRingBuffer = [];
        const bufL = new Float32Array(metersAnalyserL.fftSize);
        const bufR = new Float32Array(metersAnalyserR.fftSize);
        const freqDataL = new Uint8Array(metersAnalyserL.frequencyBinCount);
        const freqDataR = new Uint8Array(metersAnalyserR.frequencyBinCount);
        const spectrumCanvas = document.getElementById("liveSpectrumCanvas");
        function tick() {
          metersAnalyserL.getFloatTimeDomainData(bufL);
          metersAnalyserR.getFloatTimeDomainData(bufR);
          let peak = 0,
            sumSq = 0,
            sumLR = 0,
            sumL2 = 0,
            sumR2 = 0;
          let truePeak = 0;
          for (let i = 0; i < bufL.length; i++) {
            const l = bufL[i],
              r = bufR[i];
            const mono = (l + r) / 2;
            peak = Math.max(peak, Math.abs(l), Math.abs(r));
            sumSq += mono * mono;
            sumLR += l * r;
            sumL2 += l * l;
            sumR2 += r * r;
            // True Peak: interp lineal entre muestras contiguas (oversampling x2)
            if (i > 0) {
              const lPrev = bufL[i - 1], rPrev = bufR[i - 1];
              const lMid = (lPrev + l) / 2, rMid = (rPrev + r) / 2;
              truePeak = Math.max(truePeak, Math.abs(lMid), Math.abs(rMid));
            }
            truePeak = Math.max(truePeak, Math.abs(l), Math.abs(r));
          }
          const rms = Math.sqrt(sumSq / bufL.length);
          const peakDb = dbFromLinear(peak),
            rmsDb = dbFromLinear(rms);
          const truePeakDb = dbFromLinear(truePeak);
          // Pseudo-LUFS mejorado: promedio energético L+R con offset ITU-R BS.1770 (-0.691 dB)
          const rmsL = Math.sqrt(sumL2 / bufL.length);
          const rmsR = Math.sqrt(sumR2 / bufR.length);
          const lufsLin = (rmsL * rmsL + rmsR * rmsR) / 2; // energía media canales
          const pseudoLufs = (lufsLin > 1e-9 ? 10 * Math.log10(lufsLin) : -100) - 0.691;
          metersLufsRingBuffer.push(pseudoLufs);
          if (metersLufsRingBuffer.length > METERS_LUFS_WINDOW) metersLufsRingBuffer.shift();
          const avgLufs = metersLufsRingBuffer.reduce((a, b) => a + b, 0) / metersLufsRingBuffer.length;
          const denom = Math.sqrt(sumL2 * sumR2);
          const corr = denom > 1e-9 ? sumLR / denom : 1.0;
          updateMeterFill("meterPeakFill", "meterPeakReadout", peakDb, (v) => v.toFixed(1) + " dB");
          updateMeterFill("meterRmsFill", "meterRmsReadout", rmsDb, (v) => v.toFixed(1) + " dB");
          updateMeterFill("meterLufsFill", "meterLufsReadout", avgLufs, (v) => v.toFixed(1) + " LUFS", -40);
          updateMeterFill("meterTruePeakFill", "meterTruePeakReadout", truePeakDb, (v) => v.toFixed(1) + " dBTP", -40);
          updateStereoMeter(corr);
          metersAnalyserL.getByteFrequencyData(freqDataL);
          metersAnalyserR.getByteFrequencyData(freqDataR);
          drawLiveSpectrum(
            spectrumCanvas,
            freqDataL,
            freqDataR,
            metersAudioCtx.sampleRate,
            metersAnalyserL.minDecibels,
            metersAnalyserL.maxDecibels,
          );
          updateFreqBands(
            freqDataL,
            freqDataR,
            metersAudioCtx.sampleRate,
            metersAnalyserL.minDecibels,
            metersAnalyserL.maxDecibels,
          );
          metersRafId = requestAnimationFrame(tick);
        }
        tick();
      }

      // Cache de elementos del DOM para los meters: updateMeterFill/updateStereoMeter
      // se llaman en el loop de requestAnimationFrame (hasta 60 veces por segundo)
      // mientras haya un archivo cargado, así que evitamos volver a buscarlos por id
      // en cada frame — los ids son fijos y ya existen en el HTML al cargar la página.
      const _elCache = new Map();
      function cachedEl(id) {
        let el = _elCache.get(id);
        if (el === undefined) {
          el = document.getElementById(id);
          _elCache.set(id, el);
        }
        return el;
      }
      // minDb: piso del meter (ej: -60 para Peak/RMS, -40 para LUFS/TruePeak)
      // maxDb: techo (0 dB nominal). Ajustá minDb para cambiar la sensibilidad visual.
      function updateMeterFill(fillId, readoutId, db, fmt, minDb = -60, maxDb = 0) {
        const range = maxDb - minDb;
        const pct = Math.max(0, Math.min(100, ((db - minDb) / range) * 100));
        const fillEl = cachedEl(fillId);
        const readEl = cachedEl(readoutId);
        if (!fillEl) return;
        fillEl.style.height = pct + "%";
        if (readEl) readEl.textContent = db <= -99 ? "-∞" : fmt(db);
        // Color dinámico: verde → amarillo → rojo según nivel
        const warn = maxDb - 6, danger = maxDb - 1;
        if (db >= danger) {
          fillEl.style.background = "var(--vu-red, #e05539)";
        } else if (db >= warn) {
          fillEl.style.background = "var(--vu-yellow, #e8d220)";
        } else {
          fillEl.style.background = "var(--vu-green, #39e05a)";
        }
      }

      function updateMainMetersFromMetrics(metrics) {
        if (!metrics) return;
        document.getElementById("metersWrap").style.display = "block";
        if (metrics.peak_db != null)
          updateMeterFill("meterPeakFill", "meterPeakReadout", metrics.peak_db, (v) => v.toFixed(1) + " dB");
        if (metrics.rms_db != null)
          updateMeterFill("meterRmsFill", "meterRmsReadout", metrics.rms_db, (v) => v.toFixed(1) + " dB");
        if (metrics.lufs_momentary != null)
          updateMeterFill("meterLufsFill", "meterLufsReadout", metrics.lufs_momentary, (v) => v.toFixed(1) + " LUFS", -40);
        if (metrics.true_peak_db != null)
          updateMeterFill("meterTruePeakFill", "meterTruePeakReadout", metrics.true_peak_db, (v) => formatDbValue(v), -40);
        if (metrics.stereo_correlation != null) updateStereoMeter(metrics.stereo_correlation);
        if (metrics.mono_compatibility_db != null) {
          const monoEl = document.getElementById("monoCompatReadout");
          if (monoEl) monoEl.textContent = `mono: ${metrics.mono_compatibility_db.toFixed(2)} dB`;
        }
        renderChainMeters({
          mb: metrics.mb_meters || {},
          comp: metrics.comp_meters || {},
          glue: metrics.glue_meters || { bypass: true },
          dyneq: metrics.dyneq_meters || { bypass: true },
          reso: metrics.reso_meters || { bypass: true },
          ms_comp: metrics.ms_comp_meters || { bypass: true, mid: {}, side: {} },
          pre_limiter: metrics.pre_limiter || {},
          post_limiter: metrics.post_limiter || {
            rms_db: metrics.rms_db,
            peak_db: metrics.peak_db,
            lufs: metrics.lufs_momentary,
            stereo_correlation: metrics.stereo_correlation,
          },
        });
      }

      function updateStereoMeter(corr) {
        const c = Math.max(-1, Math.min(1, corr));
        const pct = ((c + 1) / 2) * 100;
        const fill = cachedEl("stereoMeterFill");
        if (!fill) return;
        if (c >= 0) {
          fill.style.left = "50%";
          fill.style.width = pct - 50 + "%";
        } else {
          fill.style.left = pct + "%";
          fill.style.width = 50 - pct + "%";
        }
        const read = cachedEl("stereoMeterReadout");
        if (read)
          read.textContent = `corr: ${c.toFixed(2)} (${c > 0.8 ? "mono-ish" : c < -0.2 ? "fuera de fase" : "estéreo"})`;
      }

      // ── Multiband GR & VU Meters (chain_meters from job result / streaming) ──────
      function renderChainMeters(chainMeters) {
        if (!chainMeters) return;
        const mb = chainMeters.mb || {};
        const comp = chainMeters.comp || {};
        const parallel = chainMeters.parallel || {};
        const glue = chainMeters.glue || {};
        const dyneq = chainMeters.dyneq || {};
        const reso = chainMeters.reso || {};
        const ms_comp = chainMeters.ms_comp || {};
        const pre = chainMeters.pre_limiter || {};
        const post = chainMeters.post_limiter || {};

        // Show the section
        const sect = document.getElementById("mbGrSection");
        if (sect) sect.style.display = "block";

        // GR bars: gr_db is <= 0; clamp to [-24, 0] and display as 0-100% width
        function updateGrBar(barId, readId, grDb, bypassText) {
          const el = document.getElementById(barId);
          const rd = document.getElementById(readId);
          if (bypassText != null) {
            if (el) el.style.width = "0%";
            if (rd) rd.textContent = bypassText;
            return;
          }
          const pct = Math.max(0, Math.min(100, (-grDb / 24) * 100));
          if (el) el.style.width = pct + "%";
          if (rd) rd.textContent = (grDb <= 0 ? "" : "+") + grDb.toFixed(1) + " dB";
        }
        updateGrBar("grBarLow", "grReadLow", mb.low_gr_db ?? 0);
        updateGrBar("grBarMid", "grReadMid", mb.mid_gr_db ?? 0);
        updateGrBar("grBarHigh", "grReadHigh", mb.high_gr_db ?? 0);

        // Compresor de banda ancha ("Dinámica") — siempre activo en la cadena
        updateGrBar("grBarComp", "grReadComp", comp.gr_db ?? 0);

        // Glue compressor — bypass por defecto, se muestra "bypass" si no está activo
        if (glue.bypass === false) {
          updateGrBar("grBarGlue", "grReadGlue", glue.gr_db ?? 0);
        } else {
          updateGrBar("grBarGlue", "grReadGlue", 0, "bypass");
        }

        // Compresión paralela — bypass por defecto, se muestra "bypass" si no está activa
        if (parallel.bypass === false) {
          updateGrBar("grBarParallel", "grReadParallel", parallel.gr_db ?? 0);
        } else {
          updateGrBar("grBarParallel", "grReadParallel", 0, "bypass");
        }

        // De-esser dedicado (banda de Dynamic EQ ~5-6 kHz, etapa 7)
        const dyneqBypassEl = document.getElementById("s-dyneq-bypass");
        const dyneqBypassed = dyneq.bypass ?? (dyneqBypassEl ? !dyneqBypassEl.checked : false);
        if (dyneqBypassed) {
          updateGrBar("grBarDeess", "grReadDeess", 0, "bypass");
        } else {
          updateGrBar("grBarDeess", "grReadDeess", dyneq.gr_db ?? 0);
        }

        // Dynamic EQ — banda de resonancias (etapa 3, ~785-1576 Hz)
        const resoBypassEl = document.getElementById("s-reso-bypass");
        const resoBypassed = reso.bypass ?? (resoBypassEl ? !resoBypassEl.checked : false);
        if (resoBypassed) {
          updateGrBar("grBarReso", "grReadReso", 0, "bypass");
        } else {
          updateGrBar("grBarReso", "grReadReso", reso.gr_db ?? 0);
        }

        // Compresor Mid/Side (etapa 4b) — cada canal (mid/side) reporta su
        // propio gr_db vía compressor(); si ratio<=1.0 ese canal individual
        // queda efectivamente en passthrough aunque el bloque no esté en
        // bypass global.
        if (ms_comp.bypass !== false) {
          updateGrBar("grBarMsCompMid", "grReadMsCompMid", 0, "bypass");
          updateGrBar("grBarMsCompSide", "grReadMsCompSide", 0, "bypass");
        } else {
          updateGrBar("grBarMsCompMid", "grReadMsCompMid", ms_comp.mid?.gr_db ?? 0);
          updateGrBar("grBarMsCompSide", "grReadMsCompSide", ms_comp.side?.gr_db ?? 0);
        }

        function fmt(v) {
          return v != null ? v.toFixed(1) + " dB" : "--";
        }
        function fmtL(v) {
          return v != null ? v.toFixed(1) + " LUFS" : "--";
        }

        const e = (id) => document.getElementById(id);
        if (e("vuPreRms")) e("vuPreRms").textContent = fmt(pre.rms_db);
        if (e("vuPrePeak")) e("vuPrePeak").textContent = fmt(pre.peak_db);
        if (e("vuPostRms")) e("vuPostRms").textContent = fmt(post.rms_db);
        if (e("vuPostPeak")) e("vuPostPeak").textContent = fmt(post.peak_db);
        if (e("vuPostLufs")) e("vuPostLufs").textContent = fmtL(post.lufs);
      }

      // ── Espectrómetro en tiempo real ─────────────────────────────────────────────
      // Reutiliza los mismos AnalyserNode ya creados para los meters (peak/rms/lufs),
      // así que no agrega ningún AudioContext ni nodo extra — solo lee también el
      // dominio de frecuencia (getByteFrequencyData) del mismo grafo de audio.
      let _specXCache = null; // cache de mapeo bin→x en escala log, invalidado si cambia el tamaño del canvas
      function drawLiveSpectrum(canvas, dataL, dataR, sampleRate) {
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        const cssWidth = canvas.clientWidth || 280,
          cssHeight = 90;
        if (canvas._lastCssW !== cssWidth || canvas._lastDpr !== dpr) {
          canvas.width = cssWidth * dpr;
          canvas.height = cssHeight * dpr;
          canvas._lastCssW = cssWidth;
          canvas._lastDpr = dpr;
        }
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const theme = themeColors();
        ctx.fillStyle = theme.surface2;
        ctx.fillRect(0, 0, cssWidth, cssHeight);

        const nyquist = sampleRate / 2;
        const binHz = nyquist / dataL.length;
        const fMin = 30,
          fMax = Math.min(20000, nyquist);
        const padL = 32,
          padB = 15,
          padT = 6,
          padR = 6;
        const plotW = cssWidth - padL - padR,
          plotH = cssHeight - padT - padB;

        if (
          !_specXCache ||
          _specXCache.width !== cssWidth ||
          _specXCache.binHz !== binHz ||
          _specXCache.len !== dataL.length
        ) {
          const startBin = Math.max(1, Math.floor(fMin / binHz));
          const xs = new Float32Array(dataL.length);
          const logMin = Math.log10(fMin),
            logRange = Math.log10(fMax) - logMin;
          for (let i = startBin; i < dataL.length; i++) {
            const freq = i * binHz;
            xs[i] = freq > fMax ? -1 : padL + ((Math.log10(freq) - logMin) / logRange) * plotW;
          }
          _specXCache = { width: cssWidth, binHz, len: dataL.length, startBin, xs };
        }
        const { startBin, xs } = _specXCache;

        ctx.strokeStyle = theme.border;
        ctx.fillStyle = theme.muted;
        ctx.font = "9px monospace";
        ctx.lineWidth = 1;
        [100, 1000, 10000].forEach((f) => {
          if (f < fMin || f > fMax) return;
          const x = padL + ((Math.log10(f) - Math.log10(fMin)) / (Math.log10(fMax) - Math.log10(fMin))) * plotW;
          ctx.beginPath();
          ctx.moveTo(x, padT);
          ctx.lineTo(x, padT + plotH);
          ctx.stroke();
          ctx.fillText(f >= 1000 ? f / 1000 + "k" : String(f), x - 8, cssHeight - 3);
        });

        ctx.beginPath();
        let started = false,
          lastX = padL;
        for (let i = startBin; i < dataL.length; i++) {
          const x = xs[i];
          if (x < 0) break;
          const mag = (dataL[i] + dataR[i]) / 2 / 255; // 0..1, ya escalado a minDecibels..maxDecibels por el AnalyserNode
          const y = padT + plotH - mag * plotH;
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else ctx.lineTo(x, y);
          lastX = x;
        }
        if (started) {
          ctx.strokeStyle = theme.accent;
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.lineTo(lastX, padT + plotH);
          ctx.lineTo(padL, padT + plotH);
          ctx.closePath();
          ctx.fillStyle = "rgba(124,92,252,0.16)";
          ctx.fill();
        }
      }

      const FREQ_BANDS = [
        { id: "sub", lo: 20, hi: 60 },
        { id: "bass", lo: 60, hi: 250 },
        { id: "lowmid", lo: 250, hi: 800 },
        { id: "mid", lo: 800, hi: 3000 },
        { id: "highmid", lo: 3000, hi: 8000 },
        { id: "air", lo: 8000, hi: 20000 },
      ];
      function updateFreqBands(dataL, dataR, sampleRate, minDb, maxDb) {
        const nyquist = sampleRate / 2;
        const binHz = nyquist / dataL.length;
        const range = maxDb - minDb;
        FREQ_BANDS.forEach((band) => {
          const iStart = Math.max(1, Math.round(band.lo / binHz));
          const iEnd = Math.min(dataL.length - 1, Math.round(Math.min(band.hi, nyquist) / binHz));
          let avgDb = minDb;
          if (iEnd > iStart) {
            // Suma en dominio de potencia (más representativo de "energía" perceptual que promediar bytes crudos)
            let sumPow = 0;
            for (let i = iStart; i <= iEnd; i++) {
              const bAvg = (dataL[i] + dataR[i]) / 2;
              const db = minDb + (bAvg / 255) * range;
              sumPow += Math.pow(10, db / 10);
            }
            avgDb = 10 * Math.log10(sumPow / (iEnd - iStart + 1) + 1e-12);
          }
          const pct = Math.max(0, Math.min(100, ((avgDb - minDb) / range) * 100));
          cachedEl("fb-" + band.id).style.width = pct + "%";
          cachedEl("fbv-" + band.id).textContent = avgDb <= minDb + 0.5 ? "-∞" : Math.round(avgDb) + "dB";
        });
      }

      function teardownLiveMeters() {
        if (metersRafId) {
          cancelAnimationFrame(metersRafId);
          metersRafId = null;
        }
        if (metersSourceNode) {
          try {
            metersSourceNode.stop();
          } catch (e) {}
          metersSourceNode = null;
        }
        if (metersAudioCtx) {
          try {
            metersAudioCtx.close();
          } catch (e) {}
          metersAudioCtx = null;
        }
      }

      // ── Espectro del reproductor de preview (audio element) ───────────────
      let previewAudioCtx = null;
      let previewSourceNode = null;
      let previewSplitter = null;
      let previewAnalyserL = null;
      let previewAnalyserR = null;
      let previewFreqDataL = null;
      let previewFreqDataR = null;
      let previewSpectrumRafId = null;

      function stopPreviewSpectrum() {
        if (previewSpectrumRafId) {
          cancelAnimationFrame(previewSpectrumRafId);
          previewSpectrumRafId = null;
        }
        try {
          if (previewSourceNode) previewSourceNode.disconnect();
        } catch (e) {}
        try {
          if (previewAnalyserL) previewAnalyserL.disconnect();
        } catch (e) {}
        try {
          if (previewAnalyserR) previewAnalyserR.disconnect();
        } catch (e) {}
        try {
          if (previewSplitter) previewSplitter.disconnect();
        } catch (e) {}
        try {
          if (previewAudioCtx) previewAudioCtx.close();
        } catch (e) {}
        previewAudioCtx = null;
        previewSourceNode = null;
        previewSplitter = null;
        previewAnalyserL = null;
        previewAnalyserR = null;
        previewFreqDataL = null;
        previewFreqDataR = null;
      }

      function startPreviewSpectrum(audioEl) {
        stopPreviewSpectrum();
        try {
          previewAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
          previewSourceNode = previewAudioCtx.createMediaElementSource(audioEl);
          previewSplitter = previewAudioCtx.createChannelSplitter(2);
          previewAnalyserL = previewAudioCtx.createAnalyser();
          previewAnalyserR = previewAudioCtx.createAnalyser();
          previewAnalyserL.fftSize = 2048;
          previewAnalyserR.fftSize = 2048;
          previewAnalyserL.minDecibels = -85;
          previewAnalyserL.maxDecibels = -5;
          previewAnalyserR.minDecibels = -85;
          previewAnalyserR.maxDecibels = -5;
          previewSourceNode.connect(previewSplitter);
          previewSplitter.connect(previewAnalyserL, 0);
          previewSplitter.connect(previewAnalyserR, 1);
          previewAnalyserL.connect(previewAudioCtx.destination);
          // previewAnalyserR.connect(previewAudioCtx.destination); // not necessary to connect twice

          const len = previewAnalyserL.frequencyBinCount;
          previewFreqDataL = new Uint8Array(len);
          previewFreqDataR = new Uint8Array(len);

          const canvas = document.getElementById("previewCanvas");
          function tick() {
            if (!previewAnalyserL) return;
            previewAnalyserL.getByteFrequencyData(previewFreqDataL);
            previewAnalyserR.getByteFrequencyData(previewFreqDataR);
            // Pass analyser decibel range so drawing scales correctly
            drawLiveSpectrum(canvas, previewFreqDataL, previewFreqDataR, previewAudioCtx.sampleRate, previewAnalyserL.minDecibels, previewAnalyserL.maxDecibels);
            updateFreqBands(previewFreqDataL, previewFreqDataR, previewAudioCtx.sampleRate, previewAnalyserL.minDecibels, previewAnalyserL.maxDecibels);
            previewSpectrumRafId = requestAnimationFrame(tick);
          }
          // Try to resume context on user gesture if suspended
          if (previewAudioCtx.state === 'suspended') previewAudioCtx.resume().catch(()=>{});
          previewSpectrumRafId = requestAnimationFrame(tick);
        } catch (err) {
          console.warn('startPreviewSpectrum failed:', err);
          stopPreviewSpectrum();
        }
      }

      document.getElementById("metersToggle").addEventListener("click", () => {
        const body = document.getElementById("metersBody");
        const hidden = body.style.display === "none";
        body.style.display = hidden ? "block" : "none";
        document.getElementById("metersToggle").textContent = hidden ? "ocultar" : "mostrar";
      });

      window.addEventListener("beforeunload", () => {
        stopDashboard();
        teardownLiveMeters();
        try { stopPreviewSpectrum(); } catch (e) {}
      });

      // ═══════════════════════════════════════════════════════════════════════════
      // ── Asistente de IA (estilo LANDR AI) ────────────────────────────────────────
      // ═══════════════════════════════════════════════════════════════════════════

      const AI_SUGGESTIONS = [
        "🤖 Masterizá esto por mí",
        "¿Cómo está el loudness de mi track?",
        "¿Qué preset me conviene?",
        "¿Tengo problemas de clipping?",
      ];

      function aiEl(id) {
        return document.getElementById(id);
      }

      function setAiContext(analysisData) {
        lastAnalysisData = analysisData || null;
        const fab = aiEl("aiFab");
        if (lastAnalysisData) fab.classList.add("has-context");
        else fab.classList.remove("has-context");
      }

      function aiCurrentPreset() {
        const active = document.querySelector(".preset-btn.active");
        return active ? active.dataset.preset : null;
      }

      function aiCurrentPlatform() {
        const sel = aiEl("s-platform");
        return sel && sel.value ? sel.value : null;
      }

      function aiAppendMessage(role, content) {
        const wrap = aiEl("aiMessages");
        const div = document.createElement("div");
        div.className = `ai-msg ${role}`;
        div.textContent = content;
        wrap.appendChild(div);
        wrap.scrollTop = wrap.scrollHeight;
        return div;
      }

      function aiAppendSuggestionCard(suggestedParams, summary, explanation) {
        const wrap = aiEl("aiMessages");
        const card = document.createElement("div");
        card.className = "ai-suggestion-card";

        if (summary) {
          const title = document.createElement("div");
          title.className = "ai-suggestion-card-title";
          title.textContent = summary;
          card.appendChild(title);
        }

        if (explanation) {
          const explain = document.createElement("div");
          explain.className = "ai-suggestion-explanation";
          explain.textContent = explanation;
          card.appendChild(explain);
        }

        const list = document.createElement("ul");
        list.className = "ai-suggestion-card-list";
        Object.entries(suggestedParams).forEach(([key, value]) => {
          const li = document.createElement("li");
          const label = PARAM_LABELS[key] || key;
          let valueText;
          if (typeof value === "boolean") {
            valueText = value ? "activado" : "desactivado";
          } else if (typeof value === "string") {
            valueText = value;
          } else {
            valueText = formatParamValue(value, key);
          }
          li.innerHTML = `<span class="ai-suggestion-param">${label}</span><span class="ai-suggestion-value">${valueText}</span>`;
          list.appendChild(li);
        });
        card.appendChild(list);

        const actions = document.createElement("div");
        actions.className = "ai-suggestion-card-actions";

        const cancelBtn = document.createElement("button");
        cancelBtn.className = "ai-suggestion-cancel-btn";
        cancelBtn.textContent = "Cancelar";
        cancelBtn.addEventListener("click", () => {
          card.remove();
        });
        actions.appendChild(cancelBtn);

        const applyBtn = document.createElement("button");
        applyBtn.className = "ai-suggestion-apply-btn";
        applyBtn.textContent = "Confirmar cambios";
        applyBtn.addEventListener("click", () => {
          applyPresetToUI(suggestedParams);
          activePreset = null;
          document.querySelectorAll(".preset-btn").forEach((b) => b.classList.remove("active"));
          applyBtn.textContent = "✓ Aplicado";
          applyBtn.disabled = true;
          cancelBtn.disabled = true;
          card.classList.add("applied");
        });
        actions.appendChild(applyBtn);
        card.appendChild(actions);

        wrap.appendChild(card);
        wrap.scrollTop = wrap.scrollHeight;
      }

      function aiAppendNote(content) {
        const wrap = aiEl("aiMessages");
        const div = document.createElement("div");
        div.className = "ai-msg system-note";
        div.textContent = content;
        wrap.appendChild(div);
        wrap.scrollTop = wrap.scrollHeight;
      }

      function aiShowTyping() {
        const wrap = aiEl("aiMessages");
        const div = document.createElement("div");
        div.className = "ai-msg assistant typing";
        div.id = "aiTypingIndicator";
        div.innerHTML = "<span></span><span></span><span></span>";
        wrap.appendChild(div);
        wrap.scrollTop = wrap.scrollHeight;
      }

      function aiHideTyping() {
        const el = aiEl("aiTypingIndicator");
        if (el) el.remove();
      }

      function aiRenderSuggestions() {
        const box = aiEl("aiSuggestions");
        box.innerHTML = "";
        AI_SUGGESTIONS.forEach((s) => {
          const btn = document.createElement("button");
          btn.className = "ai-suggestion-btn";
          btn.textContent = s;
          btn.addEventListener("click", () => {
            if (s.includes("Masterizá esto por mí")) {
              if (!selectedFile) {
                aiAppendNote("Primero subí un archivo de audio para poder masterizarlo.");
                return;
              }
              document.getElementById("btnAutoMaster").click();
              return;
            }
            aiEl("aiInput").value = s;
            aiSendMessage();
          });
          box.appendChild(btn);
        });
      }

      async function aiCheckStatus() {
        try {
          const res = await fetch(`${API()}/ai/status`);
          const data = await res.json();
          aiAvailable = !!data.available;
          aiEl("aiStatusLine").textContent = aiAvailable
            ? lastAnalysisData
              ? "Analizando tu track"
              : "Listo para ayudarte"
            : "No configurado";
          aiEl("aiSend").disabled = !aiAvailable;
          if (!aiAvailable) {
            aiAppendNote(data.reason || "El asistente de IA no está configurado en el backend (falta GEMINI_API_KEY).");
          }
        } catch (e) {
          aiAvailable = false;
          aiEl("aiStatusLine").textContent = "Sin conexión al backend";
          aiEl("aiSend").disabled = true;
          aiAppendNote("No se pudo conectar con el backend (" + API() + ") para consultar el asistente.");
        }
      }

      async function aiSendMessage() {
        const input = aiEl("aiInput");
        const msg = input.value.trim();
        if (!msg || aiEl("aiSend").disabled) return;
        input.value = "";
        input.style.height = "auto";
        aiAppendMessage("user", msg);
        aiEl("aiSuggestions").innerHTML = "";
        aiShowTyping();
        aiEl("aiSend").disabled = true;

        try {
          const res = await fetch(`${API()}/ai/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: msg,
              history: aiChatHistory,
              analysis: lastAnalysisData,
              preset: aiCurrentPreset(),
              platform: aiCurrentPlatform(),
            }),
          });
          aiHideTyping();
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
          }
          const data = await res.json();
          aiAppendMessage("assistant", data.reply);
          if (data.suggested_params && Object.keys(data.suggested_params).length) {
            aiAppendSuggestionCard(data.suggested_params, data.suggestion_summary, data.suggestion_explanation);
          }
          aiChatHistory.push({ role: "user", content: msg });
          aiChatHistory.push({ role: "assistant", content: data.reply });
        } catch (e) {
          aiHideTyping();
          console.error("Error en /ai/chat:", e);
          aiAppendNote("Error consultando al asistente: " + e.message);
        } finally {
          aiEl("aiSend").disabled = false;
        }
      }

      aiEl("aiFab").addEventListener("click", () => {
        const panel = aiEl("aiPanel");
        const opening = !panel.classList.contains("open");
        panel.classList.toggle("open");
        if (opening) {
          if (aiAvailable === null) {
            aiAppendMessage(
              "assistant",
              "¡Hola! Soy tu asistente de mastering. Puedo analizar tu track y darte consejos, o directamente masterizarlo por vos: elijo preset, plataforma target y ajustes de nivel según el análisis técnico. ¿En qué te ayudo?",
            );
            aiRenderSuggestions();
            aiCheckStatus();
          }
          aiEl("aiInput").focus();
        }
      });

      aiEl("aiClose").addEventListener("click", () => aiEl("aiPanel").classList.remove("open"));

      aiEl("aiSend").addEventListener("click", aiSendMessage);

      aiEl("aiInput").addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          aiSendMessage();
        }
      });

      aiEl("aiInput").addEventListener("input", function () {
        this.style.height = "auto";
        this.style.height = Math.min(this.scrollHeight, 96) + "px";
      });

      // ── Sidebar tabs ──────────────────────────────────────────────────────────────
      (function () {
        const tabs = document.querySelectorAll("#sidebarTabs .sidebar-tab");
        const container = document.getElementById("sidebarPaneContainer");
        const paneMap = { "pane-archivo": "archivo", "pane-cadena": "cadena", "pane-salida": "salida" };
        const detailsMap = { "pane-archivo": "pasoArchivo", "pane-cadena": "pasoCadena", "pane-salida": "pasoSalida" };

        function switchTab(tab) {
          tabs.forEach((t) => t.classList.remove("active"));
          tab.classList.add("active");
          const pane = tab.dataset.pane;
          const cls = paneMap[pane];
          container.className = container.className.replace(/sidebar-showing-\w+/g, "").trim();
          container.classList.add("sidebar-showing-" + cls);
          // Auto-open the target details
          const det = document.getElementById(detailsMap[pane]);
          if (det && !det.open) det.setAttribute("open", "");
        }

        tabs.forEach((tab) => tab.addEventListener("click", () => switchTab(tab)));
        // Init: open archivo, close others
        const paso1 = document.getElementById("pasoArchivo");
        const paso2 = document.getElementById("pasoCadena");
        const paso3 = document.getElementById("pasoSalida");
        if (paso1) paso1.setAttribute("open", "");
        if (paso2) paso2.removeAttribute("open");
        if (paso3) paso3.removeAttribute("open");
      })();

      // ── UX Fix 1: Toggle DEV panel para URL del servidor ─────────────────────────
      (function () {
        const btn = document.getElementById("devToggleBtn");
        const wrap = document.getElementById("apiUrlWrap");
        let visible = false;
        btn.addEventListener("click", () => {
          visible = !visible;
          wrap.style.display = visible ? "inline-flex" : "none";
          btn.style.borderColor = visible ? "var(--accent)" : "";
          btn.style.color = visible ? "var(--accent)" : "";
          if (visible) document.getElementById("apiUrl").focus();
        });
      })();

      // ── UX Fix 2: Indicador de scroll en el sidebar ───────────────────────────────
      (function () {
        const aside = document.querySelector("aside");
        const hint = document.getElementById("asideScrollHint");
        if (!aside || !hint) return;
        function updateScrollHint() {
          const atBottom = aside.scrollHeight - aside.scrollTop - aside.clientHeight < 20;
          hint.classList.toggle("hidden", atBottom);
        }
        aside.addEventListener("scroll", updateScrollHint, { passive: true });
        updateScrollHint();
        new ResizeObserver(updateScrollHint).observe(aside);
      })();

      // ── UX Fix 4: Revelar botones secundarios al cargar un archivo ────────────────
      (function () {
        const secondaryBtns = ["btnAutoMaster", "btnAiSuggest", "btnAnalyze", "btnAdvice", "btnSpectrum", "btnStems", "btnAB"];
        const origSetFile = window._origSetFile;
        // Hook: observar cuando selectedFile se establece mostrando los botones
        const observer = new MutationObserver(() => {
          if (selectedFile) {
            secondaryBtns.forEach((id) => {
              const el = document.getElementById(id);
              if (el) el.style.display = "";
            });
          }
        });
        // Observar el botón master — cuando se habilita, ya hay archivo
        const masterBtn = document.getElementById("btnMaster");
        if (masterBtn) {
          observer.observe(masterBtn, { attributes: true, attributeFilter: ["disabled"] });
        }
      })();

      // ── UX Fix 5: eliminado ───────────────────────────────────────────────────────
      // (el wrapper anterior nunca se ejecutaba en el click del botón "Enviar" porque
      // el listener ya tenía capturada la referencia original de aiSendMessage antes
      // de que este bloque la reemplazara, y además aiSendMessage() ya maneja sus
      // propios errores con try/catch interno — el wrapper era código muerto)
