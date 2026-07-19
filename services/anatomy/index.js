// Haircut State Lab — anatomy analysis orchestration.
// Provider-agnostic entry point: analyzeHeadPhoto() dispatches to whichever
// HEAD_ANALYSIS_PROVIDER is configured. Only 'claude' exists today; adding a
// second provider means adding a case here, not touching callers.

const { callClaudeAnatomy, HEAD_ANALYSIS_MODEL, PROMPT_VERSION } = require('./claudeAnatomyProvider');

const FAILURE_REASONS = new Set([
  'ear_not_visible', 'head_not_sideways', 'too_dark_or_blurry',
  'hair_covering_landmarks', 'not_a_person', 'not_a_haircut_photo',
]);

function inRange(v) { return typeof v === 'number' && isFinite(v) && v >= 0 && v <= 1; }
function isPoint(p) { return p && typeof p === 'object' && inRange(p.x) && inRange(p.y); }
function isPointArray(a, max) {
  return Array.isArray(a) && a.length <= max && a.every(isPoint);
}

// Mirrors the strictness of the existing validateAnalysisV2 pattern, scoped
// to the anatomy-only schema. Anatomy fields are only required when
// success=true and overall confidence clears a low usability floor —
// otherwise a genuinely unusable photo would fail validation on top of
// failing detection, which isn't useful signal.
function validateAnatomy(data) {
  const errors = [];
  if (!data || typeof data !== 'object') return { ok: false, errors: ['response is not an object'] };

  if (typeof data.success !== 'boolean') errors.push('success must be boolean');
  if (!['left', 'right', 'unknown'].includes(data.visibleSide)) errors.push('visibleSide must be left|right|unknown');
  if (data.failureReason !== null && !FAILURE_REASONS.has(data.failureReason)) errors.push('failureReason invalid');

  const iv = data.imageValidation;
  if (!iv || typeof iv !== 'object') {
    errors.push('imageValidation required');
  } else {
    ['usableSideProfile', 'earVisible', 'sideburnVisible', 'templeVisible', 'lightingAcceptable'].forEach(k => {
      if (typeof iv[k] !== 'boolean') errors.push(`imageValidation.${k} must be boolean`);
    });
  }

  const conf = data.confidence;
  if (!conf || typeof conf !== 'object') {
    errors.push('confidence required');
  } else {
    ['overall', 'ear', 'sideburn', 'templeHairBoundary', 'headContour'].forEach(k => {
      if (!inRange(conf[k])) errors.push(`confidence.${k} out of range`);
    });
  }

  if (!Array.isArray(data.warnings)) errors.push('warnings must be an array');

  // Anatomy detail is only required if the photo was judged usable at all.
  // A low-confidence or invalid photo may legitimately have null/partial
  // anatomy rather than fabricated coordinates.
  const usable = data.success && iv && iv.usableSideProfile && conf && conf.overall >= 0.30;
  if (!usable) return { ok: errors.length === 0, errors };

  const a = data.anatomy;
  if (!a || typeof a !== 'object') {
    errors.push('anatomy required when photo is usable');
    return { ok: false, errors };
  }

  const ear = a.ear;
  if (!ear || !isPoint(ear.top) || !isPoint(ear.bottom) || !isPoint(ear.midpoint)) {
    errors.push('anatomy.ear.top/bottom/midpoint required and must be valid points');
  } else if (ear.top.y >= ear.bottom.y) {
    errors.push('anatomy.ear.top must be above anatomy.ear.bottom (smaller y)');
  }
  if (!ear || !ear.boundingBox || !inRange(ear.boundingBox.x) || !inRange(ear.boundingBox.y) ||
      typeof ear.boundingBox.width !== 'number' || ear.boundingBox.width <= 0 ||
      typeof ear.boundingBox.height !== 'number' || ear.boundingBox.height <= 0) {
    errors.push('anatomy.ear.boundingBox invalid');
  }
  if (!ear || !inRange(ear.visibility)) errors.push('anatomy.ear.visibility out of range');

  const sb = a.sideburn;
  if (!sb || !isPoint(sb.top) || !isPoint(sb.bottom)) {
    errors.push('anatomy.sideburn.top/bottom required');
  }
  if (!sb || !isPointArray(sb.boundary || [], 4)) errors.push('anatomy.sideburn.boundary must be an array of <=4 points');

  if (!isPointArray(a.templeHairBoundary || [], 4)) errors.push('anatomy.templeHairBoundary must be an array of <=4 points');
  if (!isPointArray(a.headContour || [], 6)) errors.push('anatomy.headContour must be an array of <=6 points');

  return { ok: errors.length === 0, errors };
}

// Attempt 1: full prompt. Attempt 2 (only on failure): simplified, more
// tolerant prompt — mirrors the existing /analyze retry pattern but kept
// separate so this stage's retry policy can evolve independently.
async function analyzeHeadPhoto({ base64, mediaType, provider = 'claude' }) {
  if (provider !== 'claude') {
    throw new Error(`UNSUPPORTED_PROVIDER: HEAD_ANALYSIS_PROVIDER="${provider}" is not implemented`);
  }

  const startedAt = Date.now();
  let result = null;
  let attempt = 0;
  let lastError = null;

  for (attempt = 1; attempt <= 2; attempt++) {
    try {
      result = await callClaudeAnatomy(base64, mediaType, { simple: attempt === 2 });
      break;
    } catch(err) {
      lastError = err;
    }
  }

  const durationMs = Date.now() - startedAt;

  if (!result) {
    return {
      success: false,
      anatomy: null,
      validation: null,
      durationMs,
      attempts: attempt - 1,
      provider: 'claude',
      model: HEAD_ANALYSIS_MODEL,
      promptVersion: PROMPT_VERSION,
      error: lastError?.message || 'unknown anatomy provider error',
    };
  }

  const validation = validateAnatomy(result);
  return {
    success: true,
    anatomy: result,
    validation,
    durationMs,
    attempts: attempt,
    provider: 'claude',
    model: HEAD_ANALYSIS_MODEL,
    promptVersion: PROMPT_VERSION,
    error: null,
  };
}

module.exports = { analyzeHeadPhoto, validateAnatomy };
