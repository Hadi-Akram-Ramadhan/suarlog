// Suarlog AI - Content Script (In-Meeting Caption & Presentation Hook)

(() => {
  // Prevent duplicate injections
  if (window.__SUARLOG_INJECTED__) return;
  window.__SUARLOG_INJECTED__ = true;

  console.log("[Suarlog AI] Content script active in meeting tab.");

  let captionObserver = null;
  let slideDetectorInterval = null;
  let activeSpeaker = "Narasumber";
  let speechBuffer = "";
  let finalizeCaptionTimer = null;

  // Slide detection state
  let lastThumbnailData = null;
  let lastSlideTransitionTime = 0;
  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = 64;
  sampleCanvas.height = 36;
  const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });

  // 1. Caption Buffer Dispatch
  function flushCaptionBuffer() {
    const text = speechBuffer.trim();
    if (text.length > 3) {
      chrome.runtime.sendMessage({
        action: "NEW_CAPTION_TEXT",
        speaker: activeSpeaker || "Narasumber",
        text: text,
        timestamp: Date.now()
      }).catch(() => {});
      speechBuffer = "";
    }
  }

  // 2. Closed Captions Observer (Google Meet, Zoom Web, Teams)
  function startCaptionObserver() {
    if (captionObserver) return;

    captionObserver = new MutationObserver(() => {
      const meetCaptions = document.querySelectorAll(".VbkSUe, .bh44bd, [jsname='tgaKEf'], div.iTTPOb");
      if (meetCaptions.length > 0) {
        meetCaptions.forEach(el => {
          const speakerEl = el.closest(".nMxEZc")?.querySelector(".zs7LEd, .NWad4c") 
                         || el.parentElement?.querySelector(".zs7LEd");
          const speakerName = speakerEl?.textContent?.trim() || activeSpeaker;
          const text = el.textContent?.trim();

          if (text && text.length > 2) {
            if (speakerName !== activeSpeaker) {
              flushCaptionBuffer();
              activeSpeaker = speakerName;
              speechBuffer = text;
            } else {
              // If incoming text is an extension of current buffer, update it
              if (text.startsWith(speechBuffer)) {
                speechBuffer = text;
              } else if (!speechBuffer.endsWith(text) && !speechBuffer.includes(text)) {
                // If previous sentence completed in DOM, flush old and append new
                flushCaptionBuffer();
                speechBuffer = text;
              }
            }
            clearTimeout(finalizeCaptionTimer);
            finalizeCaptionTimer = setTimeout(flushCaptionBuffer, 2200);
          }
        });
        return;
      }

      const zoomCaptions = document.querySelectorAll(".meeting-client-caption, .caption-container, span.caption-text");
      if (zoomCaptions.length > 0) {
        zoomCaptions.forEach(el => {
          const speakerEl = el.closest(".caption-window")?.querySelector(".caption-speaker")
                         || el.querySelector("b, strong");
          const speakerName = speakerEl?.textContent?.replace(":", "")?.trim() || activeSpeaker;
          const text = el.textContent?.replace(speakerEl?.textContent || "", "").trim();

          if (text && text.length > 2) {
            if (speakerName !== activeSpeaker) {
              flushCaptionBuffer();
              activeSpeaker = speakerName;
              speechBuffer = text;
            } else {
              if (text.startsWith(speechBuffer)) {
                speechBuffer = text;
              } else if (!speechBuffer.endsWith(text) && !speechBuffer.includes(text)) {
                flushCaptionBuffer();
                speechBuffer = text;
              }
            }
            clearTimeout(finalizeCaptionTimer);
            finalizeCaptionTimer = setTimeout(flushCaptionBuffer, 2200);
          }
        });
        return;
      }

      const genericCaptions = document.querySelectorAll("[data-tid='closed-caption-text'], .c-caption-text");
      if (genericCaptions.length > 0) {
        let combined = "";
        genericCaptions.forEach(c => {
          const t = c.textContent?.trim();
          if (t && t.length > 2) combined += t + " ";
        });
        combined = combined.trim();
        if (combined.length > 3 && combined !== speechBuffer) {
          if (!combined.startsWith(speechBuffer)) {
            flushCaptionBuffer();
          }
          speechBuffer = combined;
          clearTimeout(finalizeCaptionTimer);
          finalizeCaptionTimer = setTimeout(flushCaptionBuffer, 2200);
        }
      }
    });

    captionObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  // 3. Find Presentation Element (Video / Screen Share)
  function findPresentationElement() {
    const videos = Array.from(document.querySelectorAll("video")).filter(v => {
      const rect = v.getBoundingClientRect();
      return !v.paused && rect.width > 280 && rect.height > 180;
    });
    if (videos.length > 0) {
      videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
      return videos[0];
    }
    return null;
  }

  // 4. Automatic Real-Time Slide Transition Detector
  function startSlideDetector() {
    if (slideDetectorInterval) return;

    slideDetectorInterval = setInterval(() => {
      const elem = findPresentationElement();
      if (!elem) return;

      try {
        sampleCtx.drawImage(elem, 0, 0, 64, 36);
        const imgData = sampleCtx.getImageData(0, 0, 64, 36).data;

        if (!lastThumbnailData) {
          lastThumbnailData = new Uint8Array(imgData);
          lastSlideTransitionTime = Date.now();
          return;
        }

        let totalDiff = 0;
        const totalPixels = 64 * 36;
        for (let i = 0; i < imgData.length; i += 4) {
          totalDiff += Math.abs(imgData[i] - lastThumbnailData[i]) +
                       Math.abs(imgData[i+1] - lastThumbnailData[i+1]) +
                       Math.abs(imgData[i+2] - lastThumbnailData[i+2]);
        }
        const avgDiff = totalDiff / (totalPixels * 3);
        const now = Date.now();

        if (avgDiff > 8.5 && (now - lastSlideTransitionTime) >= 15000) {
          console.log(`[Suarlog AI] Auto slide transition detected! (diff: ${avgDiff.toFixed(1)})`);
          lastSlideTransitionTime = now;
          lastThumbnailData.set(imgData);

          const fullCanvas = document.createElement("canvas");
          fullCanvas.width = elem.videoWidth || 1280;
          fullCanvas.height = elem.videoHeight || 720;
          const fullCtx = fullCanvas.getContext("2d");
          fullCtx.drawImage(elem, 0, 0, fullCanvas.width, fullCanvas.height);
          const dataUrl = fullCanvas.toDataURL("image/jpeg", 0.85);

          chrome.runtime.sendMessage({
            action: "AUTO_SLIDE_TRANSITION",
            diff: avgDiff,
            dataUrl: dataUrl,
            timestamp: now
          }).catch(() => {});
        } else if (avgDiff > 2.0 && (now - lastSlideTransitionTime) > 3000) {
          lastThumbnailData.set(imgData);
        }
      } catch (err) {
        // Cross-origin safe
      }
    }, 2000);
  }

  // Handle messages from background worker
  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req.action === "PING") {
      sendResponse({ status: "OK", url: location.href });
      return true;
    }

    if (req.action === "START_OBSERVING") {
      startCaptionObserver();
      startSlideDetector();
      sendResponse({ success: true });
      return true;
    }

    if (req.action === "STOP_OBSERVING") {
      if (captionObserver) {
        captionObserver.disconnect();
        captionObserver = null;
      }
      if (slideDetectorInterval) {
        clearInterval(slideDetectorInterval);
        slideDetectorInterval = null;
      }
      flushCaptionBuffer();
      sendResponse({ success: true });
      return true;
    }

    if (req.action === "CAPTURE_VIDEO_FRAME") {
      const vid = findPresentationElement();
      if (!vid) {
        sendResponse({ success: false, error: "No active presentation video found in tab" });
        return true;
      }

      try {
        const canvas = document.createElement("canvas");
        canvas.width = vid.videoWidth || 1280;
        canvas.height = vid.videoHeight || 720;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        sendResponse({ success: true, dataUrl });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
      return true;
    }
  });

  // Observer will be activated only when monitoring starts via START_OBSERVING message
})();
