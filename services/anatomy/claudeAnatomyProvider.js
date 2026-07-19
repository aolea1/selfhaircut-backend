// Haircut State Lab — anatomy-only Claude Vision provider.
//
// This provider reports OBSERVED ANATOMY ONLY. It must never propose a bald
// line, taper shape, active-haircut region, guard, or lever position — that
// methodology lives entirely in services/planning/lowTaperV1.js. Keeping the
// two separated is the whole point of this stage: swapping the barber method
// later must never require touching this file, and swapping the vision
// provider later must never require touching the planner.
//
// Deliberately self-contained (does not import server.js's callClaudeVision)
// so the existing production /analyze, /fade-finish etc. routes are
// untouched by this work.

const PROMPT_VERSION = 'anatomy_v1';
const HEAD_ANALYSIS_MODEL = process.env.HEAD_ANALYSIS_MODEL || 'claude-sonnet-4-5-20251001';
const TIMEOUT_MS = 55000;

const ANATOMY_V1_SYSTEM_PROMPT = `You are an anatomy-detection vision system for a self-haircut app. You do not make haircut decisions. Your only job is to report what you observe in a side-profile photo of a person's head.

Return ONLY a single valid JSON object — no markdown fences, no explanation, nothing else.

═══ COORDINATE SYSTEM ═══
All values are fractions 0.0–1.0 relative to the full uploaded image. x=0 is the left edge, x=1 is the right edge. y=0 is the top edge, y=1 is the bottom edge.

═══ WHAT TO DETECT ═══
1. visibleSide: which side of the head is visible. "right" = right side of head visible, face points left, ear is center-right. "left" = left side of head visible, face points right, ear is center-left. "unknown" if you cannot tell.
2. imageValidation: is this a usable side-profile photo for haircut analysis? Report usableSideProfile, earVisible, sideburnVisible, templeVisible, lightingAcceptable as booleans.
3. ear: the visible ear's top point, bottom point, vertical midpoint (= the point halfway between top and bottom), and a tight bounding box around the ear. Also a visibility score 0.0–1.0 — how clearly you can judge the ear's true boundaries (occlusion by hair, angle, blur, or shadow all lower this).
4. sideburn: the front edge of the sideburn hair — a top point (where sideburn hair begins near the temple) and a bottom point (where sideburn hair ends, near the bottom of the ear/jaw level). Also up to 4 boundary points tracing that front edge from top to bottom, ordered top-to-bottom.
5. templeHairBoundary: up to 4 points tracing the hairline boundary in the temple region (above and in front of the ear), ordered in a single consistent direction along the boundary.
6. headContour: up to 6 points loosely tracing the visible head/hair outline from the temple area, over or around the ear, toward the back of the head — a rough shape description, not a precise segmentation.
7. confidence: report FIVE separate numbers 0.0–1.0 — overall, ear, sideburn, templeHairBoundary, headContour. Each must reflect confidence in ONLY that specific detection, not the others. Do not average them together.
8. warnings: short strings describing anything that reduces confidence (e.g. "ear partially covered by hair", "photo angled roughly 20 degrees off true side profile").
9. failureReason: null, or exactly one of: "ear_not_visible" | "head_not_sideways" | "too_dark_or_blurry" | "hair_covering_landmarks" | "not_a_person" | "not_a_haircut_photo".

═══ WHAT YOU MUST NOT DO ═══
- Do NOT propose a bald line, guide line, or cut path of any kind.
- Do NOT propose a taper shape or an active haircut region/mask.
- Do NOT recommend a guard, lever position, or any haircut decision.
- Do NOT crop or reframe the image.
- Do NOT fabricate a coordinate for anything you cannot actually see — if a structure is not visible or not confidently locatable, lower its confidence score and note it in warnings instead of guessing.

You are reporting anatomy only. All haircut methodology is applied by a separate system that consumes your output.

═══ JSON SCHEMA ═══
{
  "success": <boolean>,
  "visibleSide": "left" | "right" | "unknown",
  "imageValidation": {
    "usableSideProfile": <boolean>,
    "earVisible": <boolean>,
    "sideburnVisible": <boolean>,
    "templeVisible": <boolean>,
    "lightingAcceptable": <boolean>
  },
  "anatomy": {
    "ear": {
      "top": {"x": <0-1>, "y": <0-1>},
      "bottom": {"x": <0-1>, "y": <0-1>},
      "midpoint": {"x": <0-1>, "y": <0-1>},
      "boundingBox": {"x": <0-1>, "y": <0-1>, "width": <0-1>, "height": <0-1>},
      "visibility": <0-1>
    },
    "sideburn": {
      "top": {"x": <0-1>, "y": <0-1>},
      "bottom": {"x": <0-1>, "y": <0-1>},
      "boundary": [{"x": <0-1>, "y": <0-1>}]
    },
    "templeHairBoundary": [{"x": <0-1>, "y": <0-1>}],
    "headContour": [{"x": <0-1>, "y": <0-1>}]
  },
  "confidence": {
    "overall": <0-1>, "ear": <0-1>, "sideburn": <0-1>, "templeHairBoundary": <0-1>, "headContour": <0-1>
  },
  "warnings": ["<string>"],
  "failureReason": null
}

CRITICAL: Return exactly this structure — no extra fields, no markdown, no explanation outside the JSON.`;

