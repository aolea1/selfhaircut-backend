// Haircut State Lab — FLUX adapter (phase 2, NOT YET IMPLEMENTED).
//
// Placeholder for the Black Forest Labs call. Left unimplemented
// intentionally — do not fill this in until:
//   1. A BFL_API_KEY is available, and
//   2. Test A (flux2-edit, directive prompt, no assumed mask field) and
//      Test B (flux-fill, explicit raster mask) have both been spike-tested
//      against api.bfl.ai and their real request/response shapes confirmed.
//
// Known (researched, not guessed) endpoint facts as of this writing:
//   - Base: https://api.bfl.ai/v1
//   - flux2-edit: POST /v1/flux-2-pro (or -preview) — body { prompt,
//     input_image, input_image_2..N }, async (returns id + polling_url).
//     Mask parameter NOT confirmed — see services/haircutState/index.js.
//   - flux-fill: POST /v1/flux-pro-1.0-fill — body { prompt, image (base64),
//     mask (base64, white=edit/black=preserve), steps, guidance,
//     output_format, safety_tolerance }, same async polling pattern.
// Re-verify both against live docs/API responses before wiring this up —
// BFL's API surface may have moved on by the time phase 2 starts.

async function callFlux2Edit(/* { apiKey, sourceImageBuffer, prompt, referenceImages } */) {
  throw new Error('NOT_IMPLEMENTED: flux2-edit spike (Test A) has not been run yet');
}

async function callFluxFill(/* { apiKey, sourceImageBuffer, maskBuffer, prompt } */) {
  throw new Error('NOT_IMPLEMENTED: flux-fill spike (Test B) has not been run yet');
}

module.exports = { callFlux2Edit, callFluxFill };
