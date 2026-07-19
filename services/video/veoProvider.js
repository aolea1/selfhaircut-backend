// Haircut State Lab — Veo adapter (future phase, NOT YET IMPLEMENTED).
//
// Placeholder for the Google Gemini API call. Left unimplemented
// intentionally until FEATURE_HAIRCUT_STATE_VIDEO is turned on deliberately
// and a GEMINI_API_KEY is provisioned.
//
// Known (researched, not guessed) facts as of this writing:
//   - Access is via the Gemini API (not a full Vertex AI project setup) —
//     a Gemini API key is sufficient, lower friction than expected.
//   - Model IDs: "veo-3.1-generate-preview" (standard), "veo-3.1-lite-generate-preview" (lite).
//   - generate_videos() accepts both first_frame and last_frame image params
//     — this is the state-transition use case (approved State N -> State N+1).
//   - Pricing: Lite $0.05/sec (720p) / $0.08/sec (1080p), no 4K, no Extension.
//     Standard $0.40/sec (720p/1080p), $0.60/sec (4K).
// Re-verify against live docs before wiring this up — confirm current
// pricing/model availability against the connected Google account first.

async function callVeoGenerateVideo(/* { apiKey, model, firstFrame, lastFrame, prompt } */) {
  throw new Error('NOT_IMPLEMENTED: Veo integration has not been built yet');
}

module.exports = { callVeoGenerateVideo };