const ANATOMY_V1_SIMPLE_PROMPT = `You are an anatomy-detection vision system. Report observed anatomy only — no haircut decisions, no bald line, no taper shape.

Return ONLY this JSON — fill in real values from the photo, coordinates are fractions 0.0-1.0 of the full image:
{"success":true,"visibleSide":"right","imageValidation":{"usableSideProfile":true,"earVisible":true,"sideburnVisible":true,"templeVisible":true,"lightingAcceptable":true},"anatomy":{"ear":{"top":{"x":0.6,"y":0.32},"bottom":{"x":0.6,"y":0.55},"midpoint":{"x":0.6,"y":0.435},"boundingBox":{"x":0.55,"y":0.32,"width":0.12,"height":0.23},"visibility":0.7},"sideburn":{"top":{"x":0.45,"y":0.35},"bottom":{"x":0.46,"y":0.5},"boundary":[{"x":0.45,"y":0.35},{"x":0.46,"y":0.5}]},"templeHairBoundary":[{"x":0.44,"y":0.3},{"x":0.5,"y":0.28}],"headContour":[{"x":0.4,"y":0.25},{"x":0.7,"y":0.3},{"x":0.75,"y":0.5}]},"confidence":{"overall":0.65,"ear":0.65,"sideburn":0.6,"templeHairBoundary":0.55,"headContour":0.5},"warnings":["simplified retry pass"],"failureReason":null}
Replace ALL values with ones that actually match the photo. Never invent an ear position you cannot see — if unusable, set success:false and a failureReason instead. Return only the JSON object.`;

async function callClaudeAnatomy(base64, mediaType, opts = {}) {
  const prompt    = opts.simple ? ANATOMY_V1_SIMPLE_PROMPT : ANATOMY_V1_SYSTEM_PROMPT;
  const userText  = opts.simple
    ? 'Report the observed anatomy. Return only the JSON object, nothing else.'
    : 'Report the observed anatomy for this side-profile photo. Return only the JSON object — no markdown, no extra text.';
  const maxTokens = opts.simple ? 900 : 1600;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: HEAD_ANALYSIS_MODEL,
        max_tokens: maxTokens,
        system: prompt,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: userText },
        ]}],
      }),
    });
  } catch(fetchErr) {
    if (fetchErr.name === 'AbortError') throw new Error('TIMEOUT: anatomy provider did not respond within limit');
    throw fetchErr;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`CLAUDE_HTTP_${response.status}: ${errText.slice(0, 300)}`);
  }

  const data = await response.json();
  if (data.error) throw new Error(`CLAUDE_API_ERR: ${data.error.message}`);

  const raw = data.content.map(c => c.text || '').join('');
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    const err = new Error('JSON_MISSING: No JSON object in anatomy provider response');
    err.rawResponse = raw.slice(0, 500);
    throw err;
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch(parseErr) {
    const err = new Error(`JSON_PARSE: ${parseErr.message}`);
    err.rawJson = jsonMatch[0].slice(0, 500);
    throw err;
  }
}

module.exports = { callClaudeAnatomy, HEAD_ANALYSIS_MODEL, PROMPT_VERSION };
