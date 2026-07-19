// Haircut State Lab — deterministic haircut planning layer.
//
// This is pure code, not an AI call. It receives observed anatomy from
// services/anatomy and applies Angelo's barber methodology to it. Adding a
// new haircut style/method later means adding a new file here (e.g.
// midTaperV1.js) — it never requires touching anatomy detection.
//
// Method definition (metadata describing the rule set, not the math itself):
const angelLowTaperV1 = {
  haircutType: 'low_taper',
  methodVersion: 'angel_low_taper_v1',
  baldLine: {
    verticalReference: 'visible_ear_midpoint',
    frontAnchor: 'sideburn_temple_region',
    pathStyle: 'subtle_natural_curve',
    removeHairBelowPath: true,
  },
};

const HAIRCUT_METHODS = { angel_low_taper_v1: angelLowTaperV1 };

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// Finds the x at a given y by linearly interpolating along an ordered
// polyline. Returns null if the polyline doesn't have two points bracketing
// targetY (e.g. too few points, or the boundary doesn't reach that height).
function interpolateXAtY(points, targetY) {
  if (!Array.isArray(points) || points.length < 2) return null;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i], p1 = points[i + 1];
    if (typeof p0?.y !== 'number' || typeof p1?.y !== 'number') continue;
    const lo = Math.min(p0.y, p1.y), hi = Math.max(p0.y, p1.y);
    if (targetY >= lo && targetY <= hi && p0.y !== p1.y) {
      const t = (targetY - p0.y) / (p1.y - p0.y);
      return { x: p0.x + t * (p1.x - p0.x), y: targetY };
    }
  }
  return null;
}

function failure(methodVersion, reason, warnings = []) {
  return {
    methodVersion,
    baldLine: null,
    activeZonePolygon: [],
    plannerConfidence: 0,
    appliedRules: [],
    warnings,
    failureReason: reason,
  };
}

