/**
 * ui.js
 * All DOM rendering and view-layer helpers.
 * No network calls, no audio — just reads app state and writes to the DOM.
 */

// ─── Escape helpers ───────────────────────────────────────────────────────────

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[char]));
}

// ─── Word tokens ──────────────────────────────────────────────────────────────

export function wordTokenHtml(word, cls = '') {
  const safe = escapeHtml(word);
  const attr = escapeHtml(String(word).toLowerCase());
  return `<span class="word-token ${cls}" data-word="${attr}">${safe}</span>`;
}

// ─── Card building ────────────────────────────────────────────────────────────

export function buildCard(sentence, idx, hasRecording = false) {
  const words = sentence.replace(/[.!?,;:]/g, '').split(' ').filter(w => w);
  const note = words.length > 18 ? '<div class="sentence-note">Long sentence</div>' : '';

  const div = document.createElement('div');
  div.className = 'sentence-card';
  div.id = `card-${idx}`;
  div.innerHTML = `
    <div class="card-top">
      <div class="card-num">${idx + 1}</div>
      <div class="sentence-words" id="words-${idx}">
        ${note}
        ${words.map(w => wordTokenHtml(w)).join(' ')}
      </div>
    </div>
    <div class="card-actions">
      <button class="btn-icon play-sentence-btn" id="play-btn-${idx}"
        title="Listen to sentence" data-action="play" data-index="${idx}">▶</button>
      <button class="btn-icon" title="Record your voice"
        id="rec-btn-${idx}" data-action="record" data-index="${idx}">🎙</button>
      <button class="btn-icon replay-recording-btn" title="Replay latest recording"
        id="replay-btn-${idx}" data-action="replay" data-index="${idx}"
        ${hasRecording ? '' : 'disabled'}>↺</button>
      <div class="waveform-wrap" id="wave-${idx}">
        ${Array(18).fill(0).map(() => `<div class="waveform-bar" style="height:4px"></div>`).join('')}
      </div>
      <div class="card-score-row" id="score-row-${idx}" style="display:none"></div>
    </div>
    <div class="record-status" id="record-status-${idx}"></div>
  `;
  return div;
}

export function renderSentences(sentences, recordingPlaybackUrls = []) {
  const container = document.getElementById('sentences-container');
  document.getElementById('empty-state').style.display = 'none';

  container.querySelectorAll('.sentence-card').forEach(c => c.remove());
  sentences.forEach((s, i) => {
    container.appendChild(buildCard(s, i, Boolean(recordingPlaybackUrls[i])));
  });
}

// ─── Word scores ──────────────────────────────────────────────────────────────

export function renderWordScores(idx, words, wordScores) {
  const container = document.getElementById(`words-${idx}`);
  if (!container) return;
  container.innerHTML = words.map((w, i) => wordTokenHtml(w, wordScores[i] || '')).join(' ');
}

// ─── Score row ────────────────────────────────────────────────────────────────

export function renderScoreRow(idx, overall) {
  const row = document.getElementById(`score-row-${idx}`);
  if (!row) return;
  const cls = overall >= 80 ? 'filled-green' : overall >= 55 ? 'filled-yellow' : 'filled-red';
  row.style.display = 'flex';
  row.innerHTML = `
    <span class="score-text">${overall}%</span>
    <div class="score-dot ${cls}"></div>
  `;
}

// ─── Assessment summary HTML ──────────────────────────────────────────────────

export function renderAssessmentSummaryHtml(assessment) {
  const insertionText = assessment.insertions?.length
    ? `<br>多读词：${escapeHtml(assessment.insertions.join(', '))}`
    : '';
  const s = {
    overall: clamp(assessment.overall),
    accuracy: clamp(assessment.accuracy),
    completeness: clamp(assessment.completeness),
    fluency: clamp(assessment.fluency),
    prosody: clamp(assessment.prosody),
  };
  return `
    评估完成：${s.overall}%
    <div class="assessment-grid">
      <div class="assessment-chip">Pronunciation <strong>${s.overall}%</strong></div>
      <div class="assessment-chip">Accuracy <strong>${s.accuracy}%</strong></div>
      <div class="assessment-chip">Completeness <strong>${s.completeness}%</strong></div>
      <div class="assessment-chip">Fluency <strong>${s.fluency}%</strong></div>
      <div class="assessment-chip">Prosody <strong>${s.prosody}%</strong></div>
    </div>
    <span class="live-transcript">最终识别：${escapeHtml(assessment.recognizedText)}${insertionText}</span>
  `;
}

