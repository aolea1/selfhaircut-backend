const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const fetch   = require('node-fetch');

const app    = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());

// ── STRIPE WEBHOOK ────────────────────────────────────────────────────────────
// Must be registered BEFORE express.json() — Stripe needs the raw body for
// signature verification; express.json() would consume it first.
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig     = req.headers['stripe-signature'];
  const secret  = process.env.STRIPE_WEBHOOK_SECRET;
  const stripeKey = process.env.STRIPE_SECRET_KEY;

  if (!secret || !stripeKey) {
    console.error('[Webhook] STRIPE_WEBHOOK_SECRET or STRIPE_SECRET_KEY not set');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  let event;
  try {
    const Stripe = require('stripe');
    const stripe = Stripe(stripeKey);
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('[Webhook] Signature verification failed:', err.message);
    _health.webhookFails++;
    return res.status(400).json({ error: 'Invalid signature' });
  }

  if (event.type === 'checkout.session.completed') {
    const session     = event.data.object;
    const uid         = session.client_reference_id;
    const amountCents = session.amount_total;

    // Map purchase amount → credits (matches frontend pricing)
    const CREDIT_MAP = { 999: 5, 2499: 15, 6999: 50 };
    const credits = CREDIT_MAP[amountCents] ?? parseInt(session.metadata?.credits ?? '0');

    console.log(`[Webhook] checkout.session.completed uid=${uid} amount=${amountCents} credits=${credits}`);

    if (!uid || credits <= 0) {
      console.error('[Webhook] Cannot credit — missing uid or unrecognised amount:', { uid, amountCents });
      return res.json({ received: true }); // 200 so Stripe doesn't retry
    }

    try {
      if (adminDb) {
        await adminDb.collection('users').doc(uid).set(
          { credits: admin.firestore.FieldValue.increment(credits) },
          { merge: true }
        );
        await adminDb.collection('purchases').add({
          uid, credits, amountCents, at: Date.now(),
          stripeSession: session.id,
        });
        console.log(`[Webhook] ✓ Added ${credits} credits to uid=${uid}`);
      } else {
        // Fallback: REST API with a server token isn't possible without service account.
        // Log clearly so the operator knows what to do.
        console.error('[Webhook] ✗ Firebase Admin SDK not available. Set FIREBASE_SERVICE_ACCOUNT to enable automatic credit delivery.');
      }
    } catch (err) {
      console.error('[Webhook] Failed to write credits:', err.message);
      return res.status(500).json({ error: 'Credit update failed' });
    }
  }

  res.json({ received: true });
});

app.use(express.json());

// ── HEALTH TRACKING ───────────────────────────────────────────────────────────
const _health = {
  byRoute: {}, recentErrors: [], authFails: 0, webhookFails: 0,
  startedAt: Date.now(),
};
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    const ms  = Date.now() - t;
    const key = `${req.method} ${req.path}`;
    if (!_health.byRoute[key]) _health.byRoute[key] = { count: 0, errors: 0, totalMs: 0 };
    const r = _health.byRoute[key];
    r.count++; r.totalMs += ms;
    if (res.statusCode >= 500) {
      r.errors++;
      _health.recentErrors.unshift({ route: key, status: res.statusCode, at: Date.now() });
      if (_health.recentErrors.length > 100) _health.recentErrors.length = 100;
    }
  });
  next();
});

// ── RATE LIMITER (founder endpoints) ─────────────────────────────────────────
const _founderRateMap = new Map();
function founderRateLimit(req, res, next) {
  const key  = req.user?.uid || req.ip;
  const now  = Date.now();
  const calls = (_founderRateMap.get(key) || []).filter(t => now - t < 60000);
  if (calls.length >= 60) return res.status(429).json({ error: 'rate_limited' });
  calls.push(now); _founderRateMap.set(key, calls); next();
}

// ── REQUIRE OWNER (403 + audit log for non-owners) ────────────────────────────
function requireOwner(req, res, next) {
  if (!req.isOwner) {
    console.warn(`[Founder] UNAUTHORIZED uid=${req.user?.uid} ip=${req.ip} path=${req.path}`);
    _health.recentErrors.unshift({ route: `FORBIDDEN:${req.path}`, uid: req.user?.uid, at: Date.now() });
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

// ── CONFIG ────────────────────────────────────────────────────────────────────
// Firebase API key (public — safe to have in code; security enforced by rules)
const FIREBASE_API_KEY  = process.env.FIREBASE_API_KEY  || 'AIzaSyCVcwmzhSGQXNIL-QAZ0dwOzTkkr_7xdkI';
const FIREBASE_PROJECT  = process.env.FIREBASE_PROJECT  || 'selfhaircutai';

// Promo codes — set PROMO_CODES env var on Render as:  OLEA:86400000,SUMMER:3600000
// Format: CODE:DURATION_MS  (86400000 = 24 hours)
// Defaults to OLEA=24h if not set.
function getPromoCodes() {
  const raw = process.env.PROMO_CODES || 'OLEA:86400000';
  const map = {};
  raw.split(',').forEach(entry => {
    const [code, ms] = entry.trim().split(':');
    if (code) map[code.trim().toUpperCase()] = parseInt(ms) || 86400000;
  });
  return map;
}

// ── OPENAI (optional) ─────────────────────────────────────────────────────────
let openai = null;
let toFile = null;
try {
  const OpenAI = require('openai');
  toFile = OpenAI.toFile;
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  console.log('[OpenAI] Client initialized ✓');
} catch(e) {
  console.error('[OpenAI] Client unavailable:', e.message);
}

// ── FIREBASE ADMIN (optional — used only if FIREBASE_SERVICE_ACCOUNT is set) ──
let admin = null;
let adminDb = null;
let _adminInitError = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    admin = require('firebase-admin');
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });
    adminDb = admin.firestore();
    console.log('[Firebase Admin] Initialized ✓');
  } else {
    _adminInitError = 'FIREBASE_SERVICE_ACCOUNT env var is not set';
    console.warn('[Firebase Admin]', _adminInitError);
  }
} catch(e) {
  _adminInitError = e.message;
  console.warn('[Firebase Admin] Unavailable — using REST API fallback:', e.message);
  admin = null; adminDb = null;
}

// ── FIREBASE REST HELPERS ─────────────────────────────────────────────────────
// Verify a Firebase ID token and return { uid, email, emailVerified }
async function verifyFirebaseToken(idToken) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ idToken }),
    }
  );
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error?.message || 'Token verification failed');
  const user = data.users?.[0];
  if (!user) throw new Error('User not found');
  return { uid: user.localId, email: user.email || '', emailVerified: user.emailVerified === true };
}

// ── OWNER ACCESS ──────────────────────────────────────────────────────────────
// Email is read exclusively from the verified server-side token — never from
// request body, query params, or any client-supplied value.
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isOwner(user) {
  // Support both Admin SDK (email_verified) and REST API (emailVerified) shapes
  const emailVerified = user?.email_verified === true || user?.emailVerified === true;
  const authenticatedEmail = normalizeEmail(user?.email);
  const ownerEmail         = normalizeEmail(process.env.OWNER_EMAIL);
  return Boolean(
    emailVerified &&
    authenticatedEmail &&
    ownerEmail &&
    authenticatedEmail === ownerEmail
  );
}

const FS = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

