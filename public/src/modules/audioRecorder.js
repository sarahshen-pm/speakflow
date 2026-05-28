/**
 * audioRecorder.js
 * Handles microphone capture, waveform animation, and client-side WAV conversion.
 * Owns all MediaRecorder and AudioContext usage.
 */

// ─── WAV conversion ───────────────────────────────────────────────────────────

/**
 * Converts a WebM/Opus blob to a 16kHz mono 16-bit PCM WAV blob.
 * Azure REST pronunciation assessment requires this exact format.
 */
export async function convertToWav(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await audioCtx.decodeAudioData(arrayBuffer);
  const source = decoded.getChannelData(0);
  const samples = downsampleBuffer(source, decoded.sampleRate, 16000);
  await audioCtx.close?.();

  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  // Build 44-byte WAV header
  const wavBuffer = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(wavBuffer);
  const writeStr = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);   // chunk size
  view.setUint16(20, 1, true);    // PCM
  view.setUint16(22, 1, true);    // mono
  view.setUint32(24, 16000, true); // sample rate
  view.setUint32(28, 32000, true); // byte rate
  view.setUint16(32, 2, true);    // block align
  view.setUint16(34, 16, true);   // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  new Int16Array(wavBuffer, 44).set(pcm);

  return new Blob([wavBuffer], { type: 'audio/wav' });
}

/**
 * Downsamples a Float32Array from inputRate to outputRate using linear interpolation.
 */
export function downsampleBuffer(buffer, inputRate, outputRate) {
  if (outputRate === inputRate) return buffer;
  if (outputRate > inputRate) throw new Error('Output sample rate must be lower than input sample rate.');

  const ratio = inputRate / outputRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = count ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

// ─── AudioRecorder class ──────────────────────────────────────────────────────

/**
 * Encapsulates MediaRecorder for both primary recording and playback capture.
 * Usage:
 *   const recorder = new AudioRecorder(onWaveformTick);
 *   const blob = await recorder.start();
 *   // ... user speaks ...
 *   const blob = await recorder.stop();
 */
export class AudioRecorder {
  constructor() {
    this._mediaRecorder = null;
    this._stream = null;
    this._chunks = [];
    this._waveInterval = null;
    this._resolve = null;
    this._reject = null;

    // Playback capture (separate recorder to capture what user plays back)
    this._playbackRecorder = null;
    this._playbackStream = null;
    this._playbackChunks = [];
  }

  get isRecording() {
    return this._mediaRecorder?.state === 'recording';
  }

  /**
   * Requests mic access and starts recording.
   * @returns {Promise<void>} resolves once recording has started
   */
  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        'This page cannot access your microphone. Open it over http://127.0.0.1 or HTTPS instead of an unsupported local file context.'
      );
    }
    if (!window.MediaRecorder) {
      throw new Error('Your browser does not support MediaRecorder. Please use a recent version of Chrome or Edge.');
    }

    this._stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
    this._mediaRecorder = new MediaRecorder(this._stream, { mimeType });
    this._chunks = [];

    this._mediaRecorder.ondataavailable = e => {
      if (e.data.size > 0) this._chunks.push(e.data);
    };

    return new Promise((resolve, reject) => {
      this._mediaRecorder.onstart = () => resolve();
      this._mediaRecorder.onerror = e => reject(e.error || new Error('MediaRecorder error'));
      this._mediaRecorder.start(100);
    });
  }

  /**
   * Stops recording and returns the collected audio as a Blob.
   * @returns {Promise<Blob>}
   */
  stop() {
    return new Promise(resolve => {
      if (!this._mediaRecorder || this._mediaRecorder.state === 'inactive') {
        resolve(new Blob(this._chunks, { type: 'audio/webm' }));
        return;
      }
      this._mediaRecorder.onstop = () => {
        this._stream?.getTracks().forEach(t => t.stop());
        this._stream = null;
        resolve(new Blob(this._chunks, { type: 'audio/webm' }));
      };
      this._mediaRecorder.stop();
    });
  }

  /** Starts an independent capture of the microphone to save user's playback. */
  async startPlaybackCapture() {
    this.stopPlaybackCapture(false);
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return;
    try {
      this._playbackStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      this._playbackRecorder = new MediaRecorder(this._playbackStream, { mimeType });
      this._playbackChunks = [];
      this._playbackRecorder.ondataavailable = e => {
        if (e.data.size > 0) this._playbackChunks.push(e.data);
      };
      this._playbackRecorder.start(100);
    } catch (err) {
      console.warn('Playback capture unavailable:', err);
    }
  }

  /**
   * Stops playback capture. Returns a blob URL string, or null if nothing was captured.
   * @param {boolean} shouldSave - if false, discards the recording
   * @returns {string|null} object URL
   */
  stopPlaybackCapture(shouldSave = true) {
    let url = null;

    if (this._playbackRecorder && this._playbackRecorder.state !== 'inactive') {
      if (shouldSave) {
        this._playbackRecorder.onstop = () => {
          // handled below after stop
        };
        this._playbackRecorder.stop();
        if (this._playbackChunks.length) {
          const blob = new Blob(this._playbackChunks, {
            type: this._playbackChunks[0]?.type || 'audio/webm',
          });
          url = URL.createObjectURL(blob);
        }
      } else {
        this._playbackRecorder.onstop = null;
        this._playbackRecorder.stop();
      }
    } else if (shouldSave && this._playbackChunks.length) {
      const blob = new Blob(this._playbackChunks, {
        type: this._playbackChunks[0]?.type || 'audio/webm',
      });
      url = URL.createObjectURL(blob);
    }

    if (this._playbackStream) {
      this._playbackStream.getTracks().forEach(t => t.stop());
      this._playbackStream = null;
    }
    this._playbackRecorder = null;
    this._playbackChunks = [];
    return url;
  }

  /**
   * Starts the waveform animation on a set of bar elements.
   * @param {NodeList|Element[]} bars
   * @returns {number} interval ID
   */
  startWaveform(bars) {
    this.stopWaveform();
    this._waveInterval = setInterval(() => {
      bars.forEach(b => {
        b.style.height = (Math.random() * 26 + 3) + 'px';
      });
    }, 100);
    return this._waveInterval;
  }

  /** Stops the waveform animation. */
  stopWaveform() {
    if (this._waveInterval) {
      clearInterval(this._waveInterval);
      this._waveInterval = null;
    }
  }
}
