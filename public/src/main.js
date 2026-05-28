import { SAMPLE_TEXT, wordDB } from './modules/data.js';
import { getSpeechCredentials } from './modules/speechConfig.js';
import {
  getCurrentUser,
  login as loginAccount,
  logout as logoutAccount,
  register as registerAccount
} from './modules/auth.js';
import {
  loadRecentContent,
  saveRecentContent as persistRecentContent
} from './modules/contentStore.js';

let sentences = [];
let scores = [];
let activeRecording = -1;
let mediaRecorder = null;
let audioChunks = [];
let playbackRecorder = null;
let playbackStream = null;
let playbackChunks = [];
let recordingPlaybackUrls = [];
let waveInterval = null;
let autoStopTimer = null;
let speechRecognizer = null;
let continuousState = null;
let currentWord = '';
let utterance = null;
let currentReplayAudio = null;
let currentSystemAudio = null;
let ttsCache = new Map();
let totalDone = 0;
let readAllTimer = null;
let isFinalizingAssessment = false;
let countdownTimer = null;
let currentUser = null;
let authMode = 'login';
let saveRequestId = 0;

function openPractice(focusInput = false) {
  document.getElementById('landing-page').classList.add('is-hidden');
  document.getElementById('trainer-page').classList.remove('is-hidden');
  window.location.hash = 'practice';
  if (focusInput) {
    document.getElementById('input-text').focus();
  }
}

function showHome() {
  stopCurrentActivity();
  document.getElementById('trainer-page').classList.add('is-hidden');
  document.getElementById('landing-page').classList.remove('is-hidden');
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

function loadSample() {
  document.getElementById('input-text').value = SAMPLE_TEXT;
}

function setSaveStatus(message, type = '') {
  const el = document.getElementById('content-save-status');
  if (!el) return;
  el.textContent = message;
  el.className = `save-status ${type}`.trim();
}

function updateAccountUi() {
  ['home', 'trainer'].forEach(location => {
    const account = document.getElementById(`${location}-account-label`);
    const authButton = document.getElementById(`${location}-auth-button`);
    const logoutButton = document.getElementById(`${location}-logout-button`);
    if (currentUser) {
      account.textContent = currentUser.email;
      account.classList.remove('is-hidden');
      authButton.classList.add('is-hidden');
      logoutButton.classList.remove('is-hidden');
    } else {
      account.textContent = '';
      account.classList.add('is-hidden');
      authButton.classList.remove('is-hidden');
      logoutButton.classList.add('is-hidden');
    }
  });
  setSaveStatus(
    currentUser ? 'Your latest generated text is saved to your account.' : 'Sign in to save your latest practice text.'
  );
}

async function restoreRecentText(autoStart = false) {
  if (!currentUser) return;
  try {
    const content = await loadRecentContent();
    if (!content?.text) return;
    const input = document.getElementById('input-text');
    if (input.value.trim()) return;
    input.value = content.text;
    setSaveStatus('Restored your most recent practice text.', 'success');
    if (autoStart) {
      openPractice();
      processText({ skipSave: true });
    }
  } catch (error) {
    setSaveStatus(error.message, 'error');
  }
}

async function savePracticeText(text) {
  if (!currentUser) return;
  const requestId = ++saveRequestId;
  setSaveStatus('Saving your latest practice text...');
  try {
    await persistRecentContent(text);
    if (requestId === saveRequestId) {
      setSaveStatus('Saved. This text will be ready next time you sign in.', 'success');
    }
  } catch (error) {
    if (requestId === saveRequestId) {
      setSaveStatus(error.message, 'error');
    }
  }
}

function openAuthModal(mode = 'login') {
  authMode = mode;
  renderAuthMode();
  document.getElementById('auth-error').textContent = '';
  document.getElementById('auth-form').reset();
  document.getElementById('auth-modal').classList.add('open');
  document.getElementById('auth-email').focus();
}

function renderAuthMode() {
  const registering = authMode === 'register';
  document.getElementById('auth-title').textContent = registering ? 'Create your account' : 'Sign in to SpeakFlow';
  document.getElementById('auth-submit').textContent = registering ? 'Create account' : 'Sign in';
  document.getElementById('auth-switch-copy').textContent = registering ? 'Already have an account?' : 'New to SpeakFlow?';
  document.getElementById('auth-switch-button').textContent = registering ? 'Sign in' : 'Create an account';
  document.getElementById('auth-password').autocomplete = registering ? 'new-password' : 'current-password';
}

function switchAuthMode() {
  authMode = authMode === 'login' ? 'register' : 'login';
  document.getElementById('auth-error').textContent = '';
  renderAuthMode();
}

function closeAuthModal(event) {
  const modal = document.getElementById('auth-modal');
  if (!event || event.target === modal) modal.classList.remove('open');
}

async function submitAuth(event) {
  event.preventDefault();
  const button = document.getElementById('auth-submit');
  const errorEl = document.getElementById('auth-error');
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  button.disabled = true;
  errorEl.textContent = '';
  try {
    currentUser = authMode === 'register'
      ? await registerAccount(email, password)
      : await loginAccount(email, password);
    closeAuthModal();
    updateAccountUi();
    const input = document.getElementById('input-text');
    if (input.value.trim()) {
      openPractice();
      await savePracticeText(input.value.trim());
    } else {
      await restoreRecentText(true);
      openPractice();
    }
  } catch (error) {
    errorEl.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function signOut() {
  try {
    await logoutAccount();
  } finally {
    currentUser = null;
    updateAccountUi();
  }
}

async function initializeAccount() {
  try {
    currentUser = await getCurrentUser();
  } catch {
    currentUser = null;
  }
  updateAccountUi();
  if (currentUser) {
    await restoreRecentText(true);
  }
}

function splitSentences(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const protectedText = normalized
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St)\./gi, '$1<dot>')
    .replace(/\b(e\.g|i\.e|etc)\./gi, match => match.replace(/\./g, '<dot>'));

  const matches = protectedText.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g) || [];
  return matches
    .map(sentence => sentence.replace(/<dot>/g, '.').trim())
    .filter(sentence => sentence && /[A-Za-z]/.test(sentence));
}

