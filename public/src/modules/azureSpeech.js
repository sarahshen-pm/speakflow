/**
 * azureSpeech.js
 * Unified facade for Azure Cognitive Services:
 *   - Text-to-Speech (TTS) via REST + browser Web Speech API fallback
 *   - Pronunciation Assessment via Azure Speech SDK (continuous streaming)
 *   - Pronunciation Assessment via REST API (single-shot WAV upload)
 *
 * No DOM access, no global state — all state is passed in or returned.
 */

import { getSpeechCredentials } from './speechConfig.js';
import {
  alignAzureWordsToReference,
  fallbackScoreFromRecognizedText,
} from './scoring.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, char => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;',
  }[char]));
}

function getEnglishVoice() {
  const voices = speechSynthesis.getVoices();
  return (
    voices.find(v => v.lang?.startsWith('en-') && (v.name.includes('Female') || v.name.includes('Google US'))) ||
    voices.find(v => v.lang?.startsWith('en-')) ||
    voices.find(v => v.lang?.startsWith('en')) ||
    null
  );
}

export function waitForVoices(timeoutMs = 800) {
  return new Promise(resolve => {
    if (!window.speechSynthesis || speechSynthesis.getVoices().length) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeoutMs);
    speechSynthesis.onvoiceschanged = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

// ─── TTS ─────────────────────────────────────────────────────────────────────

/**
 * Synthesizes text via Azure Neural TTS and returns a blob URL.
 * Throws on network or credential failure.
 */
export async function synthesizeAzureTts(text, voice = 'en-US-JennyNeural') {
  const credentials = await getSpeechCredentials();
  if (!credentials.region || (!credentials.token && !credentials.key)) {
    throw new Error(`Azure TTS 凭证未配置：${JSON.stringify(credentials.diagnostics || {})}`);
  }

  const authHeaders = credentials.token
    ? { Authorization: `Bearer ${credentials.token}` }
    : { 'Ocp-Apim-Subscription-Key': credentials.key };

  const ssml = `
    <speak version="1.0" xml:lang="en-US">
      <voice xml:lang="en-US" name="${voice}">
        ${escapeXml(text)}
      </voice>
    </speak>
  `.trim();

  const response = await fetch(
    `https://${credentials.region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      },
      body: ssml,
    }
  );

  if (!response.ok) {
    throw new Error(`Azure TTS ${response.status}: ${await response.text()}`);
  }

  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

/**
 * Plays text via browser Web Speech API.
 * Fallback when Azure TTS is unavailable.
 */
export function speakTextFallback(text, options = {}) {
  return new Promise((resolve, reject) => {
    const run = () => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = options.lang || 'en-US';
      utterance.rate = options.rate || 0.88;
      utterance.pitch = options.pitch || 1.05;
      utterance.volume = 1;
      const eng = getEnglishVoice();
      if (eng) utterance.voice = eng;

      let started = false;
      let settled = false;
      const timeout = setTimeout(() => {
        if (!started && !settled) {
          speechSynthesis.cancel();
          settled = true;
          reject(new Error('浏览器语音合成没有启动，请再点一次或检查系统语音服务。'));
        }
      }, 1200);

      utterance.onstart = () => { started = true; };
      utterance.onend = () => {
        clearTimeout(timeout);
        if (!settled) { settled = true; resolve(); }
      };
      utterance.onerror = event => {
        clearTimeout(timeout);
        if (!settled) { settled = true; reject(new Error(event.error || 'unknown')); }
      };

      if (speechSynthesis.paused) speechSynthesis.resume();
      speechSynthesis.speak(utterance);
    };

    speechSynthesis.cancel();
    if (options.defer === false) {
      run();
    } else {
      setTimeout(run, 80);
    }
  });
}

// ─── Azure SDK continuous assessment ─────────────────────────────────────────

/**
 * Starts a continuous Azure Speech SDK pronunciation assessment session.
 *
 * @param {string} sentence - The reference sentence
 * @param {object} callbacks
 *   - onReady()              — SDK connected, ready to record
 *   - onRecognizing(partial) — fired on each interim result
 *   - onRecognized(segment)  — fired on each finalized segment {text, jsonText}
 *   - onError(message)       — fired on SDK error or cancel
 *   - onStopped()            — fired when session ends (triggers finalization)
 * @returns {{ stop: () => void }} handle to stop the session
 */
export async function startContinuousAssessment(sentence, callbacks) {
  const { onReady, onRecognizing, onRecognized, onError, onStopped } = callbacks;

  if (!window.SpeechSDK) throw new Error('Azure Speech SDK 未加载，请检查网络连接后刷新。');

  const sdk = window.SpeechSDK;
  const credentials = await getSpeechCredentials();

  if (!credentials.region || (!credentials.token && !credentials.key)) {
    throw new Error(`Azure Speech 凭证未配置。读取状态：${JSON.stringify(credentials.diagnostics || {})}`);
  }

  const speechConfig = credentials.token
    ? sdk.SpeechConfig.fromAuthorizationToken(credentials.token, credentials.region)
    : sdk.SpeechConfig.fromSubscription(credentials.key, credentials.region);

  speechConfig.speechRecognitionLanguage = 'en-US';
  speechConfig.outputFormat = sdk.OutputFormat.Detailed;

  const audioConfig = sdk.AudioConfig.fromDefaultMicrophoneInput();
  const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

  const pronunciationConfig = new sdk.PronunciationAssessmentConfig(
    sentence,
    sdk.PronunciationAssessmentGradingSystem.HundredMark,
    sdk.PronunciationAssessmentGranularity.Phoneme,
    true
  );
  pronunciationConfig.phonemeAlphabet = 'IPA';
  if (typeof pronunciationConfig.enableProsodyAssessment === 'function') {
    pronunciationConfig.enableProsodyAssessment();
  } else {
    pronunciationConfig.enableProsodyAssessment = true;
  }
  pronunciationConfig.applyTo(recognizer);

  recognizer.recognizing = (_, event) => {
    onRecognizing?.(event.result?.text || '');
  };

  recognizer.recognized = (_, event) => {
    if (!event.result || event.result.reason !== sdk.ResultReason.RecognizedSpeech) return;
    const text = event.result.text || '';
    const jsonText = event.result.properties.getProperty(
      sdk.PropertyId.SpeechServiceResponse_JsonResult
    );
    onRecognized?.({ text, jsonText });
  };

  recognizer.canceled = (_, event) => {
    onError?.(`Azure 识别取消：${event.errorDetails || event.reason || 'Unknown'}`);
  };

  recognizer.sessionStopped = () => {
    onStopped?.();
  };

  await new Promise((resolve, reject) => {
    recognizer.startContinuousRecognitionAsync(resolve, err => reject(new Error(err)));
  });

  onReady?.();

  return {
    stop: () => new Promise((resolve, reject) => {
      recognizer.stopContinuousRecognitionAsync(resolve, err => reject(new Error(err)));
    }),
    close: () => recognizer.close?.(),
  };
}

// ─── Azure REST API single-shot assessment ────────────────────────────────────

/**
 * Sends a WAV blob to the Azure Speech REST API for pronunciation assessment.
 * @param {Blob} wavBlob - 16kHz mono PCM WAV
 * @param {string} referenceText
 * @returns {{ words, wordScores, overall, debug? }}
 */
export async function assessWithRestApi(wavBlob, referenceText) {
  const credentials = await getSpeechCredentials();
  if (!credentials.region || (!credentials.token && !credentials.key)) {
    throw new Error('Azure Speech 凭证未配置。');
  }

  const configJson = JSON.stringify({
    ReferenceText: referenceText,
    GradingSystem: 'HundredMark',
    Granularity: 'Phoneme',
    Dimension: 'Comprehensive',
    EnableMiscue: true,
    PhonemeAlphabet: 'IPA',
  });
  const configBase64 = btoa(unescape(encodeURIComponent(configJson)));

  const url = `https://${credentials.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed&wordLevelTimestamps=true`;
  const authHeaders = credentials.token
    ? { Authorization: `Bearer ${credentials.token}` }
    : { 'Ocp-Apim-Subscription-Key': credentials.key };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
      'Pronunciation-Assessment': configBase64,
    },
    body: wavBlob,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Azure API error ${response.status}: ${err}`);
  }

  const data = await response.json();

  const nBest = data.NBest?.[0];
  if (!nBest) {
    throw new Error(`Azure 没有返回识别结果：${data.RecognitionStatus || 'Unknown status'}`);
  }

  const refWords = referenceText.replace(/[.!?,;:]/g, '').split(' ').filter(w => w);
  const azureWords = nBest.Words || [];

  if (!azureWords.length) {
    const recognizedText = nBest.Display || nBest.Lexical || data.DisplayText || '';
    if (recognizedText.trim()) {
      return {
        ...fallbackScoreFromRecognizedText(refWords, recognizedText),
        debug: `Azure 返回了识别文本，但没有返回逐词评分。识别文本：${recognizedText}`,
      };
    }
    return {
      words: refWords,
      wordScores: refWords.map(() => 'missed'),
      overall: 0,
      debug: `Azure 没有识别到有效语音。RecognitionStatus: ${data.RecognitionStatus || 'Unknown'}`,
    };
  }

  const aligned = alignAzureWordsToReference(refWords, azureWords);
  const wordScores = aligned.map(item => {
    if (!item) return 'missed';
    const assessment = item.PronunciationAssessment || {};
    const acc = assessment.AccuracyScore ?? 0;
    const errorType = assessment.ErrorType || 'None';
    if (errorType === 'Omission') return 'missed';
    if (errorType === 'Insertion') return 'wrong';
    if (acc >= 80) return 'correct';
    if (acc >= 55) return 'close';
    if (acc > 0) return 'wrong';
    return 'missed';
  });

  const assessment = nBest.PronunciationAssessment || {};
  const fallbackAvg = Math.round(
    aligned.reduce((sum, w) => sum + (w?.PronunciationAssessment?.AccuracyScore || 0), 0) /
    Math.max(aligned.filter(Boolean).length, 1)
  );
  const recognizedText = nBest.Display || nBest.Lexical || data.DisplayText || '';
  const textFallback = fallbackScoreFromRecognizedText(refWords, recognizedText);
  const azureOverall = assessment.PronScore ?? assessment.AccuracyScore ?? fallbackAvg;
  const overall = Math.round(azureOverall > 0 ? azureOverall : textFallback.overall);

  return {
    words: refWords,
    wordScores: wordScores.some(s => s !== 'missed') ? wordScores : textFallback.wordScores,
    overall,
    debug: `Azure: ${data.RecognitionStatus || 'Success'}；识别文本：${recognizedText || '—'}`,
  };
}
