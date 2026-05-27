/**
 * scoring.js
 * Pure algorithmic functions for pronunciation assessment.
 * No DOM access, no network calls — fully unit-testable.
 */

// ─── Math helpers ────────────────────────────────────────────────────────────

export function average(values) {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

export function weightedAverage(values, weights) {
  const totalWeight = weights.reduce((sum, v) => sum + v, 0);
  if (!values.length || !totalWeight) return values.length ? average(values) : 0;
  return values.reduce((sum, v, i) => sum + v * (weights[i] || 0), 0) / totalWeight;
}

export function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// ─── String / word helpers ───────────────────────────────────────────────────

export function normalizeWord(word) {
  const n = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (n === 'ai' || n === 'artificialintelligence') return 'ai';
  return n;
}

export function expandComparableWord(word) {
  const n = normalizeWord(word);
  if (n === 'ai') return ['ai', 'a', 'i'];
  return [n];
}

export function levenshtein(a, b) {
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

export function wordSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

// ─── LCS alignment ───────────────────────────────────────────────────────────

export function buildLcsMatrix(a, b) {
  const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      matrix[i][j] = a[i] === b[j]
        ? matrix[i + 1][j + 1] + 1
        : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    }
  }
  return matrix;
}

/**
 * Aligns Azure SDK-recognized words to reference words using LCS.
 * Returns an array of word objects annotated with errorType.
 */
export function alignContinuousWords(referenceWords, recognizedWords) {
  const normalizedRecognized = recognizedWords.map(w => ({
    word: w.Word,
    key: normalizeWord(w.Word),
    accuracyScore: w.PronunciationAssessment?.AccuracyScore || 0,
    errorType: w.PronunciationAssessment?.ErrorType || 'None',
  }));

  const referenceKeys = referenceWords.map(normalizeWord);
  const recognizedKeys = normalizedRecognized.map(w => w.key);
  const matrix = buildLcsMatrix(referenceKeys, recognizedKeys);

  const finalWords = [];
  let i = 0;
  let j = 0;

  while (i < referenceKeys.length && j < recognizedKeys.length) {
    if (referenceKeys[i] === recognizedKeys[j]) {
      finalWords.push({ ...normalizedRecognized[j], word: referenceWords[i] });
      i++;
      j++;
    } else if (matrix[i + 1][j] >= matrix[i][j + 1]) {
      finalWords.push({ word: referenceWords[i], accuracyScore: 0, errorType: 'Omission' });
      i++;
    } else {
      finalWords.push({
        ...normalizedRecognized[j],
        errorType: normalizedRecognized[j].errorType === 'None' ? 'Insertion' : normalizedRecognized[j].errorType,
      });
      j++;
    }
  }
  while (i < referenceKeys.length) {
    finalWords.push({ word: referenceWords[i], accuracyScore: 0, errorType: 'Omission' });
    i++;
  }
  while (j < recognizedKeys.length) {
    finalWords.push({
      ...normalizedRecognized[j],
      errorType: normalizedRecognized[j].errorType === 'None' ? 'Insertion' : normalizedRecognized[j].errorType,
    });
    j++;
  }
  return finalWords;
}

/**
 * Aligns Azure REST API words to reference words using a sliding window + similarity.
 */
export function alignAzureWordsToReference(refWords, azureWords) {
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

// ─── Score builders ──────────────────────────────────────────────────────────

/**
 * Converts a word alignment result entry into a CSS class name.
 */
export function wordEntryToScoreClass(word) {
  if (word.errorType === 'Omission') return 'missed';
  if (word.errorType === 'Insertion') return 'wrong';
  if (word.accuracyScore >= 80) return 'correct';
  if (word.accuracyScore >= 55) return 'close';
  if (word.accuracyScore > 0) return 'wrong';
  return 'missed';
}

/**
 * Builds a full assessment result from a completed Azure SDK continuous session.
 */
export function buildContinuousAssessment(referenceText, state) {
  const referenceWords = referenceText
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.replace(/^[^\w]+|[^\w]+$/g, ''))
    .filter(Boolean);

  const finalWords = alignContinuousWords(referenceWords, state.recognizedWords);
  const scoredWords = finalWords.filter(w => w.errorType !== 'Insertion');

  const accuracy = scoredWords.length
    ? average(scoredWords.map(w => w.accuracyScore || 0))
    : 0;

  const fluency = weightedAverage(state.fluencyScores, state.durations);
  const prosody = state.prosodyScores.length ? average(state.prosodyScores) : 0;

  const recognizedNormalWords = state.recognizedWords.filter(
    w => (w.PronunciationAssessment?.ErrorType || 'None') === 'None'
  );
  const completeness = Math.min(
    100,
    (recognizedNormalWords.length / Math.max(referenceWords.length, 1)) * 100
  );

  const overall = clampScore(
    accuracy * 0.4 + prosody * 0.2 + fluency * 0.2 + completeness * 0.2
  );

  const displayWords = finalWords.filter(w => w.errorType !== 'Insertion').map(w => w.word);
  const wordScores = finalWords
    .filter(w => w.errorType !== 'Insertion')
    .map(wordEntryToScoreClass);

  return {
    words: displayWords.length ? displayWords : referenceWords,
    wordScores: wordScores.length ? wordScores : referenceWords.map(() => 'missed'),
    overall,
    accuracy: Math.round(accuracy),
    completeness: Math.round(completeness),
    fluency: Math.round(fluency),
    prosody: Math.round(prosody),
    recognizedText: state.recognizedText.join(' ') || '—',
    insertions: finalWords.filter(w => w.errorType === 'Insertion').map(w => w.word),
  };
}

/**
 * Text-similarity fallback when Azure returns no per-word scores.
 */
export function fallbackScoreFromRecognizedText(refWords, recognizedText) {
  const spokenWords = recognizedText
    .replace(/[.!?,;:]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map(normalizeWord);

  const scored = refWords.map(refWord => {
    const ref = normalizeWord(refWord);
    const best = spokenWords.reduce((max, spoken) => Math.max(max, wordSimilarity(ref, spoken)), 0);
    if (best >= 0.9) return { cls: 'correct', score: best };
    if (best >= 0.7) return { cls: 'close', score: best };
    if (best >= 0.5) return { cls: 'wrong', score: best };
    return { cls: 'missed', score: 0 };
  });

  return {
    words: refWords,
    wordScores: scored.map(s => s.cls),
    overall: Math.round(
      scored.reduce((sum, s) => sum + s.score, 0) / Math.max(scored.length, 1) * 100
    ),
  };
}
