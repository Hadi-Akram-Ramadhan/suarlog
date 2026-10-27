// Suarlog AI - Offscreen Audio Loopback & Recording Worker

let audioContext = null;
let mediaStream = null;
let processorNode = null;
let pcmSamples = [];
let isRecording = false;

// Speech activity & silence tracking
let speechCheckInterval = null;
let speechSecAccumulated = 0;
let silenceSecAccumulated = 0;
const SAMPLE_RATE = 16000;
let recentPeak = 0;

// Fast in-memory 16kHz Mono WAV encoder
function encodeWav(samples, sampleRate = 16000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  
  // "RIFF" chunk descriptor
  view.setUint32(0, 0x52494646, false);
  view.setUint32(4, 36 + samples.length * 2, true);
  view.setUint32(8, 0x57415645, false); // "WAVE"
  
  // "fmt " sub-chunk
  view.setUint32(12, 0x666d7420, false);
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true);  // AudioFormat (1 = PCM)
  view.setUint16(22, 1, true);  // NumChannels (1 = Mono)
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, sampleRate * 2, true); // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
  view.setUint16(32, 2, true);  // BlockAlign (NumChannels * BitsPerSample/8)
  view.setUint16(34, 16, true); // BitsPerSample (16 bits)
  
  // "data" sub-chunk
  view.setUint32(36, 0x64617461, false);
  view.setUint32(40, samples.length * 2, true);
  
  // Write 16-bit PCM samples
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    view.setInt16(offset, samples[i], true);
  }
  
  // Convert ArrayBuffer to Base64
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  const CHUNK_SIZE = 0x8000;
  for (let i = 0; i < len; i += CHUNK_SIZE) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK_SIZE, len)));
  }
  return btoa(binary);
}

// Start Capturing Tab Audio
async function startAudioCapture(streamId) {
  if (isRecording) {
    await stopAudioCapture();
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      },
      video: false
    }).catch(async () => {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: streamId
          }
        },
        video: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: streamId
          }
        }
      });
    });

    if (mediaStream && typeof mediaStream.getVideoTracks === "function") {
      mediaStream.getVideoTracks().forEach(t => t.stop());
    }

    audioContext = new AudioContext();
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    const source = audioContext.createMediaStreamSource(mediaStream);

    // CRITICAL: Connect directly to destination so audio remains audible
    // in the user's headphones, TWS, or speakers without being muted!
    source.connect(audioContext.destination);

    // Recording processor with native-to-16kHz downsampling
    const inputSampleRate = audioContext.sampleRate || 48000;
    const step = inputSampleRate / SAMPLE_RATE;

    processorNode = audioContext.createScriptProcessor(4096, 1, 1);
    pcmSamples = [];
    isRecording = true;

    processorNode.onaudioprocess = (e) => {
      if (!isRecording) return;
      const input = e.inputBuffer.getChannelData(0);
      const outLen = Math.floor(input.length / step);
      const int16 = new Int16Array(outLen);
      for (let i = 0, j = 0; i < input.length && j < outLen; i += step, j++) {
        const s = Math.max(-1, Math.min(1, input[Math.floor(i)]));
        const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
        int16[j] = val;
        const abs = Math.abs(val);
        if (abs > recentPeak) recentPeak = abs;
      }
      pcmSamples.push(int16);
      
      // Cap in-memory buffer to ~15 minutes to prevent memory leaks
      if (pcmSamples.length > 3600) {
        pcmSamples.shift();
      }
    };

    // Low gain dummy connection required for ScriptProcessor to pump in WebKit
    const muteNode = audioContext.createGain();
    muteNode.gain.value = 0;
    source.connect(processorNode);
    processorNode.connect(muteNode);
    muteNode.connect(audioContext.destination);

    // Continuous Speech Activity Monitor: checks every 1 second
    if (speechCheckInterval) clearInterval(speechCheckInterval);
    speechCheckInterval = setInterval(() => {
      if (!isRecording) return;

      const hasRecentSpeech = recentPeak > 350;
      recentPeak = 0; // reset for next 1s window

      if (hasRecentSpeech) {
        speechSecAccumulated += 1;
        silenceSecAccumulated = 0;
      } else {
        silenceSecAccumulated += 1;
      }

      // Whenever someone talks:
      // Condition 1: Spoke for >= 15 seconds and paused for >= 2 seconds (natural sentence/thought pause)
      // Condition 2: Continuous monologue without pauses reached 40 seconds
      if (
        (speechSecAccumulated >= 15 && silenceSecAccumulated >= 2) ||
        speechSecAccumulated >= 40
      ) {
        flushSpeechChunk();
      }
    }, 1000);

    console.log("[Suarlog Offscreen] Audio loopback, recording and continuous speech activity detection active.");
    return { success: true };
  } catch (err) {
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    }
    if (audioContext) {
      await audioContext.close().catch(() => {});
      audioContext = null;
    }
    console.error("[Suarlog Offscreen] Error starting audio:", err);
    return { success: false, error: err.message };
  }
}