function clamp(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// ─── Live transcript ──────────────────────────────────────────────────────────

export function renderLiveTranscript(idx, finalText, partialText) {
  setRecordStatusHtml(idx, `
    正在录音，实时识别：
    <span class="live-transcript">${escapeHtml(finalText || '...')} ${
      partialText ? `<em>${escapeHtml(partialText)}</em>` : ''
    }</span>
  `);
}

// ─── Status helpers ───────────────────────────────────────────────────────────

export function setRecordStatus(idx, message, type = '') {
  const el = document.getElementById(`record-status-${idx}`);
  if (!el) return;
  el.textContent = message;
  el.className = `record-status visible ${type}`.trim();
}

export function setRecordStatusHtml(idx, html, type = '') {
  const el = document.getElementById(`record-status-${idx}`);
  if (!el) return;
  el.innerHTML = html;
  el.className = `record-status visible ${type}`.trim();
}

export function clearRecordStatus(idx) {
  const el = document.getElementById(`record-status-${idx}`);
  if (!el) return;
  el.textContent = '';
  el.className = 'record-status';
}

// ─── Button state helpers ─────────────────────────────────────────────────────

export function setRecordButtonState(idx, label, title, disabled = false) {
  const btn = document.getElementById(`rec-btn-${idx}`);
  if (!btn) return;
  btn.textContent = label;
  btn.title = title;
  btn.disabled = disabled;
}

export function updateReplayButton(idx, hasRecording) {
  const btn = document.getElementById(`replay-btn-${idx}`);
  if (!btn) return;
  btn.disabled = !hasRecording;
}

// ─── Waveform ─────────────────────────────────────────────────────────────────

export function showWaveform(idx) {
  const wave = document.getElementById(`wave-${idx}`);
  if (wave) wave.classList.add('visible');
}

export function hideWaveform(idx) {
  const wave = document.getElementById(`wave-${idx}`);
  if (wave) wave.classList.remove('visible');
}

export function getWaveformBars(idx) {
  const wave = document.getElementById(`wave-${idx}`);
  return wave ? wave.querySelectorAll('.waveform-bar') : [];
}

// ─── Card state ───────────────────────────────────────────────────────────────

export function setCardActive(idx) {
  document.getElementById(`card-${idx}`)?.classList.add('active');
}

export function setCardDone(idx) {
  const card = document.getElementById(`card-${idx}`);
  card?.classList.remove('active');
  card?.classList.add('done');
}

export function setCardIdle(idx) {
  document.getElementById(`card-${idx}`)?.classList.remove('active');
}

// ─── Progress / stats ─────────────────────────────────────────────────────────

export function updateProgress(sentences, scores) {
  const done = scores.filter(s => s !== null).length;
  const pct = sentences.length ? (done / sentences.length * 100) : 0;
  const fill = document.getElementById('progress-fill');
  if (fill) fill.style.width = pct + '%';
}

export function updateAvgScore(scores) {
  const done = scores.filter(s => s !== null);
  const avgPill = document.getElementById('avg-score-pill');
  const overallBadge = document.getElementById('overall-score-badge');
  const statAvg = document.getElementById('stat-avg');
  const overallScore = document.getElementById('overall-score');

  if (!done.length) {
    if (avgPill) avgPill.style.display = 'none';
    if (overallBadge) overallBadge.style.display = 'none';
    if (statAvg) statAvg.textContent = '—';
    if (overallScore) overallScore.textContent = '—';
    return;
  }

  const avg = Math.round(done.reduce((a, b) => a + b, 0) / done.length);
  if (avgPill) avgPill.style.display = 'flex';
  if (statAvg) statAvg.textContent = avg + '%';
  if (overallBadge) overallBadge.style.display = 'flex';
  if (overallScore) overallScore.textContent = avg + '%';
}

export function updateStatTotal(n) {
  const el = document.getElementById('stat-total');
  if (el) el.textContent = n;
}

export function updateStatDone(n) {
  const el = document.getElementById('stat-done');
  if (el) el.textContent = n;
}

// ─── Global toolbar visibility ────────────────────────────────────────────────

export function showLegend() {
  const el = document.getElementById('legend');
  if (el) el.style.display = 'flex';
}

export function showReadAllButton() {
  const el = document.getElementById('btn-read-all');
  if (el) el.style.display = 'inline-block';
}

export function setPlayButtonState(idx, playing) {
  const btn = document.getElementById(`play-btn-${idx}`);
  if (!btn) return;
  btn.classList.toggle('playing', playing);
}

// ─── Word modal ───────────────────────────────────────────────────────────────

export function openWordModal(word) {
  document.getElementById('modal-word-text').textContent = word;
  document.getElementById('modal-phonetic-text').textContent = '...';
  document.getElementById('modal-def-text').textContent = 'Looking up...';
  document.getElementById('modal-example-text').textContent = '...';
  document.getElementById('word-modal').classList.add('open');
}

export function populateWordModal(info) {
  document.getElementById('modal-phonetic-text').textContent = info.phonetic;
  document.getElementById('modal-def-text').textContent = info.def;
  document.getElementById('modal-example-text').textContent = info.ex;
}

export function closeWordModal() {
  document.getElementById('word-modal').classList.remove('open');
}

// ─── Countdown status ─────────────────────────────────────────────────────────

export function setCountdownStatus(idx, remaining) {
  setRecordStatusHtml(
    idx,
    `Azure 已准备好，${remaining} 秒后开始朗读。<span class="live-transcript">请先吸气准备，不要马上开口。</span>`
  );
}
