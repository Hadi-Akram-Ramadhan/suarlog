// Suarlog AI - Background Service Worker (MV3)

let activeTabId = null;
let monitorIntervalId = null;
let lastImageThumbData = null;

// Default initial state
chrome.runtime.onInstalled.addListener(async () => {
  // Restrict chrome.storage.local access to extension's trusted contexts (background/popup)
  // preventing injected content scripts from reading sensitive API keys / Telegram tokens.
  if (chrome.storage.local.setAccessLevel) {
    chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
  }
  const current = await chrome.storage.local.get([
    "teleBotToken",
    "teleChatId",
    "aiBaseUrl",
    "aiApiKey",
    "aiModel",
    "analysisMode",
    "sendSlideToTele",
    "autoSummaryInterval",
    "screenshots",
    "transcripts",
    "isRecording"
  ]);

  await chrome.storage.local.set({
    teleBotToken: current.teleBotToken || "",
    teleChatId: current.teleChatId || "949694019",
    aiBaseUrl: current.aiBaseUrl || "http://localhost:20128/v1",
    aiApiKey: current.aiApiKey || "",
    aiModel: current.aiModel || "ag/gemini-3.8-flash-high",
    analysisMode: current.analysisMode || "detailed",
    sendSlideToTele: current.sendSlideToTele !== undefined ? current.sendSlideToTele : true,
    autoSummaryInterval: current.autoSummaryInterval || 60,
    screenshots: current.screenshots || [],
    transcripts: current.transcripts || [],
    isRecording: false
  });
});

// Helper: Resolve Token (Custom user token, environment-provided, or bridge)
async function getEffectiveTelegramToken() {
  const data = await chrome.storage.local.get("teleBotToken");
  return data.teleBotToken ? data.teleBotToken.trim() : "";
}

// Helper: Telegram API Dispatches
async function sendTelegramMessage(token, chatId, text) {
  if (!token || !chatId) return { success: false, error: "Missing token or chatId" };
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  // Chunk text to <= 4000 chars
  const chunks = [];
  for (let i = 0; i < text.length; i += 3900) {
    chunks.push(text.substring(i, i + 3900));
  }

  try {
    for (const chunk of chunks) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: "Markdown"
        })
      });
      if (!res.ok) {
        // Fallback retry without Markdown
        const fallbackRes = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: chunk })
        });
        if (!fallbackRes.ok) {
          const errData = await fallbackRes.json().catch(() => ({}));
          return { success: false, error: errData.description || `HTTP ${fallbackRes.status}` };
        }
      }
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function sendTelegramPhoto(token, chatId, dataUrl, caption) {
  if (!token || !chatId) return { success: false, error: "Missing token or chatId" };
  const url = `https://api.telegram.org/bot${token}/sendPhoto`;

  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const formData = new FormData();
    formData.append("chat_id", chatId);
    formData.append("photo", blob, "slide.jpg");
    formData.append("caption", (caption || "").substring(0, 1024));
    formData.append("parse_mode", "Markdown");

    const r = await fetch(url, { method: "POST", body: formData });
    return { success: r.ok };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Helper: AI Completion Calling
async function callAICompletion(messages, maxTokens = 1500) {
  const config = await chrome.storage.local.get(["aiBaseUrl", "aiApiKey", "aiModel"]);
  const baseUrl = (config.aiBaseUrl || "http://localhost:20128/v1").replace(/\/+$/, "");
  const apiKey = config.aiApiKey || "";
  const model = config.aiModel || "ag/gemini-3.8-flash-high";

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const payload = {
    model: model,
    messages: messages,
    max_tokens: maxTokens,
    stream: false
  };

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`AI API error (${resp.status}): ${errText}`);
  }

  const json = await resp.json();
  return json.choices?.[0]?.message?.content || "";
}

// Compare two image thumbnails
function isSlideDifferent(dataUrlA, dataUrlB) {
  if (!dataUrlA || !dataUrlB) return true;
  if (dataUrlA.length !== dataUrlB.length) return true;
  // Substring hash comparison
  const sampleA = dataUrlA.substring(dataUrlA.length - 200);
  const sampleB = dataUrlB.substring(dataUrlB.length - 200);
  return sampleA !== sampleB;
}

