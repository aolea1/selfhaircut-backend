const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const fetch   = require('node-fetch');

const app    = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());

// ── FIREBASE ADMIN (optional — server starts even if this fails) ──
// Set FIREBASE_SERVICE_ACCOUNT env var to the full JSON string of your service account key.
// Download from: Firebase Console → Project Settings → Service Accounts → Generate new private key
let admin = null;
let db    = null;
try {
  admin = require('firebase-admin');
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    db = admin.firestore();
    console.log('[Firebase] Admin SDK initialized ✓');
  } else {
    console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT not set — /redeem-code and /use-credit require it');
  }
} catch(e) {
  console.error('[Firebase] Admin SDK unavailable:', e.message);
  admin = null;
  db    = null;
}

// ── OPENAI (optional — preview endpoint disabled if key missing) ──
let openai  = null;
let toFile  = null;
try {
  const OpenAI = require('openai');
  toFile  = OpenAI.toFile;
  openai  = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  console.log('[OpenAI] Client initialized ✓');
} catch(e) {
  console.error('[OpenAI] Client unavailable:', e.message);
}

// Verify Firebase ID token (used by /redeem-code and /use-credit)
async function requireAuth(req, res, next) {
  if (!admin) return res.status(503).json({ error: 'Auth service not configured' });
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch(e) {
    console.error('[Auth] Token verification failed:', e.message);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

const SYSTEM_PROMPT = `You are SelfHaircut.ai, an expert AI barber assistant specializing in self-haircuts.

When given a side profile photo, your PRIMARY task is to:
1. Locate the sideburn — the strip of hair growing in front of the ear, between the ear and the face
2. Find the BOTTOM EDGE of the sideburn (where it ends and bare skin begins)
3. Place the taper/fade guide line just below that sideburn bottom edge

Return ONLY a valid JSON object with no extra text or markdown:
{
  "tapperLineY": <0.3-0.75>,
  "tapperLineStartX": <0.05-0.45>,
  "tapperLineEndX": <0.5-0.95>,
  "fadeZoneHeight": <0.08-0.18>,
  "taperType": <"low"|"mid"|"high">,
  "sideburnBottomY": <0.3-0.75>,
  "advice": <2-3 sentences>,
  "confidence": <"high"|"medium"|"low">
}`;

const PREVIEW_PROMPT =
  'Give this person a clean low taper fade and a natural sharp lineup. ' +
  'Keep absolutely everything else exactly the same: face, skin tone, expression, head shape, ' +
  'ear position, pose, lighting, background, clothing, beard, and any jewelry. ' +
  'Only the hair changes. The taper should be realistic and achievable — ' +
  'hair fades naturally to skin at the ear and neckline and blends upward to ' +
  'the natural length on top. Not overly perfect or celebrity-barber level, ' +
  'just a clean everyday barbershop result.';

// ── HEALTH ──
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    firebase: !!db,
    openai:   !!openai && !!process.env.OPENAI_API_KEY,
  });
});