// Read a Firestore document via REST using the user's own bearer token
async function fsGet(collection, docId, bearerToken) {
  const res = await fetch(`${FS}/${collection}/${encodeURIComponent(docId)}`, {
    headers: { 'Authorization': `Bearer ${bearerToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore GET ${res.status}`);
  return res.json();
}

// Write/merge a Firestore document via REST (PATCH with updateMask)
async function fsPatch(collection, docId, firestoreFields, bearerToken) {
  const fieldPaths = Object.keys(firestoreFields).join('&updateMask.fieldPaths=');
  const url = `${FS}/${collection}/${encodeURIComponent(docId)}?updateMask.fieldPaths=${fieldPaths}`;
  const res = await fetch(url, {
    method:  'PATCH',
    headers: {
      'Authorization': `Bearer ${bearerToken}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ fields: firestoreFields }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Firestore PATCH ${res.status}: ${JSON.stringify(err)}`);
  }
  return res.json();
}

// Convert a plain JS object to Firestore REST field format
function toFsFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string')  fields[k] = { stringValue: v };
    else if (typeof v === 'number') fields[k] = { integerValue: String(v) };
    else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
    else if (v && typeof v === 'object') {
      fields[k] = { mapValue: { fields: toFsFields(v) } };
    }
  }
  return fields;
}

// Parse Firestore REST field format back to plain JS
function fromFsFields(fields = {}) {
  const obj = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v.stringValue  !== undefined) obj[k] = v.stringValue;
    else if (v.integerValue !== undefined) obj[k] = Number(v.integerValue);
    else if (v.doubleValue  !== undefined) obj[k] = Number(v.doubleValue);
    else if (v.booleanValue !== undefined) obj[k] = v.booleanValue;
    else if (v.mapValue)  obj[k] = fromFsFields(v.mapValue.fields);
    else if (v.nullValue  !== undefined) obj[k] = null;
  }
  return obj;
}

// Auth middleware — works with or without Admin SDK
async function requireAuth(req, res, next) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });
  try {
    if (adminDb) {
      req.user    = await admin.auth().verifyIdToken(token);
      req.idToken = token;
    } else {
      req.user    = await verifyFirebaseToken(token);
      req.idToken = token;
    }
    req.isOwner = isOwner(req.user);
    next();
  } catch(e) {
    console.error('[Auth] Failed:', e.message);
    _health.authFails++;
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

const SYSTEM_PROMPT = `You are SelfHaircut.ai, an expert AI barber assistant specializing in self-haircuts.
Return ONLY valid JSON — no markdown, no extra text:
{
  "tapperLineY": <0.3-0.75>,
  "tapperLineStartX": <0.05-0.45>,
  "tapperLineEndX": <0.5-0.95>,
  "fadeZoneHeight": <0.08-0.18>,
  "taperType": <"low"|"mid"|"high">,
  "sideburnBottomY": <0.3-0.75>,
  "advice": "<2-3 sentences>",
  "confidence": <"high"|"medium"|"low">
}`;

const PREVIEW_PROMPT =
  'Apply a realistic low taper fade to this person\'s hair. ' +
  'The sideburn and lower temple area near the ear should be shaved very short, fading smoothly upward into the natural hair length. ' +
  'The bald/skin line sits at the bottom of the ear. Hair gradually gets longer moving up the head. ' +
  'The sideburn should be clean and sharp. No hair below the taper line. ' +
  'Keep everything else completely unchanged: face, skin tone, expression, head shape, ear, pose, lighting, background, clothing. ' +
  'Only modify the hair in the taper/sideburn zone. Photorealistic result.';

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:       'ok',
    firebase:     !!adminDb,
    firebaseRest: true,
    openai:       !!openai && !!process.env.OPENAI_API_KEY,
    promoCodes:   Object.keys(getPromoCodes()),
  });
});

