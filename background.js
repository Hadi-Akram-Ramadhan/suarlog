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

// Helper: Resolve Token (Custom user token, config.local.json seed, or storage)
async function getEffectiveTelegramToken() {
  const data = await chrome.storage.local.get("teleBotToken");
  if (data.teleBotToken && data.teleBotToken.trim()) {
    return data.teleBotToken.trim();
  }
  try {
    const res = await fetch(chrome.runtime.getURL("config.local.json"));
    if (res.ok) {
      const cfg = await res.json();
      if (cfg.teleBotToken) return cfg.teleBotToken.trim();
    }
  } catch (_) {}
  return "";
}

// Offscreen Document Lifecycle for Audio Loopback & Recording
let creatingOffscreen = null;
async function setupOffscreenDocument(path = "offscreen.html") {
  const offscreenUrl = chrome.runtime.getURL(path);
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });
  if (existingContexts && existingContexts.length > 0) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
  } else {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: path,
      reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
      justification: "Record tab audio for AI meeting analysis without muting user headset"
    });
    await creatingOffscreen;
    creatingOffscreen = null;
  }
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
  const choice = json.choices?.[0];
  let text = choice?.message?.content || "";

  // If output token limit was reached, append indicator or continue
  if (choice?.finish_reason === "length") {
    console.warn("[Suarlog AI] Output truncated due to model max_tokens length, requesting continuation...");
    try {
      const continuationMessages = [
        ...messages,
        { role: "assistant", content: text },
        { role: "user", content: "Lanjutkan persis dari kata terakhir di atas sampai kalimat selesai secara utuh." }
      ];
      const contPayload = { model, messages: continuationMessages, max_tokens: 1500, stream: false };
      const contResp = await fetch(`${baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(contPayload) });
      if (contResp.ok) {
        const contJson = await contResp.json();
        const contText = contJson.choices?.[0]?.message?.content || "";
        if (contText) text += " " + contText.trim();
      }
    } catch (_) {}
  }
  return text;
}

// Sequential transcript write queue to eliminate storage race condition overwrites
let transcriptSaveQueue = Promise.resolve();
function appendTranscript(speaker, text, timestamp = Date.now()) {
  if (!text || text.trim().length === 0) return Promise.resolve();
  transcriptSaveQueue = transcriptSaveQueue.then(async () => {
    try {
      const { transcripts } = await chrome.storage.local.get("transcripts");
      const list = transcripts || [];
      list.push({
        speaker: speaker,
        timestamp: timestamp,
        text: text.trim()
      });
      if (list.length > 500) list.shift();
      await chrome.storage.local.set({ transcripts: list });
    } catch (err) {
      console.error("[Suarlog AI] Error appending transcript:", err);
    }
  });
  return transcriptSaveQueue;
}

// Sequential speech audio chunk processing queue
let audioProcessQueue = Promise.resolve();

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
async function performCapture(tabId, isManual = false, forcedDataUrl = null) {
  try {
    let dataUrl = forcedDataUrl;
    if (!dataUrl) {
      let targetWindowId = null;
      if (tabId) {
        const targetTab = await chrome.tabs.get(tabId).catch(() => null);
        if (targetTab) targetWindowId = targetTab.windowId;
      }
      dataUrl = await chrome.tabs.captureVisibleTab(targetWindowId, { format: "jpeg", quality: 85 });
    }
    if (!dataUrl) return null;

    const { screenshots, sendSlideToTele, teleChatId, analysisMode } = await chrome.storage.local.get([
      "screenshots",
      "sendSlideToTele",
      "teleChatId",
      "analysisMode"
    ]);

    const shotList = screenshots || [];
    const isDiff = shotList.length === 0 || isSlideDifferent(dataUrl, shotList[shotList.length - 1].dataUrl);

    if (isDiff || isManual || forcedDataUrl) {
      const slideNum = shotList.length + 1;
      const newShot = {
        index: slideNum,
        timestamp: Date.now(),
        dataUrl: dataUrl
      };
      shotList.push(newShot);
      await chrome.storage.local.set({ screenshots: shotList });

      // Analyze this slide visual with AI
      const promptMode = analysisMode === "concise"
        ? "Ringkas slide ini dalam 2-3 poin inti penting saja."
        : analysisMode === "academic"
        ? "Analisis materi kuliah/bootcamp pada slide ini: rumus, konsep teknis, diagram, dan poin penting."
        : "Analisis slide presentasi ini secara DETAIL dan LENGKAP. Jabarkan judul, poin materi, data/angka, dan takeaways visual.";

      const aiMessages = [
        {
          role: "user",
          content: [
            { type: "text", text: `${promptMode}\nGunakan bahasa Indonesia yang jelas, runut, dan profesional.` },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }
      ];

      try {
        const explanation = await callAICompletion(aiMessages, 1000);

        // Store into transcripts feed via serialized queue
        await appendTranscript(`Slide #${slideNum} (Visual)`, explanation, Date.now());

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

      // Setup audio loopback capture via offscreen document so user headset is NOT muted
      try {
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: activeTabId });
        await setupOffscreenDocument("offscreen.html");
        chrome.runtime.sendMessage({
          target: "offscreen",
          action: "START_AUDIO",
          streamId: streamId
        }).catch(err => console.warn("Could not start offscreen audio:", err));
      } catch (audioErr) {
        console.warn("[Suarlog AI] Could not initialize tab audio capture:", audioErr);
      }

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
          `🚀 *Monitor Meeting Dimulai*\n• Tab: ${tab.title || "Meeting"}\n• Interval Cek: ${intervalSec} detik\nSuarlog AI aktif memantau audio tab, slide & transkrip.`
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
        await chrome.tabs.sendMessage(activeTabId, { action: "STOP_OBSERVING" }).catch(() => {});
        activeTabId = null;
      }

      // Stop audio recording and wait for offscreen to flush final speech chunk
      try {
        await chrome.runtime.sendMessage({ target: "offscreen", action: "STOP_AUDIO" });
      } catch (_) {}
      // Wait for any queued audio transcriptions to finish before closing document
      await audioProcessQueue.catch(() => {});
      await chrome.offscreen.closeDocument().catch(() => {});

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
      if (!isRecording && !req.isFinal) {
        sendResponse({ success: false, error: "Not recording" });
        return;
      }
      if (sender.tab && activeTabId && sender.tab.id !== activeTabId) {
        sendResponse({ success: false, error: "Sender tab is not active meeting session" });
        return;
      }
      await appendTranscript(req.speaker || "Percakapan Meeting", req.text, req.timestamp || Date.now());
      sendResponse({ success: true });
    })();
    return true;
  }

  // 7. Inbound Continuous Speech Audio Chunk from Offscreen Worker
  if (req.action === "NEW_AUDIO_SPEECH_CHUNK") {
    (async () => {
      const { isRecording } = await chrome.storage.local.get("isRecording");
      if (!isRecording && !req.isFinal) {
        sendResponse({ success: false, error: "Not recording and not final" });
        return;
      }
      if (!req.wavBase64) {
        sendResponse({ success: false, error: "Empty audio payload" });
        return;
      }

      // Enqueue speech transcription sequentially to avoid AI concurrency limits and race conditions
      audioProcessQueue = audioProcessQueue.then(async () => {
        console.log(`[Suarlog AI] Transcribing speech chunk (${req.durationSec?.toFixed(1) || "?"}s, isFinal: ${Boolean(req.isFinal)})...`);

        const verbatimPrompt = (
          "Kamu adalah transcriber audio meeting profesional dan sangat teliti.\n" +
          "TUGAS UTAMA: Tuliskan transkrip percakapan audio ini secara LENGKAP, DETAIL, UTUH, dan VERBATIM (KATA PER KATA APA ADANYA).\n" +
          "- JANGAN PERNAH meringkas, menyingkat, atau menghilangkan kata/kalimat apa pun yang diucapkan pembicara.\n" +
          "- Tuliskan seluruh percakapan dalam bentuk dialog rapi. Berikan label pembicara (misal: Pembicara 1, Pembicara 2, atau nama jika terdengar jelas).\n" +
          "- Catat setiap istilah teknis, pertanyaan, jawaban, angka, instruksi, dan diskusi secara persis seperti aslinya."
        );

        const aiMessages = [
          {
            role: "user",
            content: [
              { type: "text", text: `${verbatimPrompt}\nGunakan bahasa Indonesia yang jelas dan akurat.` },
              {
                type: "input_audio",
                input_audio: {
                  data: req.wavBase64,
                  format: "wav"
                }
              }
            ]
          }
        ];

        try {
          const verbatimText = await callAICompletion(aiMessages, 4000);
          if (verbatimText && verbatimText.trim().length > 3) {
            await appendTranscript("Percakapan Audio Live", verbatimText.trim(), req.timestamp || Date.now());

            // Send to Telegram
            const effectiveToken = await getEffectiveTelegramToken();
            const { teleChatId } = await chrome.storage.local.get("teleChatId");
            if (effectiveToken && teleChatId) {
              await sendTelegramMessage(
                effectiveToken,
                teleChatId,
                `🎙️ *Transkrip Audio Live*:\n\n${verbatimText.trim()}`
              );
            }
          }
        } catch (err) {
          console.error("[Suarlog AI] Error transcribing speech chunk:", err);
        }
      });

      await audioProcessQueue;
      sendResponse({ success: true });
    })();
    return true;
  }

  // 8. Auto Slide Transition Notification from Content Script
  if (req.action === "AUTO_SLIDE_TRANSITION") {
    (async () => {
      const { isRecording } = await chrome.storage.local.get("isRecording");
      if (!isRecording) return;
      if (sender.tab && activeTabId && sender.tab.id !== activeTabId) return;
      console.log("[Suarlog AI] Auto slide transition received, triggering snapshot analysis...");
      await performCapture(activeTabId, true, req.dataUrl);
      sendResponse({ success: true });
    })();
    return true;
  }
});
