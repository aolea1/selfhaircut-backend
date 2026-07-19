// Haircut State Lab — image-generation provider boundary (phase 2, INERT).
//
// This file exists so the provider interface and capability contract are
// locked in now, before any real generation happens. Nothing in this file is
// called by any route yet — Steps 1-4 stop at the mask. No BFL key is
// required for the application to start or for the Lab to function.
//
// providerCapabilities.supportsExplicitMask for "flux2-edit" is deliberately
// false: BFL's public FLUX.2 Edit docs did not show a mask parameter in the
// basic request example (only input_image + prompt + reference images —
// "directive" editing). That is unconfirmed either way pending a live spike
// call once a BFL API key exists (see fluxProvider.js). Do not flip it to
// true without confirming against an actual API response.
const providerCapabilities = {
  'flux2-edit': {
    supportsSourceImage: true,
    supportsReferenceImages: true,
    supportsExplicitMask: false,
    supportsDirectiveEditing: true,
  },
  'flux-fill': {
    supportsSourceImage: true,
    supportsReferenceImages: false,
    supportsExplicitMask: true,
    supportsDirectiveEditing: false,
  },
};

const HAIRCUT_STATE_PROVIDER = process.env.HAIRCUT_STATE_PROVIDER || 'flux2-edit';
const HAIRCUT_STATE_MODEL    = process.env.HAIRCUT_STATE_MODEL    || null;

// generateHaircutState({ sourceImage, currentState, targetState, haircutType,
//   haircutMethodVersion, visibleSide, anatomy, taperGeometry, activeZoneMask,
//   preservationInstructions, provider })
//
// Returns the normalized result shape from day one so nothing downstream
// needs to change when this stops throwing:
// { success, sourceImageUrl, generatedImageUrl, currentState, targetState,
//   provider, model, durationMs, estimatedCost, promptVersion, requestId,
//   failureReason }
async function generateHaircutState(input) {
  const provider = input?.provider || HAIRCUT_STATE_PROVIDER;
  if (!providerCapabilities[provider]) {
    return {
      success: false, sourceImageUrl: null, generatedImageUrl: null,
      currentState: input?.currentState ?? null, targetState: input?.targetState ?? null,
      provider, model: null, durationMs: 0, estimatedCost: 0,
      promptVersion: null, requestId: null,
      failureReason: `UNKNOWN_PROVIDER: "${provider}"`,
    };
  }
  // Deliberately not implemented in Steps 1-4 — the Lab stops at the mask
  // until the FLUX spike (Test A / Test B) has been run and reviewed.
  throw new Error('NOT_IMPLEMENTED: haircut-state generation is deferred to phase 2, pending the FLUX2/Fill mask spike');
}

module.exports = { generateHaircutState, providerCapabilities, HAIRCUT_STATE_PROVIDER, HAIRCUT_STATE_MODEL };