// calculateLowTaperPlan({ anatomy, methodVersion, imageDimensions })
//
// `anatomy` is the FULL anatomy-stage response (services/anatomy's
// analyzeHeadPhoto().anatomy field) — i.e. { success, visibleSide,
// imageValidation, anatomy: {ear, sideburn, ...}, confidence, warnings,
// failureReason }, not just the inner landmarks object. `imageDimensions`
// ({width, height} in px of the normalized image) is accepted for future
// aspect-ratio-aware refinements; v1 keeps all math in fraction space so it
// is resolution-independent, which is why it isn't used below yet.
function calculateLowTaperPlan({ anatomy, methodVersion = 'angel_low_taper_v1', imageDimensions }) {
  if (!HAIRCUT_METHODS[methodVersion]) {
    return failure(methodVersion, 'unsupported_method_version');
  }
  if (!anatomy || anatomy.success !== true || !anatomy.anatomy) {
    return failure(methodVersion, 'anatomy_unusable');
  }
  if (anatomy.visibleSide !== 'left' && anatomy.visibleSide !== 'right') {
    return failure(methodVersion, 'side_unknown');
  }

  const landmarks = anatomy.anatomy;
  const conf       = anatomy.confidence || {};
  const ear        = landmarks.ear;
  const sideburn    = landmarks.sideburn;
  const headContour = landmarks.headContour || [];
  const isRightSide = anatomy.visibleSide === 'right'; // rear-of-ear extends further right

  if (!ear || !ear.midpoint || typeof ear.midpoint.y !== 'number') {
    return failure(methodVersion, 'ear_midpoint_unavailable');
  }
  if (!ear.boundingBox || typeof ear.boundingBox.width !== 'number' || typeof ear.boundingBox.height !== 'number') {
    return failure(methodVersion, 'ear_bounding_box_unavailable');
  }
  if (!sideburn || !sideburn.bottom) {
    return failure(methodVersion, 'sideburn_data_insufficient');
  }

  const warnings = [];
  const appliedRules = [];

  // ── Rule 1: bald-line reference height = visible ear vertical midpoint ──────
  const referenceHeight = ear.midpoint.y;
  appliedRules.push({ rule: 'bald_line_height', input: 'ear.midpoint.y', result: referenceHeight });

  // ── Rule 2: start anchor — sideburn/temple region, at reference height ──────
  let start = interpolateXAtY(sideburn.boundary, referenceHeight);
  if (start) {
    appliedRules.push({ rule: 'bald_line_start', input: 'sideburn.boundary interpolated @ ear.midpoint.y', result: start });
  } else {
    start = { x: sideburn.bottom.x, y: referenceHeight };
    warnings.push('sideburn.boundary did not bracket ear-midpoint height — used sideburn.bottom.x as the start anchor');
    appliedRules.push({ rule: 'bald_line_start', input: 'sideburn.bottom.x (fallback, boundary did not bracket reference height)', result: start });
  }

  // ── Rule 3: end anchor — just past the ear canal, at reference height ───────
  const earLeftEdge  = ear.boundingBox.x;
  const earRightEdge = ear.boundingBox.x + ear.boundingBox.width;
  const rearExtension = ear.boundingBox.width * 0.18; // modest extension past the canal, scaled to this person's ear size
  let end = isRightSide
    ? { x: earRightEdge + rearExtension, y: referenceHeight }
    : { x: earLeftEdge  - rearExtension, y: referenceHeight };
  appliedRules.push({
    rule: 'bald_line_end',
    input: `ear.boundingBox ${isRightSide ? 'right' : 'left'} edge + 18% ear-width extension`,
    result: end,
  });

  // Clamp the end point against the head contour if available, so the line
  // never proposes extending past the person's actual visible head outline.
  const contourPoint = interpolateXAtY(headContour, referenceHeight);
  if (contourPoint) {
    const clamped = isRightSide
      ? { x: Math.min(end.x, Math.max(contourPoint.x, earRightEdge)), y: referenceHeight }
      : { x: Math.max(end.x, Math.min(contourPoint.x, earLeftEdge)),  y: referenceHeight };
    if (clamped.x !== end.x) {
      end = clamped;
      appliedRules.push({ rule: 'bald_line_end_contour_clamp', input: 'headContour interpolated @ ear.midpoint.y', result: end });
    }
  } else {
    warnings.push('headContour did not bracket ear-midpoint height — end anchor uses ear bounding box only, unclamped by contour');
  }

  // ── Rule 4: subtle natural curve — one control point, following the ear ─────
  const bulgeY = clamp01(referenceHeight + ear.boundingBox.height * 0.06);
  const controlPoints = [{ x: (start.x + end.x) / 2, y: bulgeY }];
  appliedRules.push({ rule: 'bald_line_curve', input: 'ear.boundingBox.height * 0.06 downward bulge at path midpoint', result: controlPoints[0] });

  // ── Active-zone polygon: the region below the path that gets removed ────────
  const zoneTopMargin = ear.boundingBox.height * 0.15;
  const zoneDepth      = ear.boundingBox.height * 0.90;
  const activeZonePolygon = [
    { x: start.x,               y: clamp01(start.y - zoneTopMargin) },
    { x: controlPoints[0].x,    y: clamp01(controlPoints[0].y - zoneTopMargin * 0.5) },
    { x: end.x,                 y: clamp01(end.y - zoneTopMargin) },
    { x: end.x,                 y: clamp01(end.y + zoneDepth) },
    { x: start.x,               y: clamp01(start.y + zoneDepth) },
  ];
  appliedRules.push({
    rule: 'active_zone_extent',
    input: 'ear.boundingBox.height scaled top margin (15%) and depth (90%)',
    result: { zoneTopMargin, zoneDepth },
  });

  // Planner confidence reflects only the anatomy this planner actually
  // consumes (ear + sideburn) — deliberately not the same number as the
  // anatomy stage's overall confidence, and reduced further if any fallback
  // or clamp had to kick in above.
  let plannerConfidence = clamp01(Math.min(
    typeof conf.ear === 'number' ? conf.ear : 0,
    typeof conf.sideburn === 'number' ? conf.sideburn : 0,
  ));
  if (warnings.length) plannerConfidence = clamp01(plannerConfidence - 0.10 * warnings.length);

  return {
    methodVersion,
    baldLine: { referenceHeight, start, controlPoints, end },
    activeZonePolygon,
    plannerConfidence,
    appliedRules,
    warnings,
    failureReason: null,
  };
}

module.exports = { calculateLowTaperPlan, angelLowTaperV1, HAIRCUT_METHODS };