function processText({ skipSave = false } = {}) {
  const text = document.getElementById('input-text').value.trim();
  if (!text) return;
  stopCurrentActivity();
  recordingPlaybackUrls.forEach(url => {
    if (url) URL.revokeObjectURL(url);
  });
  ttsCache.forEach(url => URL.revokeObjectURL(url));
  ttsCache.clear();
  sentences = splitSentences(text);
  scores = new Array(sentences.length).fill(null);
  recordingPlaybackUrls = new Array(sentences.length).fill(null);
  totalDone = 0;
  renderSentences();
  document.getElementById('stat-total').textContent = sentences.length;
  document.getElementById('stat-done').textContent = 0;
  document.getElementById('legend').style.display = 'flex';
  document.getElementById('btn-read-all').style.display = 'inline-block';
  updateProgress();
  updateAvgScore();
  if (currentUser && !skipSave) {
    savePracticeText(text);
  }
}

function renderSentences() {
  const container = document.getElementById('sentences-container');
  document.getElementById('empty-state').style.display = 'none';
  const existingCards = container.querySelectorAll('.sentence-card');
  existingCards.forEach(c => c.remove());
  sentences.forEach((s, i) => {
    const card = buildCard(s, i);
    container.appendChild(card);
  });
}

function buildCard(sentence, idx) {
  const div = document.createElement('div');
  div.className = 'sentence-card';
  div.id = `card-${idx}`;
  const words = sentence.replace(/[.!?,;:]/g,'').split(' ').filter(w=>w);
  const note = words.length > 18 ? '<div class="sentence-note">Long sentence</div>' : '';

  div.innerHTML = `
    <div class="card-top">
      <div class="card-num">${idx+1}</div>
      <div class="sentence-words" id="words-${idx}">
        ${note}
        ${words.map(w => wordTokenHtml(w)).join(' ')}
      </div>
    </div>
    <div class="card-actions">
      <button class="btn-icon play-sentence-btn" id="play-btn-${idx}" title="Listen to sentence" data-action="play" data-index="${idx}">▶</button>
      <button class="btn-icon" title="Record your voice" id="rec-btn-${idx}" data-action="record" data-index="${idx}">🎙</button>
      <button class="btn-icon replay-recording-btn" title="Replay latest recording" id="replay-btn-${idx}" data-action="replay" data-index="${idx}" ${recordingPlaybackUrls[idx] ? '' : 'disabled'}>↺</button>
      <div class="waveform-wrap" id="wave-${idx}">
        ${Array(18).fill(0).map(()=>`<div class="waveform-bar" style="height:4px"></div>`).join('')}
      </div>
      <div class="card-score-row" id="score-row-${idx}" style="display:none"></div>
    </div>
    <div class="record-status" id="record-status-${idx}"></div>
  `;
  return div;
}

function wordTokenHtml(word, cls = '') {
  const safeWord = escapeHtml(word);
  const safeAttr = escapeHtml(String(word).toLowerCase());
  return `<span class="word-token ${cls}" data-word="${safeAttr}">${safeWord}</span>`;
}

function getEnglishVoice() {
  const voices = speechSynthesis.getVoices();
  return voices.find(v => v.lang?.startsWith('en-') && (v.name.includes('Female') || v.name.includes('Google US'))) ||
    voices.find(v => v.lang?.startsWith('en-')) ||
    voices.find(v => v.lang?.startsWith('en')) ||
    null;
}

