// Haircut State Lab — video-generation provider boundary (future phase, INERT).
//
// Not required, not imported by any route, and not on the startup path in
// Steps 1-4. FEATURE_HAIRCUT_STATE_VIDEO defaults to false; GEMINI_API_KEY is
// only read inside generateHaircutTransitionVideo(), and only reached if the
// flag is true AND this function is actually called — neither happens yet.
// This means an absent Gemini key can never block anatomy analysis,
// planning, masking, or (later) FLUX image work.
const STEP_VIDEO_PROVIDER = process.env.STEP_VIDEO_PROVIDER || 'veo';
const STEP_VIDEO_MODEL    = process.env.STEP_VIDEO_MODEL    || 'veo-3.1-lite-generate-preview';

function videoFeatureEnabled() {
  return process.env.FEATURE_HAIRCUT_STATE_VIDEO === 'true';
}

// generateHaircutTransitionVideo({ sourceStateImage, targetStateImage,
//   stepDefinition, haircutGeometry, visibleSide, provider })
//
// Normalized result from day one: { success, sourceState, targetState,
//   videoUrl, provider, model, durationSeconds, generationTimeMs,
//   estimatedCost, failureReason }
async function generateHaircutTransitionVideo(input) {
  if (!videoFeatureEnabled()) {
    return {
      success: false,
      sourceState: input?.stepDefinition?.sourceState ?? null,
      targetState: input?.stepDefinition?.targetState ?? null,
      videoUrl: null,
      provider: input?.provider || STEP_VIDEO_PROVIDER,
      model: STEP_VIDEO_MODEL,
      durationSeconds: 0,
      generationTimeMs: 0,
      estimatedCost: 0,
      failureReason: 'video_generation_disabled',
    };
  }
  // Only reachable once FEATURE_HAIRCUT_STATE_VIDEO=true — not exercised in
  // Steps 1-4. GEMINI_API_KEY is intentionally checked here, not at module
  // load, so its absence never affects anything else in the Lab.
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is required to generate a transition video');
  }
  throw new Error('NOT_IMPLEMENTED: Veo transition video generation is not built yet');
}

module.exports = { generateHaircutTransitionVideo, videoFeatureEnabled, STEP_VIDEO_PROVIDER, STEP_VIDEO_MODEL };
