// Suarlog AI - Content Script (In-Meeting Caption & Presentation Hook)

(() => {
  // Prevent duplicate injections
  if (window.__SUARLOG_INJECTED__) return;
  window.__SUARLOG_INJECTED__ = true;

  console.log("[Suarlog AI] Content script active in meeting tab.");

  let captionObserver = null;
  let lastSeenCaptionText = "";

  // 1. Live Caption Extraction (Google Meet, Zoom Web, Teams)
  function startCaptionObserver() {
    if (captionObserver) return;

    captionObserver = new MutationObserver((mutations) => {
      // Common caption selectors for Google Meet, Zoom Web, and MS Teams
      const captionNodes = document.querySelectorAll(
        ".VbkSUe, .bh44bd, [jsname='tgaKEf'], .c-caption-text, [data-tid='closed-caption-text'], .caption-text, .meeting-client-caption"
      );

      if (captionNodes && captionNodes.length > 0) {
        let combined = "";
        captionNodes.forEach(node => {
          const t = node.textContent?.trim();
          if (t) combined += t + " ";
        });
        combined = combined.trim();

        if (combined && combined !== lastSeenCaptionText && combined.length > 5) {
          lastSeenCaptionText = combined;
          // Send to background service worker
          chrome.runtime.sendMessage({
            action: "NEW_CAPTION_TEXT",
            text: combined,
            timestamp: Date.now()
          }).catch(() => {});
        }
      }
    });

    captionObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  // 2. Video Frame Change Detection for WebRTC presentations
  function detectPresentationVideo() {
    const videos = document.querySelectorAll("video");
    let targetVideo = null;
    let maxArea = 0;

    videos.forEach(v => {
      const rect = v.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > maxArea && !v.paused && rect.width > 300) {
        maxArea = area;
        targetVideo = v;
      }
    });

    return targetVideo;
  }

  // Handle messages from background worker
  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req.action === "PING") {
      sendResponse({ status: "OK", url: location.href });
      return true;
    }

    if (req.action === "START_OBSERVING") {
      startCaptionObserver();
      sendResponse({ success: true });
      return true;
    }

    if (req.action === "CAPTURE_VIDEO_FRAME") {
      const vid = detectPresentationVideo();
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

  // Automatically start observing captions if page is already open
  startCaptionObserver();
})();