// Flush accumulated speech buffer to background worker for verbatim AI transcription
function flushSpeechChunk() {
  if (pcmSamples.length === 0) return;

  let totalLen = 0;
  for (let i = 0; i < pcmSamples.length; i++) {
    totalLen += pcmSamples[i].length;
  }
  
  const merged = new Int16Array(totalLen);
  let offset = 0;
  for (let i = 0; i < pcmSamples.length; i++) {
    merged.set(pcmSamples[i], offset);
    offset += pcmSamples[i].length;
  }
  
  pcmSamples = [];
  speechSecAccumulated = 0;
  silenceSecAccumulated = 0;

  // Calculate energy
  let maxAmp = 0;
  let sumSq = 0;
  for (let i = 0; i < merged.length; i++) {
    const abs = Math.abs(merged[i]);
    if (abs > maxAmp) maxAmp = abs;
    sumSq += merged[i] * merged[i];
  }
  const rms = Math.sqrt(sumSq / merged.length);

  // Require real voice presence (discard silence or faint room hiss)
  if (maxAmp < 350 || rms < 45 || totalLen < (SAMPLE_RATE * 0.8)) {
    return;
  }

  // Cap to max 90s to keep payload responsive and avoid timeout
  let finalSamples = merged;
  if (merged.length > SAMPLE_RATE * 90) {
    finalSamples = merged.subarray(merged.length - (SAMPLE_RATE * 90));
  }

  const wavB64 = encodeWav(finalSamples, SAMPLE_RATE);
  console.log(`[Suarlog Offscreen] Dispatching speech chunk (${(totalLen / SAMPLE_RATE).toFixed(1)}s, peak: ${maxAmp})`);

  chrome.runtime.sendMessage({
    action: "NEW_AUDIO_SPEECH_CHUNK",
    wavBase64: wavB64,
    durationSec: totalLen / SAMPLE_RATE,
    timestamp: Date.now()
  }).catch(() => {});
}

// Stop audio capture
async function stopAudioCapture() {
  isRecording = false;
  if (speechCheckInterval) {
    clearInterval(speechCheckInterval);
    speechCheckInterval = null;
  }
  // Flush any final spoken words before stopping
  flushSpeechChunk();

  if (processorNode) {
    processorNode.disconnect();
    processorNode = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  if (audioContext) {
    await audioContext.close().catch(() => {});
    audioContext = null;
  }
  pcmSamples = [];
  console.log("[Suarlog Offscreen] Audio capture stopped cleanly.");
  return { success: true };
}

// Get accumulated audio slice and reset buffer for next slide
function getAudioSlice(reset = true) {
  if (pcmSamples.length === 0) return null;
  
  let totalLen = 0;
  for (let i = 0; i < pcmSamples.length; i++) {
    totalLen += pcmSamples[i].length;
  }
  
  const merged = new Int16Array(totalLen);
  let offset = 0;
  for (let i = 0; i < pcmSamples.length; i++) {
    merged.set(pcmSamples[i], offset);
    offset += pcmSamples[i].length;
  }
  
  if (reset) {
    pcmSamples = [];
  }

  // Calculate audio energy (peak and RMS)
  let maxAmp = 0;
  let sumSq = 0;
  for (let i = 0; i < merged.length; i++) {
    const abs = Math.abs(merged[i]);
    if (abs > maxAmp) maxAmp = abs;
    sumSq += merged[i] * merged[i];
  }
  const rms = Math.sqrt(sumSq / merged.length);

  // If audio is dead silence, return empty
  if (maxAmp < 300 && rms < 50) {
    return { hasSound: false, wavBase64: null, durationSec: totalLen / SAMPLE_RATE };
  }

  // Cap to max recent 90 seconds (16000 * 90 samples) for lightweight API payload
  let finalSamples = merged;
  if (merged.length > 16000 * 90) {
    finalSamples = merged.subarray(merged.length - (16000 * 90));
  }

  const wavB64 = encodeWav(finalSamples, SAMPLE_RATE);
  return {
    hasSound: true,
    wavBase64: wavB64,
    durationSec: totalLen / SAMPLE_RATE
  };
}

// Handle runtime messages from background service worker
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.target !== "offscreen") return;

  if (req.action === "START_AUDIO") {
    startAudioCapture(req.streamId).then(sendResponse);
    return true;
  }

  if (req.action === "STOP_AUDIO") {
    stopAudioCapture().then(sendResponse);
    return true;
  }

  if (req.action === "GET_AUDIO_SLICE") {
    const slice = getAudioSlice(req.reset !== false);
    sendResponse({ success: true, slice });
    return true;
  }
});