// ── ANALYZE ──
app.post('/analyze', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });

    const base64    = req.file.buffer.toString('base64');
    const mediaType = req.file.mimetype || 'image/jpeg';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system:     SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text',  text: 'Locate the sideburn and place the low taper guide line just below it. Return only the JSON.' },
          ],
        }],
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    const raw    = data.content.map(c => c.text || '').join('');
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    res.json(parsed);

  } catch(err) {
    console.error('[/analyze]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GENERATE PREVIEW ──
app.post('/generate-preview', upload.single('photo'), async (req, res) => {
  console.log('[/generate-preview] Request received');
  try {
    if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });

    console.log('[/generate-preview] Cropped image received —',
      req.file.originalname || 'crop.jpg',
      `${(req.file.size / 1024).toFixed(1)} KB`, req.file.mimetype);

    if (!openai || !process.env.OPENAI_API_KEY) {
      console.error('[/generate-preview] OPENAI_API_KEY not set or openai client unavailable');
      return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
    }

    console.log('[/generate-preview] Sending image to OpenAI gpt-image-1');

    const imageFile = await toFile(
      req.file.buffer,
      req.file.originalname || 'photo.jpg',
      { type: req.file.mimetype || 'image/jpeg' }
    );

    const result = await openai.images.edit({
      model:  'gpt-image-1',
      image:  imageFile,
      prompt: PREVIEW_PROMPT,
      n:      1,
      size:   '1024x1024',
    });

    console.log('[/generate-preview] AI response received');

    const b64 = result.data[0]?.b64_json;
    if (!b64) {
      console.error('[/generate-preview] No image data:', JSON.stringify(result).slice(0, 200));
      return res.status(500).json({ error: 'No image data in OpenAI response' });
    }

    console.log('[/generate-preview] Returning preview to frontend —', `${(b64.length / 1024).toFixed(0)} KB`);
    res.json({ previewUrl: `data:image/png;base64,${b64}` });

  } catch(err) {
    console.error('[/generate-preview] Failed:', err.status || '', err.message);
    if (err.error) console.error('[/generate-preview] Detail:', JSON.stringify(err.error));
    res.status(500).json({ error: err.message, detail: err.error || null });
  }
});

// ── REDEEM CODE ──
app.post('/redeem-code', requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database not configured — set FIREBASE_SERVICE_ACCOUNT' });

  const uid  = req.user.uid;
  const code = (req.body.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'No code provided' });
  console.log(`[/redeem-code] uid=${uid} code=${code}`);

  try {
    // 1. Look up promo code
    const codeSnap = await db.collection('promoCodes').doc(code).get();
    if (!codeSnap.exists) {
      console.log(`[/redeem-code] Not found: ${code}`);
      return res.status(404).json({ error: 'invalid_code', message: "That code isn't valid." });
    }
    const promo = codeSnap.data();
    if (!promo.active) {
      return res.status(403).json({ error: 'inactive', message: 'That code is no longer active.' });
    }

    // 2. Check if already redeemed
    const userSnap = await db.collection('users').doc(uid).get();
    const userData  = userSnap.exists ? userSnap.data() : {};
    if (userData.promoAccess && userData.promoAccess.code === code) {
      return res.status(409).json({ error: 'already_redeemed', message: "You've already redeemed this code." });
    }

    // 3. Write promoAccess
    const now         = Date.now();
    const expiresAt   = now + (promo.duration_ms || 86400000);
    const promoAccess = { code, redeemedAt: now, expiresAt };

    await db.collection('users').doc(uid).set({ promoAccess }, { merge: true });
    console.log(`[/redeem-code] Success — uid=${uid} expires ${new Date(expiresAt).toISOString()}`);
    res.json({ success: true, promoAccess });

  } catch(err) {
    console.error('[/redeem-code]', err.message);
    res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// ── USE CREDIT ──
app.post('/use-credit', requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database not configured' });

  const uid       = req.user.uid;
  const promoOnly = req.body?.promoOnly === true;

  try {
    const userRef  = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    const userData = userSnap.exists ? userSnap.data() : {};

    // Active promo → no deduction
    const pa = userData.promoAccess;
    if (pa && pa.expiresAt > Date.now()) {
      console.log(`[/use-credit] Promo active uid=${uid}`);
      return res.json({ credits: userData.credits ?? 0, promoActive: true, promoAccess: pa });
    }

    if (promoOnly) {
      return res.json({ credits: userData.credits ?? 0, promoExpired: true });
    }

    const current = userData.credits ?? 0;
    if (current <= 0) {
      return res.status(402).json({ error: 'no_credits', credits: 0 });
    }

    await userRef.update({ credits: admin.firestore.FieldValue.increment(-1) });
    console.log(`[/use-credit] Deducted — uid=${uid} remaining=${current - 1}`);
    res.json({ credits: current - 1 });

  } catch(err) {
    console.error('[/use-credit]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── SEND EMAIL ──
app.post('/send-email', async (req, res) => {
  const { to, subject, text } = req.body || {};
  console.log(`[/send-email] to=${to} subject="${subject}"`);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SelfHaircut.ai backend running on port ${PORT}`));
