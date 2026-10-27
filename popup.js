// Suarlog AI - Popup Script (MV3)

document.addEventListener("DOMContentLoaded", async () => {
  // DOM Elements
  const tabs = document.querySelectorAll(".tab-btn");
  const panels = document.querySelectorAll(".tab-panel");
  const headerStatusDot = document.getElementById("headerStatusDot");
  const sessionStatusPill = document.getElementById("sessionStatusPill");
  const durationText = document.getElementById("durationText");
  const slideCountText = document.getElementById("slideCountText");

  const btnToggleRecord = document.getElementById("btnToggleRecord");
  const btnInstantCapture = document.getElementById("btnInstantCapture");
  const btnAnalyzeSummary = document.getElementById("btnAnalyzeSummary");

  const previewContainer = document.getElementById("previewContainer");
  const emptyPreviewMsg = document.getElementById("emptyPreviewMsg");
  const latestScreenshotImg = document.getElementById("latestScreenshotImg");
  const lastCaptureTime = document.getElementById("lastCaptureTime");

  const galleryGrid = document.getElementById("galleryGrid");
  const galleryCount = document.getElementById("galleryCount");
  const btnClearGallery = document.getElementById("btnClearGallery");

  const transcriptFeed = document.getElementById("transcriptFeed");
  const btnCopyTranscript = document.getElementById("btnCopyTranscript");

  const settingsForm = document.getElementById("settingsForm");
  const teleBotTokenInput = document.getElementById("teleBotToken");
  const teleChatIdInput = document.getElementById("teleChatId");
  const aiBaseUrlInput = document.getElementById("aiBaseUrl");
  const aiApiKeyInput = document.getElementById("aiApiKey");
  const aiModelInput = document.getElementById("aiModel");
  const analysisModeSelect = document.getElementById("analysisMode");
  const sendSlideToTeleSelect = document.getElementById("sendSlideToTele");
  const autoSummaryIntervalInput = document.getElementById("autoSummaryInterval");
  const btnTestTele = document.getElementById("btnTestTele");
  const saveNotice = document.getElementById("saveNotice");

  // Tab Navigation
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const targetPanelId = tab.getAttribute("data-tab");
      tabs.forEach(t => {
        t.classList.remove("active");
        t.setAttribute("aria-selected", "false");
      });
      panels.forEach(p => p.classList.remove("active"));

      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");
      document.getElementById(targetPanelId)?.classList.add("active");
    });
  });

  // Default configuration fallback
  const DEFAULTS = {
    teleBotToken: "",
    teleChatId: "949694019",
    aiBaseUrl: "http://localhost:20128/v1",
    aiApiKey: "",
    aiModel: "ag/gemini-3.8-flash-high",
    analysisMode: "detailed",
    sendSlideToTele: true,
    autoSummaryInterval: 60
  };

  // Load Settings from chrome.storage.local and local config seed
  async function loadSettings() {
    let localFileConfig = {};
    try {
      const res = await fetch(chrome.runtime.getURL("config.local.json"));
      if (res.ok) {
        localFileConfig = await res.json();
      }
    } catch (_) {}

    const data = await chrome.storage.local.get(Object.keys(DEFAULTS));

    const getVal = (key) => {
      if (data[key] !== undefined && data[key] !== "") return data[key];
      if (localFileConfig[key] !== undefined && localFileConfig[key] !== "") return localFileConfig[key];
      return DEFAULTS[key];
    };

    teleBotTokenInput.value = getVal("teleBotToken") || "";
    teleChatIdInput.value = getVal("teleChatId") || "";
    aiBaseUrlInput.value = getVal("aiBaseUrl") || "";
    aiApiKeyInput.value = getVal("aiApiKey") || "";
    aiModelInput.value = getVal("aiModel") || "";
    analysisModeSelect.value = getVal("analysisMode");
    sendSlideToTeleSelect.value = String(getVal("sendSlideToTele"));
    autoSummaryIntervalInput.value = getVal("autoSummaryInterval");

    // Sync values into chrome.storage.local so they are permanently saved
    const merged = {
      teleBotToken: teleBotTokenInput.value.trim(),
      teleChatId: teleChatIdInput.value.trim(),
      aiBaseUrl: aiBaseUrlInput.value.trim(),
      aiApiKey: aiApiKeyInput.value.trim(),
      aiModel: aiModelInput.value.trim(),
      analysisMode: analysisModeSelect.value,
      sendSlideToTele: sendSlideToTeleSelect.value === "true",
      autoSummaryInterval: parseInt(autoSummaryIntervalInput.value, 10)
    };
    await chrome.storage.local.set(merged);
  }

  // Auto-Save helper function
  let saveDebounceTimer = null;
  async function autoSaveConfig(showIndicator = true) {
    const config = {
      teleBotToken: teleBotTokenInput.value.trim(),
      teleChatId: teleChatIdInput.value.trim(),
      aiBaseUrl: aiBaseUrlInput.value.trim() || DEFAULTS.aiBaseUrl,
      aiApiKey: aiApiKeyInput.value.trim(),
      aiModel: aiModelInput.value.trim() || DEFAULTS.aiModel,
      analysisMode: analysisModeSelect.value,
      sendSlideToTele: sendSlideToTeleSelect.value === "true",
      autoSummaryInterval: parseInt(autoSummaryIntervalInput.value, 10) || DEFAULTS.autoSummaryInterval
    };

    await chrome.storage.local.set(config);

    if (showIndicator) {
      saveNotice.textContent = "✓ Tersimpan otomatis di lokal";
      saveNotice.classList.remove("hidden");
      clearTimeout(saveDebounceTimer);
      saveDebounceTimer = setTimeout(() => {
        saveNotice.classList.add("hidden");
      }, 2000);
    }
  }

  // Trigger auto-save immediately on any input or change event
  [
    teleBotTokenInput,
    teleChatIdInput,
    aiBaseUrlInput,
    aiApiKeyInput,
    aiModelInput,
    autoSummaryIntervalInput
  ].forEach(input => {
    input.addEventListener("input", () => {
      clearTimeout(saveDebounceTimer);
      saveDebounceTimer = setTimeout(() => autoSaveConfig(true), 350);
    });
    input.addEventListener("blur", () => autoSaveConfig(true));
  });

  [analysisModeSelect, sendSlideToTeleSelect].forEach(select => {
    select.addEventListener("change", () => autoSaveConfig(true));
  });

  // Explicit Save button submit
  settingsForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    await autoSaveConfig(true);
  });

  // Test Telegram Notification
  btnTestTele.addEventListener("click", async () => {
    const token = teleBotTokenInput.value.trim();
    const chatId = teleChatIdInput.value.trim();
    if (!token || !chatId) {
      alert("Harap isi Bot Token dan Chat ID Telegram Anda terlebih dahulu.");
      return;
    }

    btnTestTele.disabled = true;
    btnTestTele.textContent = "Mengirim...";
    try {
      const resp = await chrome.runtime.sendMessage({
        action: "TEST_TELEGRAM",
        token,
        chatId
      });
      if (resp && resp.success) {
        alert("Pesan uji coba berhasil dikirim ke Telegram Anda!");
      } else {
        alert("Gagal mengirim ke Telegram: " + (resp?.error || "Cek bot token / chat ID"));
      }
    } catch (err) {
      alert("Error: " + err.message);
    } finally {
      btnTestTele.disabled = false;
      btnTestTele.textContent = "Kirim Tes Notifikasi Telegram";
    }
  });

  // Render Gallery & Transcripts from storage
  async function refreshDataViews() {
    const state = await chrome.storage.local.get([
      "isRecording",
      "startTime",
      "screenshots",
      "transcripts",
      "overallSummary"
    ]);

    // Status UI
    const isRec = Boolean(state.isRecording);
    if (isRec) {
      headerStatusDot.classList.add("active");
      sessionStatusPill.classList.add("recording");
      sessionStatusPill.textContent = "Sedang Memantau";
      btnToggleRecord.classList.add("recording");
      btnToggleRecord.textContent = "Hentikan Monitor";
      btnInstantCapture.disabled = false;
      btnAnalyzeSummary.disabled = false;
    } else {
      headerStatusDot.classList.remove("active");
      sessionStatusPill.classList.remove("recording");
      sessionStatusPill.textContent = "Standby";
      btnToggleRecord.classList.remove("recording");
      btnToggleRecord.textContent = "Mulai Monitor Meeting";
      btnInstantCapture.disabled = true;
      btnAnalyzeSummary.disabled = !state.screenshots?.length && !state.transcripts?.length;
    }

    // Screenshots
    const shots = state.screenshots || [];
    slideCountText.textContent = String(shots.length);
    galleryCount.textContent = String(shots.length);

    if (shots.length > 0) {
      const latest = shots[shots.length - 1];
      latestScreenshotImg.src = latest.dataUrl;
      latestScreenshotImg.classList.remove("hidden");
      emptyPreviewMsg.classList.add("hidden");
      lastCaptureTime.textContent = new Date(latest.timestamp).toLocaleTimeString();

      // Populate Gallery Grid
      galleryGrid.innerHTML = "";
      shots.slice().reverse().forEach((shot, idx) => {
        const item = document.createElement("div");
        item.className = "gallery-item";

        const imgEl = document.createElement("img");
        imgEl.src = shot.dataUrl;
        imgEl.className = "gallery-thumb";
        imgEl.alt = `Slide ${shot.index || (shots.length - idx)}`;

        const metaDiv = document.createElement("div");
        metaDiv.className = "gallery-meta";
        const spanIndex = document.createElement("span");
        spanIndex.textContent = `Slide #${shot.index || (shots.length - idx)}`;
        const spanTime = document.createElement("span");
        spanTime.textContent = new Date(shot.timestamp).toLocaleTimeString();
        metaDiv.appendChild(spanIndex);
        metaDiv.appendChild(spanTime);

        item.appendChild(imgEl);
        item.appendChild(metaDiv);
        galleryGrid.appendChild(item);
      });
    } else {
      latestScreenshotImg.classList.add("hidden");
      emptyPreviewMsg.classList.remove("hidden");
      lastCaptureTime.textContent = "Belum ada";
      galleryGrid.innerHTML = '<div class="empty-state">Belum ada tangkapan slide tersimpan.</div>';
    }

    // Transcripts & Feed
    const transcripts = state.transcripts || [];
    if (transcripts.length > 0 || state.overallSummary) {
      transcriptFeed.innerHTML = "";

      if (state.overallSummary) {
        const summaryCard = document.createElement("div");
        summaryCard.className = "feed-item summary-item";
        
        const metaDiv = document.createElement("div");
        metaDiv.className = "feed-meta";
        const strongEl = document.createElement("strong");
        strongEl.textContent = "Analisis Keseluruhan Meeting";
        const spanEl = document.createElement("span");
        spanEl.textContent = new Date(state.overallSummary.timestamp).toLocaleTimeString();
        metaDiv.appendChild(strongEl);
        metaDiv.appendChild(spanEl);

        const bodyDiv = document.createElement("div");
        bodyDiv.className = "feed-body";
        bodyDiv.textContent = state.overallSummary.text;

        summaryCard.appendChild(metaDiv);
        summaryCard.appendChild(bodyDiv);
        transcriptFeed.appendChild(summaryCard);
      }

      transcripts.slice().reverse().forEach(t => {
        const item = document.createElement("div");
        item.className = "feed-item";

        const metaDiv = document.createElement("div");
        metaDiv.className = "feed-meta";
        const strongEl = document.createElement("strong");
        strongEl.textContent = t.speaker || "Narasumber";
        const spanEl = document.createElement("span");
        spanEl.textContent = new Date(t.timestamp).toLocaleTimeString();
        metaDiv.appendChild(strongEl);
        metaDiv.appendChild(spanEl);

        const bodyDiv = document.createElement("div");
        bodyDiv.className = "feed-body";
        bodyDiv.textContent = t.text;

        item.appendChild(metaDiv);
        item.appendChild(bodyDiv);
        transcriptFeed.appendChild(item);
      });
    } else {
      transcriptFeed.innerHTML = '<div class="empty-state">Belum ada log transkrip. Jalankan monitor untuk menangkap ucapan dan presentasi.</div>';
    }
  }

  // Timer Tick
  setInterval(async () => {
    const { isRecording, startTime } = await chrome.storage.local.get(["isRecording", "startTime"]);
    if (isRecording && startTime) {
      const diffSec = Math.floor((Date.now() - startTime) / 1000);
      const hrs = String(Math.floor(diffSec / 3600)).padStart(2, "0");
      const mins = String(Math.floor((diffSec % 3600) / 60)).padStart(2, "0");
      const secs = String(diffSec % 60).padStart(2, "0");
      durationText.textContent = `${hrs}:${mins}:${secs}`;
    } else {
      durationText.textContent = "00:00:00";
    }
  }, 1000);

  // Toggle Recording
  btnToggleRecord.addEventListener("click", async () => {
    const { isRecording } = await chrome.storage.local.get("isRecording");
    if (!isRecording) {
      // Validate settings
      const settings = await chrome.storage.local.get(["teleBotToken", "teleChatId"]);
      if (!settings.teleBotToken || !settings.teleChatId) {
        const proceed = confirm("Bot Token atau Chat ID Telegram belum diatur di tab Pengaturan. Ingin tetap lanjut monitor lokal saja?");
        if (!proceed) return;
      }

      btnToggleRecord.disabled = true;
      try {
        const resp = await chrome.runtime.sendMessage({ action: "START_MONITOR" });
        if (!resp || !resp.success) {
          alert("Gagal memulai monitor: " + (resp?.error || "Pastikan tab meeting aktif"));
        }
      } catch (err) {
        alert("Error: " + err.message);
      } finally {
        btnToggleRecord.disabled = false;
        await refreshDataViews();
      }
    } else {
      btnToggleRecord.disabled = true;
      try {
        await chrome.runtime.sendMessage({ action: "STOP_MONITOR" });
      } catch (err) {
        console.error(err);
      } finally {
        btnToggleRecord.disabled = false;
        await refreshDataViews();
      }
    }
  });

  // Instant Capture
  btnInstantCapture.addEventListener("click", async () => {
    btnInstantCapture.disabled = true;
    try {
      await chrome.runtime.sendMessage({ action: "TRIGGER_INSTANT_CAPTURE" });
      await refreshDataViews();
    } catch (err) {
      alert("Gagal capture: " + err.message);
    } finally {
      btnInstantCapture.disabled = false;
    }
  });

  // Overall Summary Analysis
  btnAnalyzeSummary.addEventListener("click", async () => {
    const originalText = btnAnalyzeSummary.textContent;
    btnAnalyzeSummary.disabled = true;
    btnAnalyzeSummary.textContent = "Menganalisis dengan AI...";

    try {
      const resp = await chrome.runtime.sendMessage({ action: "RUN_OVERALL_SUMMARY" });
      if (resp && resp.success) {
        alert("Analisis meeting selesai dan telah disinkronkan ke Telegram!");
        // Switch to transcript tab
        document.getElementById("tabBtnTranscript")?.click();
      } else {
        alert("Gagal analisis: " + (resp?.error || "Cek koneksi API"));
      }
    } catch (err) {
      alert("Error: " + err.message);
    } finally {
      btnAnalyzeSummary.disabled = false;
      btnAnalyzeSummary.textContent = originalText;
      await refreshDataViews();
    }
  });

  // Clear Gallery
  btnClearGallery.addEventListener("click", async () => {
    if (confirm("Hapus semua tangkapan layar yang tersimpan di sesi ini?")) {
      await chrome.storage.local.set({ screenshots: [] });
      await refreshDataViews();
    }
  });

  // Copy All Transcripts
  btnCopyTranscript.addEventListener("click", async () => {
    const { transcripts, overallSummary } = await chrome.storage.local.get(["transcripts", "overallSummary"]);
    let full = "";
    if (overallSummary) {
      full += `=== ANALISIS KESELURUHAN MEETING ===\n${overallSummary.text}\n\n`;
    }
    if (transcripts && transcripts.length > 0) {
      full += `=== TRANSKRIP DETAIL ===\n`;
      transcripts.forEach(t => {
        full += `[${new Date(t.timestamp).toLocaleTimeString()}] ${t.speaker || "Narasumber"}:\n${t.text}\n\n`;
      });
    }
    if (!full) {
      alert("Belum ada data transkrip untuk disalin.");
      return;
    }
    await navigator.clipboard.writeText(full);
    btnCopyTranscript.textContent = "Disalin!";
    setTimeout(() => {
      btnCopyTranscript.textContent = "Salin Semua";
    }, 2000);
  });

  // Storage Change Listener
  chrome.storage.onChanged.addListener(() => {
    refreshDataViews();
  });

  // Initial Load
  await loadSettings();
  await refreshDataViews();
});
