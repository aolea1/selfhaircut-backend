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
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    admin = require('firebase-admin');
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });
    adminDb = admin.firestore();
    console.log('[Firebase Admin] Initialized ✓');
  }
} catch(e) {
  console.warn('[Firebase Admin] Unavailable — using REST API fallback:', e.message);
  admin = null; adminDb = null;
}

// ── FIREBASE REST HELPERS ─────────────────────────────────────────────────────
// Verify a Firebase ID token and return { uid, email }
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
  return { uid: user.localId, email: user.email || '' };
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
      // Admin SDK path
      req.user    = await admin.auth().verifyIdToken(token);
      req.idToken = token;
    } else {
      // REST API path
      req.user    = await verifyFirebaseToken(token);
      req.idToken = token;
    }
    next();
  } catch(e) {
    console.error('[Auth] Failed:', e.message);
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

// ── ANALYZE ───────────────────────────────────────────────────────────────────
app.post('/analyze', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });
    const base64    = req.file.buffer.toString('base64');
    const mediaType = req.file.mimetype || 'image/jpeg';
    const response  = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514', max_tokens: 1000, system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text',  text: 'Place the low taper guide line just below the sideburn. Return only JSON.' },
        ]}],
      }),
    });
    const data   = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    const raw    = data.content.map(c => c.text || '').join('');
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    res.json(parsed);
  } catch(err) {
    console.error('[/analyze]', err);
    res.status(500).json({ error: err.message });
  }
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
      await fsPatch('users', uid, { promoAccess: toFsFields(promoAccess).promoAccess }, token);
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

  try {
    let userData = {};
    if (adminDb) {
      const snap = await adminDb.collection('users').doc(uid).get();
      userData   = snap.exists ? snap.data() : {};
    } else {
      const snap = await fsGet('users', uid, token);
      userData   = snap ? fromFsFields(snap.fields || {}) : {};
    }

    const pa = userData.promoAccess;
    if (pa && pa.expiresAt > Date.now()) {
      return res.json({ credits: userData.credits ?? 0, promoActive: true, promoAccess: pa });
    }
    if (promoOnly) return res.json({ credits: userData.credits ?? 0, promoExpired: true });

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

// ── SEND EMAIL ────────────────────────────────────────────────────────────────
app.post('/send-email', async (req, res) => {
  const { to, subject } = req.body || {};
  console.log(`[/send-email] to=${to} subject="${subject}"`);
  res.json({ ok: true });
});

// ── CHAT ──────────────────────────────────────────────────────────────────────
const CHAT_SYSTEM = `You are SelfHaircut.ai, an expert AI barber assistant. You help people cut their own hair at home — primarily tapers, fades, buzz cuts, and lineups.

Answer any question the user asks. For haircut questions, give clear, specific, actionable advice. For off-topic questions, answer helpfully and naturally, then gently bring the conversation back to haircuts if relevant.

Keep responses concise — 2–4 sentences for simple questions, up to a short paragraph for complex ones. Use plain text, no markdown. Be warm, confident, and direct.`;

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SelfHaircut.ai backend running on port ${PORT}`));