// Capture Tab Routine
async function performCapture(tabId, isManual = false) {
  try {
    // Ensure capture targets specific window/tab to prevent leaking unrelated foreground windows
    let targetWindowId = null;
    if (tabId) {
      const targetTab = await chrome.tabs.get(tabId).catch(() => null);
      if (targetTab) targetWindowId = targetTab.windowId;
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(targetWindowId, { format: "jpeg", quality: 85 });
    if (!dataUrl) return null;

    const { screenshots, sendSlideToTele, teleBotToken, teleChatId, analysisMode } = await chrome.storage.local.get([
      "screenshots",
      "sendSlideToTele",
      "teleBotToken",
      "teleChatId",
      "analysisMode"
    ]);

    const shotList = screenshots || [];
    const isDiff = shotList.length === 0 || isSlideDifferent(dataUrl, shotList[shotList.length - 1].dataUrl);

    if (isDiff || isManual) {
      const slideNum = shotList.length + 1;
      const newShot = {
        index: slideNum,
        timestamp: Date.now(),
        dataUrl: dataUrl
      };
      shotList.push(newShot);
      await chrome.storage.local.set({ screenshots: shotList });

      // Analyze this slide with AI
      const promptMode = analysisMode === "concise"
        ? "Ringkas slide ini dalam 2 poin inti penting saja."
        : analysisMode === "academic"
        ? "Analisis slide ini dalam struktur materi kuliah/bootcamp, rumus/poin teknis, dan catatan penting."
        : "Analisis slide presentasi ini secara DETAIL dan LENGKAP. Jabarkan poin penting, data/angka, dan takeaways.";

      const aiMessages = [
        {
          role: "user",
          content: [
            { type: "text", text: `${promptMode}\nGunakan bahasa Indonesia yang jelas dan profesional.` },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }
      ];

      try {
        const explanation = await callAICompletion(aiMessages, 800);

        // Store into transcripts feed
        const { transcripts } = await chrome.storage.local.get("transcripts");
        const tList = transcripts || [];
        tList.push({
          speaker: `Slide #${slideNum}`,
          timestamp: Date.now(),
          text: explanation
        });
        await chrome.storage.local.set({ transcripts: tList });

        // Push to Telegram if configured
        const effectiveToken = await getEffectiveTelegramToken();
        if (effectiveToken && teleChatId) {
          const caption = `📸 *Slide #${slideNum} Terdeteksi*\n${explanation.substring(0, 800)}`;
          if (sendSlideToTele) {
            await sendTelegramPhoto(effectiveToken, teleChatId, dataUrl, caption);
          } else {
            await sendTelegramMessage(effectiveToken, teleChatId, `📸 *Slide #${slideNum}*\n\n${explanation}`);
          }
        }
      } catch (aiErr) {
        console.error("Slide AI analysis error:", aiErr);
      }

      return newShot;
    }
  } catch (err) {
    console.error("Capture visible tab error:", err);
  }
  return null;
}

// Generate Overall Summary
async function generateOverallSummary() {
  const { transcripts, screenshots, analysisMode, teleBotToken, teleChatId } = await chrome.storage.local.get([
    "transcripts",
    "screenshots",
    "analysisMode",
    "teleBotToken",
    "teleChatId"
  ]);

  if ((!transcripts || transcripts.length === 0) && (!screenshots || screenshots.length === 0)) {
    throw new Error("Belum ada data transkrip atau slide untuk dianalisis.");
  }

  let textCorpus = "";
  (transcripts || []).forEach((t, i) => {
    textCorpus += `[Log ${i + 1} - ${t.speaker}]: ${t.text}\n\n`;
  });

  const promptTemplate = `
Berikut adalah seluruh transkrip dan catatan slide yang terekam selama meeting:
${textCorpus}

Tugasmu:
Berikan Rangkuman & Analisis Keseluruhan Meeting (${analysisMode}) dalam format:
1. 📌 *Topik & Tujuan Utama Meeting*
2. 🔍 *Poin-Poin Kunci & Diskusi Mendalam*
3. ⚠️ *Isu / Catatan Kritis yang Muncul*
4. 📋 *Action Items & Keputusan Akhir*
5. 💡 *Kesimpulan Eksekutif*

Gunakan bahasa Indonesia yang profesional, runut, dan langsung pada substansi.
`;

  const messages = [{ role: "user", content: promptTemplate }];
  const overallText = await callAICompletion(messages, 2500);

  const summaryObj = {
    timestamp: Date.now(),
    text: overallText
  };

  await chrome.storage.local.set({ overallSummary: summaryObj });

  // Send to Telegram
  const effectiveToken = await getEffectiveTelegramToken();
  if (effectiveToken && teleChatId) {
    await sendTelegramMessage(
      effectiveToken,
      teleChatId,
      `📊 *ANALISIS KESELURUHAN MEETING*\n\n${overallText}`
    );
  }

  return overallText;
}

// Message Listener
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  // Validate sender
  if (sender.id !== chrome.runtime.id) {
    return false;
  }
  // 1. Test Telegram
  if (req.action === "TEST_TELEGRAM") {
    (async () => {
      const token = req.token || await getEffectiveTelegramToken();
      const res = await sendTelegramMessage(
        token,
        req.chatId,
        "🔔 *Suarlog AI Test Notification*\nKoneksi bot Telegram Anda telah berhasil terhubung dengan ekstensi Chrome!"
      );
      sendResponse(res);
    })();
    return true;
  }

  // 2. Start Monitor
  if (req.action === "START_MONITOR") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) {
        sendResponse({ success: false, error: "Tidak ada tab aktif yang ditemukan." });
        return;
      }
      activeTabId = tab.id;

      const { autoSummaryInterval } = await chrome.storage.local.get("autoSummaryInterval");
      const intervalSec = Math.max(15, autoSummaryInterval || 60);

      await chrome.storage.local.set({
        isRecording: true,
        startTime: Date.now()
      });

      // Notify content script
      chrome.tabs.sendMessage(activeTabId, { action: "START_OBSERVING" }).catch(() => {});

      // Initial capture
      await performCapture(activeTabId, true);

      // Start periodic monitor loop
      if (monitorIntervalId) clearInterval(monitorIntervalId);
      monitorIntervalId = setInterval(async () => {
        const { isRecording } = await chrome.storage.local.get("isRecording");
        if (!isRecording) {
          clearInterval(monitorIntervalId);
          return;
        }
        await performCapture(activeTabId, false);
      }, intervalSec * 1000);

      // Notify Telegram
      const { teleChatId } = await chrome.storage.local.get("teleChatId");
      const effectiveToken = await getEffectiveTelegramToken();
      if (effectiveToken && teleChatId) {
        sendTelegramMessage(
          effectiveToken,
          teleChatId,
          `🚀 *Monitor Meeting Dimulai*\n• Tab: ${tab.title || "Meeting"}\n• Interval Cek: ${intervalSec} detik\nSuarlog AI aktif memantau slide & transkrip.`
        ).then(r => {
          if (!r.success) console.warn("Telegram start notification failed:", r.error);
        }).catch(() => {});
      }

      sendResponse({ success: true });
    })();
    return true;
  }

  // 3. Stop Monitor
  if (req.action === "STOP_MONITOR") {
    (async () => {
      if (monitorIntervalId) {
        clearInterval(monitorIntervalId);
        monitorIntervalId = null;
      }
      if (activeTabId) {
        chrome.tabs.sendMessage(activeTabId, { action: "STOP_OBSERVING" }).catch(() => {});
        activeTabId = null;
      }
      await chrome.storage.local.set({ isRecording: false });

      // Send finish notification to Telegram
      const { teleChatId, screenshots, transcripts } = await chrome.storage.local.get([
        "teleChatId",
        "screenshots",
        "transcripts"
      ]);
      const effectiveToken = await getEffectiveTelegramToken();
      if (effectiveToken && teleChatId) {
        sendTelegramMessage(
          effectiveToken,
          teleChatId,
          `🏁 *Sesi Monitoring Meeting Dihentikan*\n• Total Slide: ${(screenshots || []).length}\n• Total Log Transkrip: ${(transcripts || []).length}\nBuka ekstensi untuk melihat rangkuman keseluruhan.`
        ).catch(() => {});
      }

      sendResponse({ success: true });
    })();
    return true;
  }

  // 4. Instant Capture
  if (req.action === "TRIGGER_INSTANT_CAPTURE") {
    (async () => {
      const targetId = activeTabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
      const shot = await performCapture(targetId, true);
      sendResponse({ success: Boolean(shot) });
    })();
    return true;
  }

  // 5. Run Overall Summary
  if (req.action === "RUN_OVERALL_SUMMARY") {
    (async () => {
      try {
        const summary = await generateOverallSummary();
        sendResponse({ success: true, summary });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // 6. Inbound Live Caption from Content Script
  if (req.action === "NEW_CAPTION_TEXT") {
    (async () => {
      const { isRecording } = await chrome.storage.local.get("isRecording");
      if (!isRecording) {
        sendResponse({ success: false, error: "Not recording" });
        return;
      }
      if (!sender.tab || sender.tab.id !== activeTabId) {
        sendResponse({ success: false, error: "Sender tab is not active meeting session" });
        return;
      }
      const { transcripts } = await chrome.storage.local.get("transcripts");
      const tList = transcripts || [];
      tList.push({
        speaker: "Percakapan Meeting",
        timestamp: req.timestamp || Date.now(),
        text: req.text
      });
      // Cap at 200 items in storage
      if (tList.length > 200) tList.shift();
      await chrome.storage.local.set({ transcripts: tList });
      sendResponse({ success: true });
    })();
    return true;
  }
});
