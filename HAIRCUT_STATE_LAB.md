# Haircut State Lab — phase 1 testing guide

Private, owner-only dev tool. Not linked from the production app. Phase 1
covers anatomy detection → deterministic planning → mask rasterization —
no image or video generation yet (see `services/haircutState` and
`services/video`, both intentionally un-called stubs).

## Required environment variables

```
FEATURE_HAIRCUT_STATE_LAB=true
FIREBASE_STORAGE_BUCKET=selfhaircutai.firebasestorage.app   # optional — this is the default if unset
ANTHROPIC_API_KEY=...                                       # already required for existing endpoints
FIREBASE_SERVICE_ACCOUNT=...                                # already required for existing endpoints; must have Storage write access
```

Nothing else is required. `GEMINI_API_KEY` and any FLUX/BFL key are **not**
needed — the app starts and the Lab fully functions without them
(`FEATURE_HAIRCUT_STATE_VIDEO` defaults to `false` and nothing calls the
video or image-generation adapters in this phase).

Without `FEATURE_HAIRCUT_STATE_LAB=true`, every `/lab/*` route returns a
uniform `404 {"error":"not_found"}` regardless of authentication state —
that's how the feature is disabled.

## The Lab page URL

`haircut-state-lab.html` in the frontend repo (this file lives in the
backend repo — the page is served from wherever the frontend is hosted,
e.g. `https://selfhaircut.ai/haircut-state-lab.html` or a GitHub Pages
preview). It defaults to talking to the **production** backend
(`https://selfhaircut-backend.onrender.com`) and will show a red warning
banner if so — for phase-1 testing, open it with:

```
haircut-state-lab.html?backend=https://<your-render-preview-url>
```

The override persists in `localStorage` after the first load, so you only
need the query param once per browser.

## Required owner account

Sign in with the account whose email matches `OWNER_EMAIL` on the target
backend (same owner system the Founder Dashboard uses). Any other account,
or no account, gets redirected with "Access denied."

## Testing steps

1. **Upload a test photo** — click the upload zone, pick a side-profile JPEG/PNG/HEIC.
2. **Run anatomy analysis** — click "Analyze Anatomy." This normalizes the photo, uploads the original to Storage, and calls Claude for anatomy-only landmarks. The "Anatomy detected" status pill goes green on success, red on failure (with the reason shown in the raw JSON panel).
3. **Run the planner** — once anatomy succeeds, click "Calculate Haircut Plan." This runs `angel_low_taper_v1` (pure code, no AI call) and rasterizes the active-zone mask. "Haircut plan calculated" and "Mask created" go green together (they share one request in this phase).
4. **Inspect each overlay** — the toggle panel has one checkbox per layer: original image, ear bounding box, ear midpoint, sideburn boundary, temple hair boundary, head contour, planned bald line, active-zone mask. Toggle any combination on the same canvas to isolate what you're checking. Anatomy confidence (5 sub-scores) and planner confidence are shown as separate, distinctly-labeled bars — never combined into one number.
5. **"Image generation not configured"** stays permanently greyed this phase — that's expected, not a bug.

## Where data is saved

- **Firestore**: `haircut_state_lab_tests/{testId}` — anatomy JSON, plan JSON, method version, provider/model metadata, status/failure fields, Storage *paths* (never URLs or image bytes).
- **Storage**: `haircut-state-lab/{ownerUid}/{testId}/original.jpg` and `.../active-zone-mask.png`. Access is owner-scoped at the API layer (signed URLs are minted fresh per request, 1-hour expiry, never persisted) — there is no public/anonymous read path to these files.

## How to disable afterward

Unset `FEATURE_HAIRCUT_STATE_LAB` (or set it to anything other than
`true`) on the target environment. All three `/lab/*` routes immediately
start returning 404 again; nothing else in the app is affected.