// ── ME — safe access info for the frontend ────────────────────────────────────
app.get('/me', requireAuth, async (req, res) => {
  const uid   = req.user.uid;
  const token = req.idToken;
  if (req.isOwner) {
    return res.json({ isOwner: true, hasUnlimitedAccess: true, credits: null });
  }
  try {
    let credits = 0;
    if (adminDb) {
      const snap = await adminDb.collection('users').doc(uid).get();
      credits    = snap.exists ? (snap.data().credits ?? 0) : 0;
    } else {
      const snap = await fsGet('users', uid, token);
      credits    = snap ? (fromFsFields(snap.fields || {}).credits ?? 0) : 0;
    }
    res.json({ isOwner: false, hasUnlimitedAccess: false, credits });
  } catch(err) {
    console.error('[/me]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── ANALYZE ───────────────────────────────────────────────────────────────────
// ── SHARED ANALYSIS HELPER ────────────────────────────────────────────────────
// Runs attempt 1 with full prompt, attempt 2 with simplified prompt on failure.
// Returns { result, log } where result is null if both attempts failed.
// Persist an AI request record to Firestore (best-effort, never throws)
async function _saveAiRequest(record) {
  try {
    if (adminDb) {
      await adminDb.collection('ai_requests').add({ ...record, at: Date.now() });
    }
  } catch(e) { /* non-fatal */ }
}

async function runWithRetry(endpoint, buffer, mimetype, fullPrompt, fullText, simplePrompt, simpleText, extraLog = {}) {
  const startedAt = Date.now();
  const log = {
    endpoint,
    fileReceived:   true,
    originalMime:   mimetype,
    originalSize:   buffer.length,
    model:          CLAUDE_MODEL,
    attempt:        0,
    retried:        false,
    ...extraLog,
  };

  // Normalize image
  let base64, processedMime;
  try {
    const norm    = await normalizeImage(buffer, mimetype, log);
    base64        = norm.buffer.toString('base64');
    processedMime = norm.mediaType;
    log.normalized = true;
  } catch(normErr) {
    log.normalizeError = normErr.message;
    console.error(`[${endpoint}] image normalization failed`, log);
    base64        = buffer.toString('base64');
    processedMime = mimetype || 'image/jpeg';
  }

  // Attempt 1
  let result = null;
  const t1 = Date.now();
  log.attempt = 1;
  try {
    result = await callClaudeVision(base64, processedMime, fullPrompt, fullText);
    log.attempt1Success  = true;
    log.attempt1Ms       = Date.now() - t1;
  } catch(err1) {
    log.attempt1Error       = err1.message;
    log.attempt1RawResponse = err1.rawResponse?.slice(0, 800);
    log.attempt1RawJson     = err1.rawJson?.slice(0, 800);
    log.attempt1Ms          = Date.now() - t1;
    log.errorCategory       = classifyError(err1.message);
    console.warn(`[${endpoint}] attempt 1 failed`, log);
  }

  // Attempt 2
  if (!result) {
    const t2 = Date.now();
    log.attempt = 2;
    log.retried = true;
    try {
      result = await callClaudeVision(base64, processedMime, simplePrompt, simpleText, { maxTokens: 800 });
      log.attempt2Success  = true;
      log.attempt2Ms       = Date.now() - t2;
      log.usedSimplePrompt = true;
    } catch(err2) {
      log.attempt2Error       = err2.message;
      log.attempt2RawResponse = err2.rawResponse?.slice(0, 800);
      log.attempt2RawJson     = err2.rawJson?.slice(0, 800);
      log.attempt2Ms          = Date.now() - t2;
      log.errorCategory       = classifyError(err2.message);
      console.error(`[${endpoint}] attempt 2 failed`, log);
    }
  }

  log.totalMs = Date.now() - startedAt;
  log.success = !!result;

  // Persist to Firestore (non-blocking)
  _saveAiRequest({
    endpoint,
    uid:            log.uid || null,
    success:        log.success,
    retried:        log.retried,
    model:          log.model,
    totalMs:        log.totalMs,
    attempt1Ms:     log.attempt1Ms,
    attempt2Ms:     log.attempt2Ms,
    originalMime:   log.originalMime,
    originalSize:   log.originalSize,
    processedSize:  log.processedSize,
    originalWidth:  log.originalWidth,
    originalHeight: log.originalHeight,
    errorCategory:  log.errorCategory || null,
    attempt1Error:  log.attempt1Error || null,
    attempt2Error:  log.attempt2Error || null,
    attempt1Raw:    log.attempt1RawResponse || null,
    attempt2Raw:    log.attempt2RawResponse || null,
    normalizeError: log.normalizeError || null,
  });

  if (result) console.log(`[${endpoint}] success attempt=${log.attempt} totalMs=${log.totalMs}`, log);
  return { result, log };
}

// Classify an error string into a user-facing reason code
function classifyError(msg = '') {
  if (msg.includes('TIMEOUT'))              return 'timeout';
  if (msg.includes('CLAUDE_HTTP_529'))      return 'overloaded';
  if (msg.includes('CLAUDE_HTTP_5'))        return 'api_error';
  if (msg.includes('CLAUDE_HTTP_4'))        return 'api_client_error';
  if (msg.includes('JSON_MISSING') || msg.includes('JSON_PARSE')) return 'bad_response';
  if (msg.includes('IMAGE_UNREADABLE') || msg.includes('IMAGE_EMPTY')) return 'unreadable_image';
  if (msg.includes('ANTHROPIC_API_KEY'))    return 'not_configured';
  return 'unknown';
}

app.post('/analyze', upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded', reason: 'no_file' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'AI not configured', reason: 'not_configured' });

  const ANALYZE_SIMPLE = `You are SelfHaircut.ai. Place a taper guide line on the photo.
Return ONLY valid JSON: {"lineYFrac":0.5,"startXFrac":0.05,"endXFrac":0.95,"earTopFrac":0.38,"earMidFrac":0.5}`;

  const { result, log } = await runWithRetry(
    '/analyze',
    req.file.buffer,
    req.file.mimetype,
    SYSTEM_PROMPT,
    'Place the low taper guide line just below the sideburn. Return only JSON.',
    ANALYZE_SIMPLE,
    'Place the taper guide line. Return only the JSON object, nothing else.'
  ).catch(err => {
    console.error('[/analyze] runWithRetry threw', err.message);
    return { result: null, log: { endpoint: '/analyze', unexpectedError: err.message } };
  });

  if (!result) {
    const reason = classifyError(log.attempt2Error || log.attempt1Error || '');
    return res.status(500).json({ error: 'Analysis failed after retry', reason, log });
  }
  res.json(result);
});

// ── GENERATE PREVIEW ──────────────────────────────────────────────────────────
app.post('/generate-preview', upload.single('photo'), async (req, res) => {
  console.log('[/generate-preview] Request received');
  try {
    if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });
    console.log('[/generate-preview] Image received —', `${(req.file.size/1024).toFixed(1)} KB`);
    if (!openai || !process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
    }
    console.log('[/generate-preview] Sending to OpenAI gpt-image-1');
    const imageFile = await toFile(
      req.file.buffer, req.file.originalname || 'photo.jpg',
      { type: req.file.mimetype || 'image/jpeg' }
    );
    const result = await openai.images.edit({ model: 'gpt-image-1', image: imageFile, prompt: PREVIEW_PROMPT, n: 1, size: '1024x1024' });
    const b64    = result.data[0]?.b64_json;
    if (!b64) return res.status(500).json({ error: 'No image data in response' });
    console.log('[/generate-preview] Done —', `${(b64.length/1024).toFixed(0)} KB`);
    res.json({ previewUrl: `data:image/png;base64,${b64}` });
  } catch(err) {
    console.error('[/generate-preview] Failed:', err.message, err.error || '');
    res.status(500).json({ error: err.message, detail: err.error || null });
  }
});

// ── REDEEM CODE ───────────────────────────────────────────────────────────────
app.post('/redeem-code', requireAuth, async (req, res) => {
  const uid   = req.user.uid;
  const token = req.idToken;
  const code  = (req.body.code || '').trim().toUpperCase();

  if (!code) return res.status(400).json({ error: 'no_code', message: 'No code provided.' });
  console.log(`[/redeem-code] uid=${uid} code=${code}`);

  try {
    // 1. Validate code against env-var config
    const codes = getPromoCodes();
    if (!codes[code]) {
      console.log(`[/redeem-code] Unknown code: ${code}. Known: ${Object.keys(codes).join(', ')}`);
      return res.status(404).json({ error: 'invalid_code', message: "That code isn't valid." });
    }
    const durationMs = codes[code];

    // 2. Check if already redeemed
    let alreadyRedeemed = false;
    try {
      if (adminDb) {
        const snap = await adminDb.collection('users').doc(uid).get();
        const data  = snap.exists ? snap.data() : {};
        alreadyRedeemed = data.promoAccess?.code === code;
      } else {
        const snap = await fsGet('users', uid, token);
        if (snap) {
          const data  = fromFsFields(snap.fields || {});
          alreadyRedeemed = data.promoAccess?.code === code;
        }
      }
    } catch(e) {
      console.warn('[/redeem-code] Could not read existing user doc:', e.message);
    }

    if (alreadyRedeemed) {
      return res.status(409).json({ error: 'already_redeemed', message: "You've already redeemed this code." });
    }

    // 3. Write promoAccess
    const now         = Date.now();
    const expiresAt   = now + durationMs;
    const promoAccess = { code, redeemedAt: now, expiresAt };

    if (adminDb) {
      await adminDb.collection('users').doc(uid).set({ promoAccess }, { merge: true });
    } else {
      await fsPatch('users', uid, toFsFields({ promoAccess }), token);
    }

    console.log(`[/redeem-code] ✓ uid=${uid} code=${code} expires=${new Date(expiresAt).toISOString()}`);
    res.json({ success: true, promoAccess });

  } catch(err) {
    console.error('[/redeem-code] Error:', err.message);
    res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// ── USE CREDIT ────────────────────────────────────────────────────────────────
app.post('/use-credit', requireAuth, async (req, res) => {
  const uid       = req.user.uid;
  const token     = req.idToken;
  const promoOnly = req.body?.promoOnly === true;

  // Owner bypasses all credit / subscription checks
  if (req.isOwner) {
    console.log(`[/use-credit] owner bypass uid=${uid}`);
    return res.json({ isOwner: true, credits: null, hasUnlimitedAccess: true });
  }

  try {
    let userData = {};
    if (adminDb) {
      const snap = await adminDb.collection('users').doc(uid).get();
      userData   = snap.exists ? snap.data() : {};
    } else {
      const snap = await fsGet('users', uid, token);
      userData   = snap ? fromFsFields(snap.fields || {}) : {};
    }

    // 1. Active promo → allow through
    const pa = userData.promoAccess;
    if (pa && pa.expiresAt > Date.now()) {
      return res.json({ credits: userData.credits ?? 0, promoActive: true, promoAccess: pa });
    }
    if (promoOnly) return res.json({ credits: userData.credits ?? 0, promoExpired: true });

    // 2a. Free guide — start new session (freeGuideUsed must be explicitly false)
    //     Undefined means existing user before this field → treat as expired.
    if (userData.freeGuideUsed === false) {
      const now       = Date.now();
      const expiresAt = now + 3600000; // 1 hour session
      if (adminDb) {
        await adminDb.collection('users').doc(uid).update({
          freeGuideUsed: true,
          freeGuideStartedAt: now,
          freeGuideExpiresAt: expiresAt,
        });
      } else {
        await fsPatch('users', uid, {
          freeGuideUsed:      { booleanValue: true },
          freeGuideStartedAt: { integerValue: String(now) },
          freeGuideExpiresAt: { integerValue: String(expiresAt) },
        }, token);
      }
      const minutesRemaining = 60;
      console.log(`[/use-credit] uid=${uid} started free guide session, expires=${new Date(expiresAt).toISOString()}`);
      return res.json({ credits: userData.credits ?? 0, usedFreeGuide: true, freeGuideExpiresAt: expiresAt, minutesRemaining });
    }

    // 2b. Free guide session still active (within 1-hour window)
    if (userData.freeGuideUsed === true && userData.freeGuideExpiresAt > Date.now()) {
      const minutesRemaining = Math.ceil((userData.freeGuideExpiresAt - Date.now()) / 60000);
      console.log(`[/use-credit] uid=${uid} free guide active, ${minutesRemaining}m remaining`);
      return res.json({ credits: userData.credits ?? 0, freeGuideActive: true, freeGuideExpiresAt: userData.freeGuideExpiresAt, minutesRemaining });
    }

    // 3. Credits
    const current = userData.credits ?? 0;
    if (current <= 0) return res.status(402).json({ error: 'no_credits', credits: 0 });

    if (adminDb) {
      await adminDb.collection('users').doc(uid).update({
        credits: admin.firestore.FieldValue.increment(-1),
      });
    } else {
      await fsPatch('users', uid, { credits: { integerValue: String(current - 1) } }, token);
    }

    console.log(`[/use-credit] uid=${uid} remaining=${current - 1}`);
    res.json({ credits: current - 1 });

  } catch(err) {
    console.error('[/use-credit]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── FREE GUIDE STATUS ─────────────────────────────────────────────────────────
app.get('/free-guide-status', requireAuth, async (req, res) => {
  const uid   = req.user.uid;
  const token = req.idToken;
  if (req.isOwner) return res.json({ status: 'owner', isOwner: true });
  try {
    let userData = {};
    if (adminDb) {
      const snap = await adminDb.collection('users').doc(uid).get();
      userData   = snap.exists ? snap.data() : {};
    } else {
      const snap = await fsGet('users', uid, token);
      userData   = snap ? fromFsFields(snap.fields || {}) : {};
    }

    const now = Date.now();
    if (userData.freeGuideUsed === false) {
      return res.json({ status: 'available' });
    }
    if (userData.freeGuideUsed === true && userData.freeGuideExpiresAt > now) {
      const minutesRemaining = Math.ceil((userData.freeGuideExpiresAt - now) / 60000);
      return res.json({ status: 'active', minutesRemaining, freeGuideExpiresAt: userData.freeGuideExpiresAt });
    }
    return res.json({ status: 'expired' });
  } catch(err) {
    console.error('[/free-guide-status]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DEDUCT CREDIT (add-on purchases) ─────────────────────────────────────────
// Generic single-credit deduction for optional packages (e.g. Fade Finish).
// Does NOT interact with free-guide session logic.
app.post('/deduct-credit', requireAuth, async (req, res) => {
  const uid   = req.user.uid;
  const token = req.idToken;

  if (req.isOwner) {
    console.log(`[/deduct-credit] owner bypass uid=${uid}`);
    return res.json({ isOwner: true, credits: null, hasUnlimitedAccess: true });
  }

  try {
    let userData = {};
    if (adminDb) {
      const snap = await adminDb.collection('users').doc(uid).get();
      userData   = snap.exists ? snap.data() : {};
    } else {
      const snap = await fsGet('users', uid, token);
      userData   = snap ? fromFsFields(snap.fields || {}) : {};
    }

    const current = userData.credits ?? 0;
    if (current <= 0) return res.status(402).json({ error: 'no_credits', credits: 0 });

    if (adminDb) {
      await adminDb.collection('users').doc(uid).update({
        credits: admin.firestore.FieldValue.increment(-1),
      });
    } else {
      await fsPatch('users', uid, { credits: { integerValue: String(current - 1) } }, token);
    }

    console.log(`[/deduct-credit] uid=${uid} remaining=${current - 1}`);
    res.json({ credits: current - 1 });
  } catch(err) {
    console.error('[/deduct-credit]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── FADE FINISH PACKAGE ───────────────────────────────────────────────────────
const FADE_FINISH_PROMPT = `You are a professional barber reviewing a client's finished self-haircut. Your role is to coach, not to reject. Be specific, honest, and encouraging.

CRITICAL RULE: Always return the JSON below — even for imperfect, angled, or close-up photos. Only set "unusable": true if the image is completely black, shows no head or hair at all, is completely unrecognizable, or is clearly not a haircut photo. Everything else must be analyzed.

Assess "confidence" based on photo quality:
- "high": clear view of fade area, good lighting
- "medium": slightly angled, close-up, or moderate lighting — still very usable
- "low": significantly obscured or dim — analyze anyway and note the limitation

For areas you cannot see (front hairline, beard, etc.) — do not guess. Use null for the score and say "Not visible in this photo."

For "zones": identify 3–6 specific spots on the photo to mark up. Use fractional coordinates where x=0 is the left edge, x=1 is the right edge, y=0 is the top, y=1 is the bottom of the image. Each zone gets:
- "color": "green" (looks good), "yellow" (minor improvement), or "red" (needs correction)
- "label": short barber instruction like "Flick out here", "Blend upward", "Remove weight line", "Good blend", "Clean edge", "Dark spot — blend more"
- "arrowDir": "up", "down", "left", "right", or null

Return ONLY valid JSON, no markdown, no extra text:

{
  "unusable": false,
  "unusableReason": null,
  "confidence": "high",
  "overallScore": 0-100,
  "strengths": [
    "Specific strength observed in the photo",
    "Specific strength observed in the photo",
    "Specific strength observed in the photo"
  ],
  "areasToImprove": [
    "Specific issue to fix, with location",
    "Specific issue to fix, with location"
  ],
  "guidelinePlacement": {
    "score": 0-100,
    "assessment": "Where the taper/fade sits — natural, flattering height? 1-2 sentences."
  },
  "blendQuality": {
    "score": 0-100,
    "assessment": "How smooth is the gradient from skin to longer hair? 1-2 sentences."
  },
  "sideburnShape": {
    "score": 0-100,
    "assessment": "Sideburn shape, symmetry, cleanliness. 1 sentence."
  },
  "fadeConsistency": {
    "score": 0-100,
    "assessment": "Uneven patches, blotchy areas, skipped spots. 1-2 sentences."
  },
  "cleanupQuality": {
    "score": 0-100,
    "assessment": "Edge clarity around ear and neck. 1 sentence."
  },
  "biggestImprovement": "The single most impactful thing to improve next time. Be concrete.",
  "barberRecommendation": "One actionable tip for their next cut. 1-2 sentences.",
  "motivationalNote": "Encouraging closing note. 1-2 sentences.",
  "zones": [
    { "x": 0.3, "y": 0.6, "color": "yellow", "label": "Blend this upward", "arrowDir": "up" },
    { "x": 0.55, "y": 0.7, "color": "green", "label": "Good blend here", "arrowDir": null }
  ],
  "lineup": {
    "frontHairline": {
      "visible": true,
      "assessment": "Is the front hairline clean and even? If not visible, say 'Not visible in this photo.' 1-2 sentences.",
      "tip": "Specific tip for front lineup, or null if not visible."
    },
    "temples": {
      "visible": true,
      "assessment": "Temple shape — pointed, rounded, natural fade-out? Clean? 1-2 sentences.",
      "tip": "Specific tip for temple cleanup, or null if not visible."
    },
    "sideburnCleanup": {
      "visible": true,
      "assessment": "Sideburn endpoint — is it clean, defined, symmetrical? 1-2 sentences.",
      "tip": "Specific tip for sideburn cleanup, or null if not visible."
    },
    "beardConnection": {
      "visible": false,
      "assessment": "If beard is visible, assess the connection between fade and beard. If no beard visible, say 'Beard not visible in this photo.'",
      "tip": null
    }
  }
}

Never return plain text. Never refuse. Always return the JSON.`;

app.post('/fade-finish', upload.single('photo'), requireAuth, async (req, res) => {
  const uid   = req.user.uid;
  const token = req.idToken;
  const log   = {
    uid,
    isOwner:       req.isOwner,
    fileReceived:  !!req.file,
    originalMime:  req.file?.mimetype,
    originalSize:  req.file?.size,
    model:         CLAUDE_MODEL,
    attempt:       0,
    retried:       false,
    creditDeducted: false,
  };

  try {
    if (!req.file) {
      console.warn('[/fade-finish] no file received', log);
      return res.status(400).json({ error: 'No photo uploaded' });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('[/fade-finish] ANTHROPIC_API_KEY not set');
      return res.status(500).json({ error: 'AI not configured' });
    }

    // ── Credit pre-check (don't deduct yet) ──────────────────────────────────
    let currentCredits = null;
    if (!req.isOwner) {
      try {
        let userData = {};
        if (adminDb) {
          const snap = await adminDb.collection('users').doc(uid).get();
          userData   = snap.exists ? snap.data() : {};
        } else {
          const snap = await fsGet('users', uid, token);
          userData   = snap ? fromFsFields(snap.fields || {}) : {};
        }
        currentCredits = userData.credits ?? 0;
        log.creditsBeforeDeduct = currentCredits;
        if (currentCredits <= 0) {
          console.log(`[/fade-finish] no credits uid=${uid}`);
          return res.status(402).json({ error: 'no_credits', credits: 0 });
        }
      } catch(creditErr) {
        console.error('[/fade-finish] credit pre-check error', creditErr.message);
        return res.status(500).json({ error: 'Could not verify credits' });
      }
    }

    // ── Normalize image ───────────────────────────────────────────────────────
    let processedBuf, processedMime;
    try {
      const norm = await normalizeImage(req.file.buffer, req.file.mimetype, log);
      processedBuf  = norm.buffer;
      processedMime = norm.mediaType;
      log.normalized = true;
    } catch(normErr) {
      log.normalizeError = normErr.message;
      console.error('[/fade-finish] image normalization failed', log);
      // Fall back to raw buffer if sharp fails (e.g. truly corrupt)
      processedBuf  = req.file.buffer;
      processedMime = req.file.mimetype || 'image/jpeg';
    }

    const base64 = processedBuf.toString('base64');

    // ── Attempt 1: full prompt ────────────────────────────────────────────────
    let result = null;
    let attempt1Error = null;
    log.attempt = 1;
    try {
      result = await callClaudeVision(
        base64, processedMime, FADE_FINISH_PROMPT,
        'Analyze this finished haircut photo and return the full JSON including lineup guidance. Coach, do not reject.'
      );
    } catch(err1) {
      attempt1Error = err1.message;
      log.attempt1Error     = err1.message;
      log.attempt1RawJson   = err1.rawJson;
      log.attempt1RawResponse = err1.rawResponse;
      console.warn('[/fade-finish] attempt 1 failed', log);
    }

    // ── Attempt 2: simplified prompt ──────────────────────────────────────────
    if (!result) {
      log.attempt  = 2;
      log.retried  = true;
      try {
        result = await callClaudeVision(
          base64, processedMime, FADE_FINISH_PROMPT_SIMPLE,
          'Analyze this haircut photo and return the JSON. Be tolerant — work with whatever you can see.',
          { maxTokens: 800 }
        );
        log.usedSimplePrompt = true;
      } catch(err2) {
        log.attempt2Error = err2.message;
        console.error('[/fade-finish] attempt 2 failed — sending fallback', log);
      }
    }

    // ── Fallback: no credit deducted ──────────────────────────────────────────
    if (!result) {
      console.log('[/fade-finish] returning fallback (no credit deducted)', log);
      return res.json({
        fallback: true,
        creditUsed: false,
        error: attempt1Error,
      });
    }

    // ── Unusable photo ────────────────────────────────────────────────────────
    if (result.unusable === true) {
      console.log('[/fade-finish] photo marked unusable by AI', log);
      return res.status(422).json({
        error: 'unusable_photo',
        reason: result.unusableReason || 'Photo not usable',
      });
    }

    // ── Deduct credit only on success ─────────────────────────────────────────
    let creditsAfter = null;
    if (!req.isOwner) {
      try {
        if (adminDb) {
          await adminDb.collection('users').doc(uid).update({
            credits: admin.firestore.FieldValue.increment(-1),
          });
        } else {
          await fsPatch('users', uid, { credits: { integerValue: String(currentCredits - 1) } }, token);
        }
        creditsAfter = currentCredits - 1;
        log.creditDeducted = true;
        log.creditsAfter   = creditsAfter;
        console.log(`[/fade-finish] success + credit deducted uid=${uid} credits=${creditsAfter}`, log);
      } catch(deductErr) {
        log.deductError = deductErr.message;
        console.error('[/fade-finish] credit deduction failed after successful analysis', log);
        // Still return the result — don't punish the user for a DB error
      }
    } else {
      console.log(`[/fade-finish] owner — analysis complete, no credit deducted`, log);
    }

    res.json({ ...result, credits: creditsAfter, creditUsed: !req.isOwner });

  } catch(err) {
    log.unexpectedError = err.message;
    console.error('[/fade-finish] unexpected error', log, err);
    res.status(500).json({ error: 'Unexpected error during analysis' });
  }
});

// ── SEND EMAIL ────────────────────────────────────────────────────────────────
app.post('/send-email', async (req, res) => {
  const { to, subject } = req.body || {};
  console.log(`[/send-email] to=${to} subject="${subject}"`);
  res.json({ ok: true });
});

// ── CHAT ──────────────────────────────────────────────────────────────────────
const CHAT_SYSTEM = `You are SelfHaircut.ai, an expert AI barber assistant. You help people cut their own hair at home — primarily tapers, fades, buzz cuts, and lineups.

The app uses a credit system. Each haircut guide costs 1 credit. Credits can be purchased inside the app: 5 credits for $9.99, 15 credits for $24.99, or 50 credits for $69.99. Users get 1 free credit when they sign up. If someone asks about buying credits, tell them to tap the credit badge at the top of the screen or the "Buy Credits" button in the menu — it opens the purchase screen directly in the app.

Answer any question the user asks. For haircut questions, give clear, specific, actionable advice. For off-topic questions, answer helpfully and naturally, then bring the conversation back to haircuts if relevant.

Keep responses concise — 2–4 sentences for simple questions, up to a short paragraph for complex ones. Use plain text, no markdown. Be warm, confident, and direct.

`;

app.post('/chat', async (req, res) => {
  const { message, history = [] } = req.body || {};
  if (!message) return res.status(400).json({ error: 'No message provided' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'AI not configured' });

  try {
    const messages = [
      ...history.slice(-6).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: CHAT_SYSTEM,
        messages,
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    const reply = data.content?.map(c => c.text || '').join('').trim();
    res.json({ reply });
  } catch (err) {
    console.error('[/chat]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── BARBER REPORT ─────────────────────────────────────────────────────────────
const BARBER_REPORT_PROMPT = `You are an expert barber analyzing a side-profile photo of someone's hair before a self-haircut. Your job is to provide accurate, honest observations based only on what you can actually see in the photo.

Return ONLY valid JSON — no markdown, no extra text. If you cannot confidently assess something from the photo, say so in the explanation field. Never invent or exaggerate observations.

{
  "density": {
    "level": "Very Thin|Thin|Medium|Thick|Very Thick",
    "explanation": "What this means for their fade. 1-2 sentences."
  },
  "hairLoss": {
    "level": "No visible thinning|Mild temple recession|Crown thinning|Diffuse thinning|Advanced hair loss",
    "detected": true or false,
    "explanation": "Only mention thinning if genuinely visible. If none detected, say so briefly."
  },
  "texture": {
    "type": "Straight|Wavy|Curly|Coily",
    "explanation": "How this texture affects fading. 1-2 sentences."
  },
  "sideburnThickness": {
    "level": "Sparse|Medium|Thick",
    "explanation": "How this affects taper placement. 1 sentence."
  },
  "headShape": {
    "shape": "Oval|Round|Square|Oblong|Diamond|Uncertain from this angle",
    "confidence": "high|moderate|low",
    "explanation": "Best estimate from side profile. Be honest if hard to tell."
  },
  "growthDirection": {
    "direction": "Mostly downward|Mostly outward|Mixed",
    "explanation": "How this impacts blending. 1 sentence."
  },
  "taperDifficulty": {
    "level": "Easy|Moderate|Advanced",
    "explanation": "Why. Based on hair type, density, texture. 1-2 sentences."
  },
  "barberNotes": [
    "Personalized observation 1 based on actual photo",
    "Personalized observation 2",
    "Personalized observation 3"
  ]
}`;

const GRADE_FADE_PROMPT = `You are an expert barber reviewing a finished self-haircut photo. Your job is to COACH, not to reject.

CRITICAL RULE: You MUST always return the JSON below — even if the photo is imperfect, angled, close-up, or lower quality. Only set "unusable": true if the image is completely black, completely blurred beyond any recognition, shows no head or hair at all, or is clearly not a haircut photo. Everything else should be analyzed.

For finished-fade grading you only need to see: the sideburn area, around the ear, the fade/blend zone, and the neckline or temple. Close-up shots, angled shots, phone-camera quality, and imperfect lighting are all acceptable as long as some fade area is visible.

Assess "confidence" based on photo quality:
- "high": clear side profile, good light, fade area fully visible
- "medium": slightly angled, close-up, or moderate lighting — still very usable
- "low": significantly obscured, very dim, or partially cut off — analyze anyway, note the limitation

Return ONLY valid JSON, no markdown, no extra text:

{
  "unusable": false,
  "unusableReason": null,
  "confidence": "high",
  "guidelinePlacement": {
    "score": 0-100,
    "assessment": "Where the taper sits — is it placed at a natural, flattering height? 1-2 sentences."
  },
  "blendQuality": {
    "score": 0-100,
    "assessment": "How smooth is the gradient from skin/bald to longer hair? 1-2 sentences."
  },
  "sideburnShape": {
    "score": 0-100,
    "assessment": "Shape, symmetry, and cleanliness of the sideburn. 1 sentence."
  },
  "fadeConsistency": {
    "score": 0-100,
    "assessment": "Are there blotchy, uneven, or skipped patches? 1-2 sentences."
  },
  "cleanupQuality": {
    "score": 0-100,
    "assessment": "Edge clarity, detail work around ear and neck. 1 sentence."
  },
  "overallScore": 0-100,
  "whatYouDidWell": [
    "Specific positive observation 1",
    "Specific positive observation 2",
    "Specific positive observation 3"
  ],
  "biggestImprovement": "The single most impactful change for next time. Be concrete and specific.",
  "barberRecommendation": "One actionable tip they can apply at their next cut. 1-2 sentences.",
  "motivationalNote": "Encouraging closing note — acknowledge effort and point toward progress. 1-2 sentences."
}

If confidence is "low", mention it naturally in one of the assessments, e.g. "The photo angle made it harder to judge the blend precisely — a direct side-profile shot would sharpen the score."

Never return plain text. Never refuse. Always return the JSON.`;

const CLAUDE_MODEL = 'claude-sonnet-4-5-20251001';
const CLAUDE_TIMEOUT_MS = 55000;

async function callClaudeVision(base64, mediaType, systemPrompt, userText, opts = {}) {
  const model     = opts.model || CLAUDE_MODEL;
  const maxTokens = opts.maxTokens || 1500;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);

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
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: userText },
        ]}],
      }),
    });
  } catch(fetchErr) {
    if (fetchErr.name === 'AbortError') throw new Error('TIMEOUT: Claude API did not respond within limit');
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
    const err = new Error('JSON_MISSING: No JSON object in Claude response');
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

// ── IMAGE NORMALIZATION ───────────────────────────────────────────────────────
const MAX_IMG_DIMENSION = 1600;
const JPEG_QUALITY      = 82;

async function normalizeImage(buffer, originalMimetype, logCtx) {
  let workBuf  = buffer;
  let workMime = originalMimetype || 'image/jpeg';

  // Convert HEIC/HEIF → JPEG (pure-JS, no native lib needed)
  if (workMime === 'image/heic' || workMime === 'image/heif') {
    try {
      const heicConvert = require('heic-convert');
      workBuf  = Buffer.from(await heicConvert({ buffer: workBuf, format: 'JPEG', quality: 0.9 }));
      workMime = 'image/jpeg';
      logCtx.heicConverted = true;
    } catch(e) {
      logCtx.heicConvertError = e.message;
      // Fall through and let sharp try anyway
    }
  }

  const sharp = require('sharp');
  const img   = sharp(workBuf).rotate(); // auto-orient via EXIF
  const meta  = await img.metadata();
  logCtx.originalWidth  = meta.width;
  logCtx.originalHeight = meta.height;
  logCtx.originalFormat = meta.format;

  // Reject if sharp can't read the image at all
  if (!meta.width || !meta.height) throw new Error('IMAGE_UNREADABLE: sharp could not decode image');

  // Resize if oversized (keeps aspect ratio, never enlarges)
  const needsResize = meta.width > MAX_IMG_DIMENSION || meta.height > MAX_IMG_DIMENSION;
  const pipeline    = needsResize
    ? img.resize(MAX_IMG_DIMENSION, MAX_IMG_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    : img;
  if (needsResize) logCtx.resized = true;

  const outBuf = await pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: false }).toBuffer();
  if (!outBuf || outBuf.length < 1000) throw new Error('IMAGE_EMPTY: processed image is too small to be valid');

  logCtx.processedSize   = outBuf.length;
  logCtx.processedFormat = 'image/jpeg';
  logCtx.processedWidth  = needsResize ? Math.round(meta.width  * Math.min(MAX_IMG_DIMENSION/meta.width, MAX_IMG_DIMENSION/meta.height)) : meta.width;
  logCtx.processedHeight = needsResize ? Math.round(meta.height * Math.min(MAX_IMG_DIMENSION/meta.width, MAX_IMG_DIMENSION/meta.height)) : meta.height;

  return { buffer: outBuf, mediaType: 'image/jpeg' };
}

// Simplified retry prompt — less strict JSON, shorter, more tolerant
const FADE_FINISH_PROMPT_SIMPLE = `You are a barber reviewing a finished haircut photo. Coach the person — do not reject.

Analyze whatever you can see. Return ONLY valid JSON, nothing else:

{
  "unusable": false,
  "confidence": "medium",
  "overallScore": 60,
  "strengths": ["One strength you can observe"],
  "areasToImprove": ["One area to improve"],
  "biggestImprovement": "The main thing to fix next time.",
  "barberRecommendation": "One concrete tip.",
  "motivationalNote": "Short encouragement.",
  "zones": [],
  "lineup": {}
}

Only set unusable:true if there is literally no hair visible at all.`;

const BARBER_REPORT_SIMPLE = `You are a barber reviewing a side-profile photo. Return ONLY valid JSON:
{"hairLength":"medium","hairTexture":"straight","currentFadeLevel":"none","growthPattern":"normal",
"recommendedGuards":{"bottom":"0","mid":"1","top":"2"},"keyObservations":["One thing you can see"],
"warnings":[],"confidence":"medium"}`;

app.post('/barber-report', upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded', reason: 'no_file' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'AI not configured', reason: 'not_configured' });

  const { result, log } = await runWithRetry(
    '/barber-report',
    req.file.buffer,
    req.file.mimetype,
    BARBER_REPORT_PROMPT,
    'Analyze this side-profile photo and return the barber report JSON. Be accurate and honest.',
    BARBER_REPORT_SIMPLE,
    'Analyze this hair photo. Return only the JSON object.'
  ).catch(err => ({ result: null, log: { unexpectedError: err.message } }));

  if (!result) {
    const reason = classifyError(log.attempt2Error || log.attempt1Error || '');
    return res.status(500).json({ error: 'Barber report failed after retry', reason, log });
  }
  res.json(result);
});

const GRADE_FADE_SIMPLE = `You are a barber grading a finished fade. Coach, do not reject. Return ONLY valid JSON:
{"unusable":false,"overallScore":65,"grade":"B","strengths":["Visible effort"],
"areasToImprove":["Blend above the ear"],"biggestImprovement":"Work the mid section more.",
"barberRecommendation":"Use a flicking motion upward.","motivationalNote":"Keep going — this is fixable.",
"confidence":"medium","zones":[]}`;

app.post('/grade-fade', upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded', reason: 'no_file' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'AI not configured', reason: 'not_configured' });

  const { result, log } = await runWithRetry(
    '/grade-fade',
    req.file.buffer,
    req.file.mimetype,
    GRADE_FADE_PROMPT,
    'Analyze this finished haircut photo and return the JSON. Be forgiving — coach, do not reject.',
    GRADE_FADE_SIMPLE,
    'Grade this haircut photo. Return only the JSON object. Be tolerant — work with whatever you can see.'
  ).catch(err => ({ result: null, log: { unexpectedError: err.message } }));

  if (!result) {
    const reason = classifyError(log.attempt2Error || log.attempt1Error || '');
    return res.status(500).json({ error: 'Grade failed after retry', reason, log });
  }
  if (result.unusable === true) {
    return res.status(422).json({ error: 'unusable_photo', reason: result.unusableReason || 'Photo not usable', log });
  }
  res.json(result);
});

// ── LOG EVENT (analytics funnel — fire-and-forget from frontend) ──────────────
app.post('/log-event', requireAuth, async (req, res) => {
  const { event, data = {} } = req.body || {};
  if (!event) return res.status(400).json({ error: 'Missing event' });
  try {
    if (adminDb) {
      await adminDb.collection('analytics_events').add({
        uid: req.user.uid, event, data, at: Date.now(),
      });
    }
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false }); }
});

// ── LOG FAILURE (AI analysis failures from frontend) ──────────────────────────
app.post('/log-failure', requireAuth, async (req, res) => {
  try {
    if (adminDb) {
      await adminDb.collection('failure_logs').add({
        uid: req.user.uid, ...req.body, at: Date.now(),
      });
    }
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false }); }
});

// Internal helper to log backend failures
async function _logFailure(uid, data) {
  try {
    if (adminDb) await adminDb.collection('failure_logs').add({ uid, ...data, at: Date.now() });
  } catch(e) {}
}

// ── FEEDBACK ──────────────────────────────────────────────────────────────────
app.post('/feedback', requireAuth, async (req, res) => {
  const { type, message, feature } = req.body || {};
  if (!message?.trim()) return res.status(400).json({ error: 'Missing message' });
  try {
    const doc = {
      uid: req.user.uid, email: req.user.email || '',
      type: type || 'general', feature: feature || null,
      message: message.trim(), status: 'new', at: Date.now(),
    };
    if (adminDb) {
      const ref = await adminDb.collection('feedback').add(doc);
      return res.json({ ok: true, id: ref.id });
    }
    res.json({ ok: true });
  } catch(e) {
    console.error('[/feedback]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── FOUNDER: STATS ────────────────────────────────────────────────────────────
app.get('/founder/stats', requireAuth, founderRateLimit, requireOwner, async (req, res) => {
  if (!adminDb) return res.status(503).json({ error: 'Firebase Admin SDK required. Set FIREBASE_SERVICE_ACCOUNT.', detail: _adminInitError });
  try {
    const now   = Date.now();
    const range = req.query.range || '30d';
    const cutoffs = {
      today: new Date().setHours(0, 0, 0, 0),
      '7d':  now - 7 * 864e5,
      '30d': now - 30 * 864e5,
      year:  new Date(new Date().getFullYear(), 0, 1).getTime(),
    };
    const cutoff = cutoffs[range] ?? cutoffs['30d'];

    const [usersSnap, purchasesSnap, eventsSnap, failSnap] = await Promise.all([
      adminDb.collection('users').get(),
      adminDb.collection('purchases').where('at', '>=', cutoff).get(),
      adminDb.collection('analytics_events').where('at', '>=', cutoff).get(),
      adminDb.collection('failure_logs').where('at', '>=', cutoff).get(),
    ]);

    const users   = usersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const todayMs = new Date().setHours(0, 0, 0, 0);
    const weekMs  = now - 7 * 864e5;
    const monthMs = now - 30 * 864e5;

    const totalUsers    = users.length;
    const newToday      = users.filter(u => (u.createdAt || 0) >= todayMs).length;
    const newThisWeek   = users.filter(u => (u.createdAt || 0) >= weekMs).length;
    const newThisMonth  = users.filter(u => (u.createdAt || 0) >= monthMs).length;
    const promoUsers    = users.filter(u => u.promoAccess?.expiresAt > now).length;
    const paidUsers     = users.filter(u => (u.credits || 0) > 0).length;
    const freeUsers     = totalUsers - paidUsers - promoUsers;
    const outOfCredits  = users.filter(u => (u.credits || 0) === 0 && u.freeGuideUsed === true && !u.promoAccess?.expiresAt).length;
    const creditBalance = users.reduce((s, u) => s + (u.credits || 0), 0);

    const purchases   = purchasesSnap.docs.map(d => d.data());
    const totalRevCents  = purchases.reduce((s, p) => s + (p.amountCents || 0), 0);
    const creditsPurchased = purchases.reduce((s, p) => s + (p.credits || 0), 0);

    const events      = eventsSnap.docs.map(d => d.data());
    const eventCounts = {};
    events.forEach(e => { eventCounts[e.event] = (eventCounts[e.event] || 0) + 1; });

    const failures    = failSnap.docs.map(d => d.data());
    const retryOk     = failures.filter(f => f.retrySucceeded).length;

    res.json({
      users: { total: totalUsers, newToday, newThisWeek, newThisMonth, free: freeUsers, paid: paidUsers, promo: promoUsers, outOfCredits },
      revenue: { totalCents: totalRevCents, creditsPurchased },
      credits: { balance: creditBalance },
      events:  eventCounts,
      failures: { total: failures.length, retrySuccesses: retryOk },
    });
  } catch(e) {
    console.error('[/founder/stats]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── FOUNDER: ANALYTICS (funnel + feature breakdown) ───────────────────────────
app.get('/founder/analytics', requireAuth, founderRateLimit, requireOwner, async (req, res) => {
  if (!adminDb) return res.status(503).json({ error: 'Firebase Admin SDK required.' });
  try {
    const now    = Date.now();
    const range  = req.query.range || '7d';
    const cutoffs = { today: new Date().setHours(0,0,0,0), '7d': now-7*864e5, '30d': now-30*864e5, year: new Date(new Date().getFullYear(),0,1).getTime() };
    const cutoff = cutoffs[range] ?? cutoffs['7d'];
    const snap   = await adminDb.collection('analytics_events').where('at', '>=', cutoff).get();
    const events = snap.docs.map(d => d.data());

    const byEvent = {};
    const byUser  = {};
    events.forEach(e => {
      byEvent[e.event] = (byEvent[e.event] || 0) + 1;
      if (!byUser[e.uid]) byUser[e.uid] = new Set();
      byUser[e.uid].add(e.event);
    });
    const uniqueByEvent = {};
    Object.values(byUser).forEach(s => s.forEach(evt => { uniqueByEvent[evt] = (uniqueByEvent[evt] || 0) + 1; }));

    const FUNNEL = ['page_view','guide_started','photo_uploaded','step_completed','guide_completed','paywall_viewed','checkout_started','checkout_completed'];
    const funnel = FUNNEL.map((evt, i) => {
      const count = uniqueByEvent[evt] || 0;
      const prev  = i > 0 ? (uniqueByEvent[FUNNEL[i-1]] || 0) : count;
      return { event: evt, count, pct: prev > 0 ? Math.round((count/prev)*100) : null };
    });

    const FEATURES = ['low_taper','mid_taper','high_taper','skin_fade','buzz_cut','grade_fade','fade_finish','barber_report','ai_chat'];
    const features = FEATURES.map(f => ({
      feature: f,
      uses: byEvent[`feature_${f}`] || 0,
      unique: uniqueByEvent[`feature_${f}`] || 0,
    }));

    res.json({ funnel, features, totalEvents: events.length, uniqueUsers: Object.keys(byUser).length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── FOUNDER: USER SEARCH ──────────────────────────────────────────────────────
app.post('/founder/users/search', requireAuth, founderRateLimit, requireOwner, async (req, res) => {
  if (!adminDb) return res.status(503).json({ error: 'Firebase Admin SDK required.' });
  const { q } = req.body || {};
  try {
    let docs = [];
    if (q?.includes('@')) {
      const snap = await adminDb.collection('users').where('email', '==', q.trim().toLowerCase()).limit(10).get();
      docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (docs.length === 0) {
        try {
          const au = await admin.auth().getUserByEmail(q.trim());
          const d  = await adminDb.collection('users').doc(au.uid).get();
          docs = [{ id: au.uid, email: au.email, displayName: au.displayName, ...(d.exists ? d.data() : {}) }];
        } catch(e2) {}
      }
    } else if (q) {
      const d = await adminDb.collection('users').doc(q.trim()).get();
      if (d.exists) docs = [{ id: d.id, ...d.data() }];
    } else {
      const snap = await adminDb.collection('users').orderBy('createdAt', 'desc').limit(25).get();
      docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }
    const now = Date.now();
    const safe = docs.map(({ id, email, displayName, credits, createdAt, disabled, promoAccess, freeGuideUsed }) => ({
      id, email, displayName, credits: credits || 0, createdAt: createdAt || null,
      disabled: !!disabled, hasPromo: !!(promoAccess?.expiresAt > now), freeGuideUsed: !!freeGuideUsed,
    }));
    res.json({ users: safe });
  } catch(e) {
    console.error('[/founder/users/search]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── FOUNDER: USER DETAIL ──────────────────────────────────────────────────────
app.get('/founder/users/:uid', requireAuth, founderRateLimit, requireOwner, async (req, res) => {
  if (!adminDb) return res.status(503).json({ error: 'Firebase Admin SDK required.' });
  try {
    const uid = req.params.uid;
    const [doc, authUser, eventsSnap, failSnap] = await Promise.all([
      adminDb.collection('users').doc(uid).get(),
      admin.auth().getUser(uid).catch(() => null),
      adminDb.collection('analytics_events').where('uid','==',uid).orderBy('at','desc').limit(20).get(),
      adminDb.collection('failure_logs').where('uid','==',uid).orderBy('at','desc').limit(10).get(),
    ]);
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });
    const d = doc.data();
    res.json({
      id: uid,
      email: authUser?.email || d.email,
      displayName: authUser?.displayName || d.displayName,
      emailVerified: authUser?.emailVerified ?? false,
      credits: d.credits || 0,
      createdAt: d.createdAt || null,
      disabled: !!d.disabled,
      disabledReason: d.disabledReason || null,
      promoAccess: d.promoAccess || null,
      freeGuideUsed: !!d.freeGuideUsed,
      freeGuideExpiresAt: d.freeGuideExpiresAt || null,
      recentEvents: eventsSnap.docs.map(d => d.data()),
      recentFailures: failSnap.docs.map(d => d.data()),
    });
  } catch(e) {
    console.error('[/founder/users/:uid]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── FOUNDER: GRANT / REMOVE CREDITS ──────────────────────────────────────────
app.post('/founder/users/grant', requireAuth, founderRateLimit, requireOwner, async (req, res) => {
  if (!adminDb) return res.status(503).json({ error: 'Firebase Admin SDK required.' });
  const { uid, delta, reason } = req.body || {};
  if (!uid || typeof delta !== 'number') return res.status(400).json({ error: 'uid and delta required' });
  try {
    const ref  = adminDb.collection('users').doc(uid);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'User not found' });
    const newBal = Math.max(0, (snap.data().credits || 0) + delta);
    await ref.update({ credits: newBal });
    console.log(`[Founder] grant uid=${uid} delta=${delta} reason=${reason||'-'} newBal=${newBal}`);
    res.json({ ok: true, credits: newBal });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FOUNDER: DISABLE / RESTORE ACCOUNT ───────────────────────────────────────
app.post('/founder/users/disable', requireAuth, founderRateLimit, requireOwner, async (req, res) => {
  if (!adminDb) return res.status(503).json({ error: 'Firebase Admin SDK required.' });
  const { uid, disabled, reason } = req.body || {};
  if (!uid || typeof disabled !== 'boolean') return res.status(400).json({ error: 'uid and disabled required' });
  try {
    await Promise.all([
      adminDb.collection('users').doc(uid).update({ disabled, disabledReason: reason || null }),
      admin.auth().updateUser(uid, { disabled }),
    ]);
    console.log(`[Founder] ${disabled?'DISABLED':'RESTORED'} uid=${uid} reason=${reason||'-'}`);
    res.json({ ok: true, disabled });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FOUNDER: FAILURE LOGS ─────────────────────────────────────────────────────
app.get('/founder/logs', requireAuth, founderRateLimit, requireOwner, async (req, res) => {
  if (!adminDb) return res.status(503).json({ error: 'Firebase Admin SDK required.' });
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const snap  = await adminDb.collection('failure_logs').orderBy('at', 'desc').limit(limit).get();
    res.json({ logs: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FOUNDER: FEEDBACK LIST ────────────────────────────────────────────────────
app.get('/founder/feedback', requireAuth, founderRateLimit, requireOwner, async (req, res) => {
  if (!adminDb) return res.status(503).json({ error: 'Firebase Admin SDK required.' });
  try {
    const { status } = req.query;
    let q = adminDb.collection('feedback').orderBy('at', 'desc').limit(100);
    if (status) q = adminDb.collection('feedback').where('status','==',status).orderBy('at','desc').limit(100);
    const snap = await q.get();
    res.json({ feedback: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FOUNDER: UPDATE FEEDBACK STATUS ──────────────────────────────────────────
app.patch('/founder/feedback/:id', requireAuth, founderRateLimit, requireOwner, async (req, res) => {
  if (!adminDb) return res.status(503).json({ error: 'Firebase Admin SDK required.' });
  const { status } = req.body || {};
  if (!['new','reviewing','fixed','declined'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    await adminDb.collection('feedback').doc(req.params.id).update({ status });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FOUNDER: SYSTEM HEALTH ────────────────────────────────────────────────────
app.get('/founder/health', requireAuth, founderRateLimit, requireOwner, (req, res) => {
  const uptimeMs = Date.now() - _health.startedAt;
  const routes   = Object.entries(_health.byRoute).map(([route, r]) => ({
    route,
    requests: r.count,
    errors:   r.errors,
    errorRate: r.count > 0 ? +((r.errors / r.count) * 100).toFixed(1) : 0,
    avgMs:    r.count > 0 ? Math.round(r.totalMs / r.count) : 0,
  })).sort((a, b) => b.requests - a.requests);

  res.json({
    uptime:       uptimeMs,
    uptimeHuman:  `${Math.floor(uptimeMs/3600000)}h ${Math.floor((uptimeMs%3600000)/60000)}m`,
    startedAt:    _health.startedAt,
    authFails:    _health.authFails,
    webhookFails: _health.webhookFails,
    routes,
    recentErrors: _health.recentErrors.slice(0, 30),
    env: {
      firebase:   !!adminDb,
      anthropic:  !!process.env.ANTHROPIC_API_KEY,
      stripe:     !!process.env.STRIPE_SECRET_KEY,
      ownerEmail: !!process.env.OWNER_EMAIL,
    },
  });
});

// ── FOUNDER: AI REQUEST LOG ────────────────────────────────────────────────────
app.get('/founder/ai-requests', requireAuth, founderRateLimit, requireOwner, async (req, res) => {
  if (!adminDb) return res.status(503).json({ error: 'Firebase Admin SDK required.', detail: _adminInitError });
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const snap   = await adminDb.collection('ai_requests')
      .orderBy('at', 'desc')
      .limit(limit)
      .get();
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ items });
  } catch(e) {
    console.error('[/founder/ai-requests]', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SelfHaircut.ai backend running on port ${PORT}`));
