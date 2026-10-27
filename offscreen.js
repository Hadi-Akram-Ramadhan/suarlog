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
const PEAK_VOICE_THRESHOLD = 140;
const RMS_VOICE_THRESHOLD = 18;
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

      const hasRecentSpeech = recentPeak >= PEAK_VOICE_THRESHOLD;
      recentPeak = 0; // reset for next 1s window

      if (hasRecentSpeech) {
        speechSecAccumulated += 1;
        silenceSecAccumulated = 0;
      } else {
        silenceSecAccumulated += 1;
      }

      // A wall-clock bound also sends quiet speech that never crosses the VAD threshold.
      const bufferedSamples = pcmSamples.reduce((n, samples) => n + samples.length, 0);
      if (
        (speechSecAccumulated >= 1 && silenceSecAccumulated >= 2) ||
        bufferedSamples >= SAMPLE_RATE * 18
      ) {
        flushSpeechChunk().catch(err => console.error("Audio dispatch failed:", err));
      } else if (silenceSecAccumulated >= 2 && bufferedSamples > SAMPLE_RATE) {
        flushSpeechChunk().catch(err => console.error("Audio dispatch failed:", err));
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
async function flushSpeechChunk(isFinal = false) {
  if (pcmSamples.length === 0) return;

  let totalLen = 0;
  for (let i = 0; i < pcmSamples.length; i++) {
    totalLen += pcmSamples[i].length;
  }

  // Minimum ~0.4s audio required if final, or ~0.8s during active recording
  const minRequired = isFinal ? (SAMPLE_RATE * 0.4) : (SAMPLE_RATE * 0.8);
  if (totalLen < minRequired) {
    return;
  }

  const merged = new Int16Array(totalLen);
  let offset = 0;
  for (let i = 0; i < pcmSamples.length; i++) {
    merged.set(pcmSamples[i], offset);
    offset += pcmSamples[i].length;
  }

  // Calculate energy
  let maxAmp = 0;
  let sumSq = 0;
  for (let i = 0; i < merged.length; i++) {
    const abs = Math.abs(merged[i]);
    if (abs > maxAmp) maxAmp = abs;
    sumSq += merged[i] * merged[i];
  }
  const rms = Math.sqrt(sumSq / merged.length);

  // Discard pure digital silence (mic off / zero tab audio)
  if (maxAmp < PEAK_VOICE_THRESHOLD && rms < RMS_VOICE_THRESHOLD) {
    if (silenceSecAccumulated > 10 || isFinal) {
      pcmSamples = [];
      speechSecAccumulated = 0;
    }
    return;
  }

  // If buffer is larger than 45 seconds, take first 45s (head) to transcribe
  // and keep remaining tail in pcmSamples so ZERO speech is ever discarded!
  const MAX_CHUNK_SAMPLES = SAMPLE_RATE * 45;
  const OVERLAP_SAMPLES = 8000; // 0.5s overlap to preserve words on boundary
  let chunkToSend;

  if (merged.length > MAX_CHUNK_SAMPLES && !isFinal) {
    chunkToSend = merged.subarray(0, MAX_CHUNK_SAMPLES);
    const remaining = merged.subarray(MAX_CHUNK_SAMPLES - OVERLAP_SAMPLES);
    pcmSamples = [new Int16Array(remaining)];
  } else {
    chunkToSend = merged;
    if (merged.length > OVERLAP_SAMPLES && !isFinal) {
      const overlap = merged.subarray(merged.length - OVERLAP_SAMPLES);
      pcmSamples = [new Int16Array(overlap)];
    } else {
      pcmSamples = [];
    }
  }

  speechSecAccumulated = 0;
  silenceSecAccumulated = 0;

  const wavB64 = encodeWav(chunkToSend, SAMPLE_RATE);
  console.log(`[Suarlog Offscreen] Dispatching speech chunk (${(chunkToSend.length / SAMPLE_RATE).toFixed(1)}s, peak: ${maxAmp}, rms: ${rms.toFixed(1)}, isFinal: ${isFinal})`);

  try {
    await chrome.runtime.sendMessage({
      action: "NEW_AUDIO_SPEECH_CHUNK",
      wavBase64: wavB64,
      durationSec: chunkToSend.length / SAMPLE_RATE,
      isFinal: isFinal,
      timestamp: Date.now()
    });
  } catch (err) {
    console.warn("[Suarlog Offscreen] Error sending speech chunk:", err);
  }
}

// Stop audio capture
async function stopAudioCapture() {
  isRecording = false;
  if (speechCheckInterval) {
    clearInterval(speechCheckInterval);
    speechCheckInterval = null;
  }
  // Flush any final spoken words and wait for completion before destroying context
  await flushSpeechChunk(true);

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
});