function waitForVoices(timeoutMs = 800) {
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

async function speakSentence(idx) {
  if (currentSystemAudio) {
    currentSystemAudio.pause();
    currentSystemAudio = null;
  }
  const btn = document.getElementById(`play-btn-${idx}`);
  btn?.classList.add('playing');
  setRecordStatus(idx, 'Playing the model pronunciation...');

  try {
    await speakText(sentences[idx], { defer: false });
  } catch (error) {
    btn?.classList.remove('playing');
    setRecordStatus(idx, `Could not play the model pronunciation: ${error.message}`, 'error');
    return;
  }

  btn?.classList.remove('playing');
  clearRecordStatus(idx);
}

async function playSystemAudio(text, { cacheKey = text, voice = 'en-US-JennyNeural' } = {}) {
  if (currentSystemAudio) {
    currentSystemAudio.pause();
    currentSystemAudio = null;
  }
  window.speechSynthesis?.cancel();

  let url = ttsCache.get(cacheKey);
  if (!url) {
    url = await synthesizeAzureTts(text, voice);
    ttsCache.set(cacheKey, url);
  }

  const audio = new Audio(url);
  audio.volume = 1;
  currentSystemAudio = audio;
  return new Promise((resolve, reject) => {
    audio.onended = () => {
      currentSystemAudio = null;
      resolve();
    };
    audio.onerror = () => {
      currentSystemAudio = null;
      reject(new Error('Your browser could not play the Azure synthesized audio.'));
    };
    audio.play().catch(error => {
      currentSystemAudio = null;
      reject(error);
    });
  });
}

async function synthesizeAzureTts(text, voice) {
  const credentials = await getSpeechCredentials();
  if (!credentials.region || (!credentials.token && !credentials.key)) {
    throw new Error(`Azure TTS credentials are not configured: ${JSON.stringify(credentials.diagnostics || {})}`);
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
  const response = await fetch(`https://${credentials.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3'
    },
    body: ssml
  });
  if (!response.ok) {
    throw new Error(`Azure TTS ${response.status}: ${await response.text()}`);
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, char => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;'
  }[char]));
}

function speakText(text, options = {}) {
  return new Promise((resolve, reject) => {
    const run = () => {
      utterance = new SpeechSynthesisUtterance(text);
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
          reject(new Error('Speech synthesis did not start. Please try again or check your system speech service.'));
        }
      }, 1200);
      utterance.onstart = () => {
        started = true;
      };
      utterance.onend = () => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      utterance.onerror = event => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(new Error(event.error || 'unknown'));
        }
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

function readAll() {
  if (!sentences.length) return;
  if (readAllTimer) {
    clearTimeout(readAllTimer);
    readAllTimer = null;
  }
  window.speechSynthesis?.cancel();
  if (currentSystemAudio) {
    currentSystemAudio.pause();
    currentSystemAudio = null;
  }
  let i = 0;
  async function next() {
    if (i >= sentences.length) return;
    await speakSentence(i++);
    const delay = 250;
    readAllTimer = setTimeout(next, delay);
  }
  next();
}

function stopCurrentActivity() {
  clearCountdown();
  if (readAllTimer) {
    clearTimeout(readAllTimer);
    readAllTimer = null;
  }
  window.speechSynthesis?.cancel();
  if (currentSystemAudio) {
    currentSystemAudio.pause();
    currentSystemAudio = null;
  }
  if (currentReplayAudio) {
    currentReplayAudio.pause();
    currentReplayAudio = null;
  }
  if (activeRecording !== -1) {
    stopRecording(activeRecording);
  }
}

function clearCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function startReadyCountdown(idx, seconds, onDone) {
  clearCountdown();
  let remaining = seconds;
  setRecordStatusHtml(idx, `Azure is ready. Start reading in ${remaining} seconds.<span class="live-transcript">Take a breath and wait for the countdown.</span>`);
  countdownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining > 0) {
      setRecordStatusHtml(idx, `Azure is ready. Start reading in ${remaining} seconds.<span class="live-transcript">Take a breath and wait for the countdown.</span>`);
      return;
    }
    clearCountdown();
    onDone();
  }, 1000);
}

function setRecordStatus(idx, message, type = '') {
  const el = document.getElementById(`record-status-${idx}`);
  if (!el) return;
  el.textContent = message;
  el.className = `record-status visible ${type}`.trim();
}

function clearRecordStatus(idx) {
  const el = document.getElementById(`record-status-${idx}`);
  if (!el) return;
  el.textContent = '';
  el.className = 'record-status';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char]));
}

function setRecordStatusHtml(idx, html, type = '') {
  const el = document.getElementById(`record-status-${idx}`);
  if (!el) return;
  el.innerHTML = html;
  el.className = `record-status visible ${type}`.trim();
}

function setRecordButtonState(idx, label, title, disabled = false) {
  const btn = document.getElementById(`rec-btn-${idx}`);
  if (!btn) return;
  btn.textContent = label;
  btn.title = title;
  btn.disabled = disabled;
}

async function startPlaybackCapture(idx) {
  stopPlaybackCapture(idx, false);
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return;
  try {
    playbackStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    playbackRecorder = new MediaRecorder(playbackStream, { mimeType });
    playbackChunks = [];
    playbackRecorder.ondataavailable = event => {
      if (event.data.size > 0) playbackChunks.push(event.data);
    };
    playbackRecorder.onstop = () => savePlaybackRecording(idx);
    playbackRecorder.start(100);
  } catch (error) {
    console.warn('Playback recording unavailable:', error);
  }
}

function stopPlaybackCapture(idx, shouldSave = true) {
  if (playbackRecorder && playbackRecorder.state !== 'inactive') {
    if (!shouldSave) playbackRecorder.onstop = null;
    playbackRecorder.stop();
  } else if (shouldSave) {
    savePlaybackRecording(idx);
  }
  if (playbackStream) {
    playbackStream.getTracks().forEach(track => track.stop());
    playbackStream = null;
  }
  playbackRecorder = null;
}

function savePlaybackRecording(idx) {
  if (!playbackChunks.length) return;
  if (recordingPlaybackUrls[idx]) URL.revokeObjectURL(recordingPlaybackUrls[idx]);
  const blob = new Blob(playbackChunks, { type: playbackChunks[0]?.type || 'audio/webm' });
  recordingPlaybackUrls[idx] = URL.createObjectURL(blob);
  playbackChunks = [];
  updateReplayButton(idx);
}

function updateReplayButton(idx) {
  const btn = document.getElementById(`replay-btn-${idx}`);
  if (!btn) return;
  btn.disabled = !recordingPlaybackUrls[idx];
}

function replayRecording(idx) {
  const url = recordingPlaybackUrls[idx];
  if (!url) {
    setRecordStatus(idx, 'No recording is available yet. Complete one reading first.');
    return;
  }
  window.speechSynthesis?.cancel();
  if (currentReplayAudio) {
    currentReplayAudio.pause();
    currentReplayAudio = null;
  }
  const audio = new Audio(url);
  currentReplayAudio = audio;
  audio.volume = 1;
  const btn = document.getElementById(`replay-btn-${idx}`);
  if (btn) {
    btn.classList.add('playing');
    btn.disabled = true;
  }
  audio.onended = () => {
    if (btn) {
      btn.classList.remove('playing');
      btn.disabled = false;
    }
    currentReplayAudio = null;
  };
  audio.onerror = () => {
    setRecordStatus(idx, 'Recording playback failed: your browser could not decode this audio.', 'error');
    if (btn) {
      btn.classList.remove('playing');
      btn.disabled = false;
    }
    currentReplayAudio = null;
  };
  audio.play().catch(error => {
    setRecordStatus(idx, `Recording playback failed: ${error.message}`, 'error');
    if (btn) {
      btn.classList.remove('playing');
      btn.disabled = false;
    }
    currentReplayAudio = null;
  });
}

async function toggleRecord(idx) {
  if (isFinalizingAssessment) return;
  if (activeRecording === idx) {
    stopRecording(idx);
  } else {
    if (activeRecording !== -1) stopRecording(activeRecording);
    await startRecording(idx);
  }
}

async function startRecording(idx) {
  if (window.SpeechSDK) {
    return startAzureContinuousAssessment(idx);
  }

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This page cannot access your microphone. Open it over http://127.0.0.1 or HTTPS instead of an unsupported local file context.');
    }
    if (!window.MediaRecorder) {
      throw new Error('Your browser does not support MediaRecorder. Please use a recent version of Chrome or Edge.');
    }
    clearRecordStatus(idx);
    setRecordStatus(idx, 'Requesting microphone access...');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Use audio/webm if supported, else fallback
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    mediaRecorder = new MediaRecorder(stream, { mimeType });
    audioChunks = [];
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      saveFallbackPlaybackRecording(idx);
      processRecording(idx);
    };
    mediaRecorder.start(100); // collect data every 100ms
    activeRecording = idx;
    const btn = document.getElementById(`rec-btn-${idx}`);
    btn.classList.add('recording');
    btn.textContent = '■';
    btn.title = 'Stop recording';
    const card = document.getElementById(`card-${idx}`);
    card.classList.add('active');
    setRecordStatus(idx, 'Recording now. Read this sentence aloud. Click the red button again to stop, or wait for automatic analysis.');
    startWaveform(idx);
    const maxMs = Math.min(30000, Math.max(10000, sentences[idx].split(/\s+/).length * 950 + 4500));
    autoStopTimer = setTimeout(() => {
      if (activeRecording === idx) stopRecording(idx);
    }, maxMs);
  } catch(e) {
    console.error('Recording start error:', e);
    setRecordStatus(idx, e.message || 'Could not start the microphone. Check permission and try again.', 'error');
  }
}

function saveFallbackPlaybackRecording(idx) {
  if (!audioChunks.length) return;
  if (recordingPlaybackUrls[idx]) URL.revokeObjectURL(recordingPlaybackUrls[idx]);
  const blob = new Blob(audioChunks, { type: 'audio/webm' });
  recordingPlaybackUrls[idx] = URL.createObjectURL(blob);
  updateReplayButton(idx);
}

function stopRecording(idx) {
  if (speechRecognizer) {
    stopAzureContinuousAssessment(idx);
    return;
  }

  if (autoStopTimer) {
    clearTimeout(autoStopTimer);
    autoStopTimer = null;
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    setRecordStatus(idx, 'Recording finished. Analyzing your pronunciation...');
    mediaRecorder.stop();
  } else {
    processRecording(idx);
  }
  clearInterval(waveInterval);
  const btn = document.getElementById(`rec-btn-${idx}`);
  if (btn) { btn.classList.remove('recording'); btn.textContent = '⏳'; btn.title = 'Analyzing...'; btn.disabled = true; }
  const waveEl = document.getElementById(`wave-${idx}`);
  if (waveEl) waveEl.classList.remove('visible');
  activeRecording = -1;
}



function startWaveform(idx) {
  const wave = document.getElementById(`wave-${idx}`);
  wave.classList.add('visible');
  const bars = wave.querySelectorAll('.waveform-bar');
  waveInterval = setInterval(() => {
    bars.forEach(b => {
      const h = Math.random() * 26 + 3;
      b.style.height = h + 'px';
    });
  }, 100);
}

async function startAzureContinuousAssessment(idx) {
  try {
    if (speechRecognizer || isFinalizingAssessment) return;
    clearRecordStatus(idx);
    if (!window.SpeechSDK) throw new Error('Azure Speech SDK did not load. Check your connection and refresh.');

    const sdk = window.SpeechSDK;
    const credentials = await getSpeechCredentials();
    if (!credentials.region || (!credentials.token && !credentials.key)) {
      throw new Error(`Azure Speech credentials are not configured. Status: ${JSON.stringify(credentials.diagnostics || {})}`);
    }
    const speechConfig = credentials.token
      ? sdk.SpeechConfig.fromAuthorizationToken(credentials.token, credentials.region)
      : sdk.SpeechConfig.fromSubscription(credentials.key, credentials.region);
    speechConfig.speechRecognitionLanguage = 'en-US';
    speechConfig.outputFormat = sdk.OutputFormat.Detailed;

    const audioConfig = sdk.AudioConfig.fromDefaultMicrophoneInput();
    speechRecognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

    const pronunciationConfig = new sdk.PronunciationAssessmentConfig(
      sentences[idx],
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
    pronunciationConfig.applyTo(speechRecognizer);

    continuousState = {
      idx,
      recognizedText: [],
      recognizedWords: [],
      fluencyScores: [],
      prosodyScores: [],
      durations: [],
      latestPartial: ''
    };

    speechRecognizer.recognizing = (_, event) => {
      continuousState.latestPartial = event.result?.text || '';
      renderLiveTranscript(idx);
    };

    speechRecognizer.recognized = (_, event) => {
      if (!event.result || event.result.reason !== sdk.ResultReason.RecognizedSpeech) return;
      const text = event.result.text || '';
      if (text) continuousState.recognizedText.push(text);
      const jsonText = event.result.properties.getProperty(sdk.PropertyId.SpeechServiceResponse_JsonResult);
      collectAzureSegment(jsonText);
      continuousState.latestPartial = '';
      renderLiveTranscript(idx);
    };

    speechRecognizer.canceled = (_, event) => {
      console.error('Azure continuous recognition canceled:', event);
      setRecordStatus(idx, `Azure recognition canceled: ${event.errorDetails || event.reason || 'Unknown'}`, 'error');
      cleanupAzureContinuous(idx, false);
    };

    speechRecognizer.sessionStopped = () => {
      finishAzureContinuousAssessment(idx);
    };

    activeRecording = idx;
    const btn = document.getElementById(`rec-btn-${idx}`);
    btn.classList.add('recording');
    btn.textContent = '■';
    btn.title = 'Stop recording';
    document.getElementById(`card-${idx}`).classList.add('active');
    setRecordStatusHtml(idx, 'Connecting to Azure and preparing the microphone...<span class="live-transcript">Please wait for the countdown before speaking.</span>');
    startWaveform(idx);

    speechRecognizer.startContinuousRecognitionAsync(
      () => {
        isFinalizingAssessment = false;
        startReadyCountdown(idx, 3, async () => {
          if (activeRecording !== idx || !speechRecognizer) return;
          await startPlaybackCapture(idx);
          setRecordStatusHtml(idx, 'Start reading now. Click the red button again to stop.<span class="live-transcript">Waiting for your voice...</span>');
          const maxMs = Math.min(45000, Math.max(16000, sentences[idx].split(/\s+/).length * 1300 + 6500));
          autoStopTimer = setTimeout(() => {
            if (activeRecording === idx) stopAzureContinuousAssessment(idx);
          }, maxMs);
        });
      },
      error => {
        console.error('Azure start error:', error);
        setRecordStatus(idx, `Azure failed to start: ${error}`, 'error');
        cleanupAzureContinuous(idx, false);
      }
    );
  } catch (e) {
    console.error('Azure continuous setup error:', e);
    setRecordStatus(idx, e.message || 'Azure continuous recognition could not start.', 'error');
    cleanupAzureContinuous(idx, false);
  }
}

function stopAzureContinuousAssessment(idx) {
  if (isFinalizingAssessment) return;
  isFinalizingAssessment = true;
  clearCountdown();
  if (autoStopTimer) {
    clearTimeout(autoStopTimer);
    autoStopTimer = null;
  }
  stopPlaybackCapture(idx, true);
  setRecordButtonState(idx, '⏳', 'Finalizing assessment...', true);
  setRecordStatus(idx, 'Finishing recognition and generating your assessment...');
  if (!speechRecognizer) {
    finishAzureContinuousAssessment(idx);
    return;
  }
  speechRecognizer.stopContinuousRecognitionAsync(
    () => finishAzureContinuousAssessment(idx),
    error => {
      console.error('Azure stop error:', error);
      setRecordStatus(idx, `Could not stop recognition: ${error}`, 'error');
      cleanupAzureContinuous(idx, false);
    }
  );
}

function collectAzureSegment(jsonText) {
  if (!jsonText || !continuousState) return;
  try {
    const data = JSON.parse(jsonText);
    const nBest = data.NBest?.[0];
    if (!nBest) return;
    const pa = nBest.PronunciationAssessment || {};
    if (typeof pa.FluencyScore === 'number') continuousState.fluencyScores.push(pa.FluencyScore);
    if (typeof pa.ProsodyScore === 'number') continuousState.prosodyScores.push(pa.ProsodyScore);
    const words = nBest.Words || [];
    if (words.length) {
      continuousState.recognizedWords.push(...words);
      continuousState.durations.push(words.reduce((sum, word) => sum + Number(word.Duration || 0), 0));
    }
  } catch (e) {
    console.warn('Could not parse Azure JSON segment:', e);
  }
}

function renderLiveTranscript(idx) {
  if (!continuousState) return;
  const finalText = continuousState.recognizedText.join(' ');
  const partialText = continuousState.latestPartial;
  setRecordStatusHtml(idx, `
    Recording now. Live transcript:
    <span class="live-transcript">${escapeHtml(finalText || '...')} ${partialText ? `<em>${escapeHtml(partialText)}</em>` : ''}</span>
  `);
}

function finishAzureContinuousAssessment(idx) {
  if (!isFinalizingAssessment && activeRecording !== idx) {
    return;
  }
  if (!continuousState || continuousState.idx !== idx) {
    cleanupAzureContinuous(idx, false);
    return;
  }
  const assessment = buildContinuousAssessment(sentences[idx], continuousState);
  scores[idx] = assessment.overall;
  renderWordScores(idx, assessment.words, assessment.wordScores);
  renderScoreRow(idx, assessment.overall);
  setRecordStatusHtml(idx, renderAssessmentSummary(assessment), assessment.overall > 0 ? 'success' : 'error');
  document.getElementById(`card-${idx}`).classList.remove('active');
  document.getElementById(`card-${idx}`).classList.add('done');
  totalDone = scores.filter(s => s !== null).length;
  document.getElementById('stat-done').textContent = totalDone;
  updateProgress();
  updateAvgScore();
  cleanupAzureContinuous(idx, true);
}

function cleanupAzureContinuous(idx, keepStatus) {
  clearCountdown();
  stopPlaybackCapture(idx, keepStatus);
  if (autoStopTimer) {
    clearTimeout(autoStopTimer);
    autoStopTimer = null;
  }
  clearInterval(waveInterval);
  const waveEl = document.getElementById(`wave-${idx}`);
  if (waveEl) waveEl.classList.remove('visible');
  const btn = document.getElementById(`rec-btn-${idx}`);
  if (btn) {
    btn.classList.remove('recording');
    btn.textContent = '🎙';
    btn.title = 'Record again';
    btn.disabled = false;
  }
  const card = document.getElementById(`card-${idx}`);
  if (card) card.classList.remove('active');
  if (speechRecognizer) {
    speechRecognizer.close?.();
    speechRecognizer = null;
  }
  continuousState = null;
  activeRecording = -1;
  isFinalizingAssessment = false;
  if (!keepStatus) setRecordButtonState(idx, '🎙', 'Record again', false);
}

function buildContinuousAssessment(referenceText, state) {
  const referenceWords = referenceText.toLowerCase().split(/\s+/).map(w => w.replace(/^[^\w]+|[^\w]+$/g, '')).filter(Boolean);
  const finalWords = alignContinuousWords(referenceWords, state.recognizedWords);
  const scoredWords = finalWords.filter(word => word.errorType !== 'Insertion');
  const accuracyScores = scoredWords.map(word => word.accuracyScore || 0);
  const accuracy = accuracyScores.length ? average(accuracyScores) : 0;
  const fluency = weightedAverage(state.fluencyScores, state.durations);
  const prosody = state.prosodyScores.length ? average(state.prosodyScores) : 0;
  const recognizedNormalWords = state.recognizedWords.filter(w => (w.PronunciationAssessment?.ErrorType || 'None') === 'None');
  const completeness = Math.min(100, recognizedNormalWords.length / Math.max(referenceWords.length, 1) * 100);
  const overall = clampScore(accuracy * 0.4 + prosody * 0.2 + fluency * 0.2 + completeness * 0.2);

  const displayWords = finalWords.filter(word => word.errorType !== 'Insertion').map(word => word.word);
  const wordScores = finalWords.filter(word => word.errorType !== 'Insertion').map(word => {
    if (word.errorType === 'Omission') return 'missed';
    if (word.errorType === 'Insertion') return 'wrong';
    if (word.accuracyScore >= 80) return 'correct';
    if (word.accuracyScore >= 55) return 'close';
    if (word.accuracyScore > 0) return 'wrong';
    return 'missed';
  });

  return {
    words: displayWords.length ? displayWords : referenceWords,
    wordScores: wordScores.length ? wordScores : referenceWords.map(() => 'missed'),
    overall,
    accuracy: Math.round(accuracy),
    completeness: Math.round(completeness),
    fluency: Math.round(fluency),
    prosody: Math.round(prosody),
    recognizedText: state.recognizedText.join(' ') || '—',
    insertions: finalWords.filter(word => word.errorType === 'Insertion').map(word => word.word)
  };
}

function alignContinuousWords(referenceWords, recognizedWords) {
  const normalizedRecognized = recognizedWords.map(word => ({
    word: word.Word,
    key: normalizeWord(word.Word),
    accuracyScore: word.PronunciationAssessment?.AccuracyScore || 0,
    errorType: word.PronunciationAssessment?.ErrorType || 'None'
  }));
  const recognizedKeys = normalizedRecognized.map(word => word.key);
  const finalWords = [];
  const matrix = buildLcsMatrix(referenceWords.map(normalizeWord), recognizedKeys);
  let i = 0;
  let j = 0;
  const referenceKeys = referenceWords.map(normalizeWord);

  while (i < referenceKeys.length && j < recognizedKeys.length) {
    if (referenceKeys[i] === recognizedKeys[j]) {
      finalWords.push({ ...normalizedRecognized[j], word: referenceWords[i] });
      i++;
      j++;
    } else if (matrix[i + 1][j] >= matrix[i][j + 1]) {
      finalWords.push({ word: referenceWords[i], accuracyScore: 0, errorType: 'Omission' });
      i++;
    } else {
      finalWords.push({ ...normalizedRecognized[j], errorType: normalizedRecognized[j].errorType === 'None' ? 'Insertion' : normalizedRecognized[j].errorType });
      j++;
    }
  }
  while (i < referenceKeys.length) {
    finalWords.push({ word: referenceWords[i], accuracyScore: 0, errorType: 'Omission' });
    i++;
  }
  while (j < recognizedKeys.length) {
    finalWords.push({ ...normalizedRecognized[j], errorType: normalizedRecognized[j].errorType === 'None' ? 'Insertion' : normalizedRecognized[j].errorType });
    j++;
  }
  return finalWords;
}

function buildLcsMatrix(a, b) {
  const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      matrix[i][j] = a[i] === b[j] ? matrix[i + 1][j + 1] + 1 : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    }
  }
  return matrix;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function weightedAverage(values, weights) {
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  if (!values.length || !totalWeight) return values.length ? average(values) : 0;
  return values.reduce((sum, value, index) => sum + value * (weights[index] || 0), 0) / totalWeight;
}

function renderAssessmentSummary(assessment) {
  const insertionText = assessment.insertions.length ? `<br>Extra words: ${escapeHtml(assessment.insertions.join(', '))}` : '';
  const safeOverall = clampScore(assessment.overall);
  const safeAccuracy = clampScore(assessment.accuracy);
  const safeCompleteness = clampScore(assessment.completeness);
  const safeFluency = clampScore(assessment.fluency);
  const safeProsody = clampScore(assessment.prosody);
  return `
    Assessment complete: ${safeOverall}%
    <div class="assessment-grid">
      <div class="assessment-chip">Pronunciation <strong>${safeOverall}%</strong></div>
      <div class="assessment-chip">Accuracy <strong>${safeAccuracy}%</strong></div>
      <div class="assessment-chip">Completeness <strong>${safeCompleteness}%</strong></div>
      <div class="assessment-chip">Fluency <strong>${safeFluency}%</strong></div>
      <div class="assessment-chip">Prosody <strong>${safeProsody}%</strong></div>
    </div>
    <span class="live-transcript">Final transcript: ${escapeHtml(assessment.recognizedText)}${insertionText}</span>
  `;
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

async function processRecording(idx) {
  // Show analyzing state
  const btn = document.getElementById(`rec-btn-${idx}`);
  if (btn) { btn.textContent = '⏳'; btn.title = 'Analyzing...'; btn.disabled = true; }

  try {
    if (!audioChunks.length) {
      throw new Error('No audio was recorded. Confirm your microphone is working and try again.');
    }
    const blob = new Blob(audioChunks, { type: 'audio/webm' });
    if (blob.size < 800) {
      throw new Error('The recording was too short or silent. Read the complete sentence before stopping.');
    }
    setRecordStatus(idx, 'Converting audio...');
    const wavBlob = await convertToWav(blob);
    setRecordStatus(idx, 'Running Azure Pronunciation Assessment...');
    const result = await azurePronunciationAssess(wavBlob, sentences[idx]);
    scores[idx] = result.overall;
    renderWordScores(idx, result.words, result.wordScores);
    renderScoreRow(idx, result.overall);
    setRecordStatus(idx, `Analysis complete: ${result.overall}%${result.debug ? '. ' + result.debug : ''}`, result.overall > 0 ? 'success' : 'error');
  } catch(e) {
    console.error('Azure assessment error:', e);
    // Fallback: show error on card
    const scoreRow = document.getElementById(`score-row-${idx}`);
    scoreRow.style.display = 'flex';
    scoreRow.innerHTML = `<span class="score-text" style="color:var(--red)">Error</span>`;
    setRecordStatus(idx, e.message || 'Analysis failed. Please try again later.', 'error');
  }

  if (btn) { btn.textContent = '🎙'; btn.title = 'Record again'; btn.disabled = false; }
  document.getElementById(`card-${idx}`).classList.remove('active');
  document.getElementById(`card-${idx}`).classList.add('done');
  totalDone = scores.filter(s => s !== null).length;
  document.getElementById('stat-done').textContent = totalDone;
  updateProgress();
  updateAvgScore();
}

// Convert audio blob to WAV (Azure requires PCM WAV)
async function convertToWav(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await audioCtx.decodeAudioData(arrayBuffer);
  const source = decoded.getChannelData(0);
  const samples = downsampleBuffer(source, decoded.sampleRate, 16000);
  await audioCtx.close?.();
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  // Build WAV header
  const wavBuffer = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(wavBuffer);
  const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);       // PCM
  view.setUint16(22, 1, true);       // mono
  view.setUint32(24, 16000, true);   // sample rate
  view.setUint32(28, 32000, true);   // byte rate
  view.setUint16(32, 2, true);       // block align
  view.setUint16(34, 16, true);      // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  new Int16Array(wavBuffer, 44).set(pcm);
  return new Blob([wavBuffer], { type: 'audio/wav' });
}

function downsampleBuffer(buffer, inputRate, outputRate) {
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

// Call Azure Pronunciation Assessment REST API
async function azurePronunciationAssess(wavBlob, referenceText) {
  const credentials = await getSpeechCredentials();
  if (!credentials.region || (!credentials.token && !credentials.key)) {
    throw new Error('Azure Speech credentials are not configured.');
  }

  const pronunciationAssessmentConfig = JSON.stringify({
    ReferenceText: referenceText,
    GradingSystem: 'HundredMark',
    Granularity: 'Phoneme',
    Dimension: 'Comprehensive',
    EnableMiscue: true,
    PhonemeAlphabet: 'IPA'
  });
  const configBase64 = btoa(unescape(encodeURIComponent(pronunciationAssessmentConfig)));

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
    body: wavBlob
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Azure API error ${response.status}: ${err}`);
  }

  const data = await response.json();

  // Parse per-word scores from Azure response
  const nBest = data.NBest?.[0];
  if (!nBest) {
    throw new Error(`Azure returned no recognition result: ${data.RecognitionStatus || 'Unknown status'}`);
  }

  const refWords = referenceText.replace(/[.!?,;:]/g,'').split(' ').filter(w=>w);
  const azureWords = nBest.Words || [];

  if (!azureWords.length) {
    const recognizedText = nBest.Display || nBest.Lexical || data.DisplayText || '';
    if (recognizedText.trim()) {
      const fallback = fallbackScoreFromRecognizedText(refWords, recognizedText);
      return {
        ...fallback,
        debug: `Azure returned recognized text without word-level scores. Transcript: ${recognizedText}`
      };
    }

    return {
      words: refWords,
      wordScores: refWords.map(() => 'missed'),
      overall: 0,
      debug: `Azure did not recognize valid speech. RecognitionStatus: ${data.RecognitionStatus || 'Unknown'}`
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
    wordScores: wordScores.some(score => score !== 'missed') ? wordScores : textFallback.wordScores,
    overall,
    debug: `Azure: ${data.RecognitionStatus || 'Success'}; transcript: ${recognizedText || '—'}`
  };
}

function normalizeWord(word) {
  const normalized = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (normalized === 'ai' || normalized === 'artificialintelligence') return 'ai';
  return normalized;
}

function expandComparableWord(word) {
  const normalized = normalizeWord(word);
  if (normalized === 'ai') return ['ai', 'a', 'i'];
  return [normalized];
}

function alignAzureWordsToReference(refWords, azureWords) {
  const aligned = [];
  let cursor = 0;

  refWords.forEach(refWord => {
    const refParts = expandComparableWord(refWord);
    let bestIndex = -1;
    let bestScore = 0;
    const windowEnd = Math.min(azureWords.length, cursor + 6);

    for (let i = cursor; i < windowEnd; i++) {
      const current = normalizeWord(azureWords[i].Word);
      let score = wordSimilarity(refParts[0], current);

      if (refParts.length > 1) {
        const phrase = azureWords.slice(i, i + refParts.length).map(w => normalizeWord(w.Word)).join('');
        score = Math.max(score, wordSimilarity(refParts.join(''), phrase));
      }

      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0 && bestScore >= 0.5) {
      aligned.push(azureWords[bestIndex]);
      cursor = bestIndex + refParts.length;
    } else {
      aligned.push(null);
    }
  });

  return aligned;
}

function fallbackScoreFromRecognizedText(refWords, recognizedText) {
  const spokenWords = recognizedText.replace(/[.!?,;:]/g,'').split(/\s+/).filter(Boolean).map(normalizeWord);
  const scores = refWords.map(refWord => {
    const ref = normalizeWord(refWord);
    const best = spokenWords.reduce((max, spoken) => Math.max(max, wordSimilarity(ref, spoken)), 0);
    if (best >= 0.9) return { cls: 'correct', score: best };
    if (best >= 0.7) return { cls: 'close', score: best };
    if (best >= 0.5) return { cls: 'wrong', score: best };
    return { cls: 'missed', score: 0 };
  });
  return {
    words: refWords,
    wordScores: scores.map(item => item.cls),
    overall: Math.round(scores.reduce((sum, item) => sum + item.score, 0) / Math.max(scores.length, 1) * 100)
  };
}

function wordSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const distance = levenshtein(a, b);
  return 1 - distance / Math.max(a.length, b.length);
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => []);
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

function renderWordScores(idx, words, wordScores) {
  const container = document.getElementById(`words-${idx}`);
  container.innerHTML = words.map((w, i) => wordTokenHtml(w, wordScores[i] || '')).join(' ');
}

function renderScoreRow(idx, overall) {
  const row = document.getElementById(`score-row-${idx}`);
  let cls = overall >= 80 ? 'filled-green' : overall >= 55 ? 'filled-yellow' : 'filled-red';
  row.style.display = 'flex';
  row.innerHTML = `
    <span class="score-text">${overall}%</span>
    <div class="score-dot ${cls}"></div>
  `;
}

function updateProgress() {
  const done = scores.filter(s=>s!==null).length;
  const pct = sentences.length ? (done / sentences.length * 100) : 0;
  document.getElementById('progress-fill').style.width = pct + '%';
}

function updateAvgScore() {
  const done = scores.filter(s=>s!==null);
  if (!done.length) {
    document.getElementById('avg-score-pill').style.display = 'none';
    document.getElementById('overall-score-badge').style.display = 'none';
    document.getElementById('stat-avg').textContent = '—';
    document.getElementById('overall-score').textContent = '—';
    return;
  }
  const avg = Math.round(done.reduce((a,b)=>a+b,0)/done.length);
  document.getElementById('avg-score-pill').style.display = 'flex';
  document.getElementById('stat-avg').textContent = avg + '%';
  const el = document.getElementById('overall-score-badge');
  el.style.display = 'flex';
  document.getElementById('overall-score').textContent = avg + '%';
}

// ====== WORD MODAL ======
async function showWordModal(word) {
  currentWord = word;
  const clean = word.replace(/[^a-z]/gi,'').toLowerCase();
  document.getElementById('modal-word-text').textContent = clean;
  document.getElementById('modal-phonetic-text').textContent = '...';
  document.getElementById('modal-def-text').textContent = 'Looking up...';
  document.getElementById('modal-example-text').textContent = '...';
  document.getElementById('word-modal').classList.add('open');

  if (wordDB[clean]) {
    const info = wordDB[clean];
    document.getElementById('modal-phonetic-text').textContent = info.phonetic;
    document.getElementById('modal-def-text').textContent = info.def;
    document.getElementById('modal-example-text').textContent = info.ex;
  } else {
    await fetchWordInfo(clean);
  }
}

async function fetchWordInfo(word) {
  try {
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    if (!response.ok) throw new Error('Dictionary lookup failed');
    const data = await response.json();
    const entry = data[0] || {};
    const meaning = entry.meanings?.[0];
    const definition = meaning?.definitions?.[0];
    const info = {
      phonetic: entry.phonetic || entry.phonetics?.find(item => item.text)?.text || '/—/',
      def: definition?.definition || 'Definition not found.',
      ex: definition?.example || 'No example available.'
    };
    document.getElementById('modal-phonetic-text').textContent = info.phonetic;
    document.getElementById('modal-def-text').textContent = info.def;
    document.getElementById('modal-example-text').textContent = info.ex;
    wordDB[word] = info;
  } catch(e) {
    document.getElementById('modal-phonetic-text').textContent = '/—/';
    document.getElementById('modal-def-text').textContent = 'Could not load definition.';
    document.getElementById('modal-example-text').textContent = '—';
  }
}

function speakWord() {
  if (!currentWord) return;
  playSystemAudio(currentWord, { cacheKey: `word:${currentWord}`, voice: 'en-US-JennyNeural' }).catch(() => {
    waitForVoices().then(() => speakText(currentWord, { rate: 0.8 })).catch(() => {});
  });
}

function closeModal(e) {
  if (e.target === document.getElementById('word-modal')) closeWordModal();
}
function closeWordModal() {
  document.getElementById('word-modal').classList.remove('open');
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeWordModal();
    closeAuthModal();
  }
});

document.getElementById('auth-form').addEventListener('submit', submitAuth);

document.getElementById('sentences-container').addEventListener('click', event => {
  const word = event.target.closest('.word-token');
  if (word) {
    showWordModal(word.dataset.word);
    return;
  }

  const actionButton = event.target.closest('[data-action]');
  if (!actionButton) return;
  const idx = Number(actionButton.dataset.index);
  if (!Number.isInteger(idx)) return;

  if (actionButton.dataset.action === 'play') {
    speakSentence(idx);
  } else if (actionButton.dataset.action === 'record') {
    toggleRecord(idx);
  } else if (actionButton.dataset.action === 'replay') {
    replayRecording(idx);
  }
});

if (window.speechSynthesis) {
  speechSynthesis.getVoices();
}

if (window.location.hash === '#practice') {
  openPractice();
}

initializeAccount();

Object.assign(window, {
  openPractice,
  showHome,
  openAuthModal,
  closeAuthModal,
  switchAuthMode,
  signOut,
  processText,
  loadSample,
  speakSentence,
  readAll,
  toggleRecord,
  showWordModal,
  speakWord,
  closeModal,
  closeWordModal,
  replayRecording
});
