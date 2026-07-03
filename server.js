const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const fetch   = require('node-fetch');
const OpenAI  = require('openai');
const { toFile } = require('openai');
const admin   = require('firebase-admin');

const app    = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());

// ── FIREBASE ADMIN ──
// Set FIREBASE_SERVICE_ACCOUNT env var to the full JSON string of your service account key.
// Download it from: Firebase Console → Project Settings → Service Accounts → Generate new private key
let db = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    db = admin.firestore();
    console.log('[Firebase] Admin SDK initialized ✓');
  } else {
    console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT not set — /redeem-code and /use-credit will be unavailable');
  }
} catch(e) {
  console.error('[Firebase] Admin SDK init failed:', e.message);
}

// Middleware to verify Firebase ID token
async function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are SelfHaircut.ai, an expert AI barber assistant specializing in self-haircuts.

When given a side profile photo, your PRIMARY task is to:
1. Locate the sideburn — the strip of hair growing in front of the ear, between the ear and the face
2. Find the BOTTOM EDGE of the sideburn (where it ends and bare skin begins)
3. Place the taper/fade guide line just below that sideburn bottom edge

This sideburn-anchored approach gives the most natural, accurate low taper line for the person's specific face.

Return ONLY a valid JSON object with no extra text or markdown:
{
  "tapperLineY": <0.3-0.75, Y position of guide line as fraction of image height. Anchor this to just below the sideburn bottom edge>,
  "tapperLineStartX": <0.05-0.45, where line starts — from the temple/sideburn front>,
  "tapperLineEndX": <0.5-0.95, where line ends — past the ear>,
  "fadeZoneHeight": <0.08-0.18, height of the fade blend zone above the line>,
  "taperType": <"low", "mid", or "high" — based on where sideburn sits>,
  "sideburnBottomY": <0.3-0.75, exact Y fraction where sideburn ends>,
  "advice": <2-3 sentences of specific advice referencing their sideburn position and recommended guard numbers>,
  "confidence": <"high", "medium", or "low">
}

If no sideburn is clearly visible, estimate based on ear position and note it in advice.`;

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
  res.json({ status: 'ok', firebase: !!db, openai: !!process.env.OPENAI_API_KEY });
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
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: 'Locate the sideburn in this photo and place the low taper guide line just below it. Return only the JSON.' }
          ]
        }]
      })
    });

    const data   = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    const raw    = data.content.map(c => c.text || '').join('');
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    res.json(parsed);

  } catch (err) {
    console.error('[/analyze error]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GENERATE PREVIEW ──
app.post('/generate-preview', upload.single('photo'), async (req, res) => {
  console.log('[/generate-preview] Request received');
  try {
    if (!req.file) {
      console.error('[/generate-preview] No photo in request');
      return res.status(400).json({ error: 'No photo uploaded' });
    }
    console.log('[/generate-preview] Cropped image received —',
      req.file.originalname || 'crop.jpg',
      `${(req.file.size / 1024).toFixed(1)} KB`, req.file.mimetype);

    if (!process.env.OPENAI_API_KEY) {
      console.error('[/generate-preview] OPENAI_API_KEY is not set');
      return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
    }

    console.log('[/generate-preview] Sending image to OpenAI image edit API (gpt-image-1)');
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

    console.log('[/generate-preview] AI preview response received from OpenAI');

    const b64 = result.data[0]?.b64_json;
    if (!b64) {
      console.error('[/generate-preview] No image data in response:', JSON.stringify(result).slice(0, 300));
      return res.status(500).json({ error: 'No image data returned' });
    }

    const previewUrl = `data:image/png;base64,${b64}`;
    console.log('[/generate-preview] Preview image returned to frontend —',
      `${(b64.length / 1024).toFixed(0)} KB base64`);

    res.json({ previewUrl });

  } catch (err) {
    console.error('[/generate-preview] Failed:', err.status || '', err.message);
    if (err.error) console.error('[/generate-preview] OpenAI detail:', JSON.stringify(err.error));
    res.status(500).json({ error: err.message, detail: err.error || null });
  }
});

// ── REDEEM CODE ──
// Validates a promo code server-side (code never exposed to frontend).
// Promo codes live in Firestore: promoCodes/{CODE} = { active, duration_ms, description }
// Seed the OLEA doc manually in Firebase Console or via the Admin SDK.
app.post('/redeem-code', requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database not configured' });

  const uid  = req.user.uid;
  const code = (req.body.code || '').trim().toUpperCase();

  if (!code) return res.status(400).json({ error: 'No code provided' });
  console.log(`[/redeem-code] uid=${uid} code=${code}`);

  try {
    // 1. Look up the promo code
    const codeSnap = await db.collection('promoCodes').doc(code).get();
    if (!codeSnap.exists) {
      console.log(`[/redeem-code] Code not found: ${code}`);
      return res.status(404).json({ error: 'invalid_code', message: 'That code isn\'t valid.' });
    }

    const promo = codeSnap.data();
    if (!promo.active) {
      console.log(`[/redeem-code] Code inactive: ${code}`);
      return res.status(403).json({ error: 'inactive', message: 'That code is no longer active.' });
    }

    // 2. Check if this user already redeemed this code
    const userSnap = await db.collection('users').doc(uid).get();
    const userData  = userSnap.exists ? userSnap.data() : {};
    if (userData.promoAccess && userData.promoAccess.code === code) {
      console.log(`[/redeem-code] Already redeemed by uid=${uid}`);
      return res.status(409).json({ error: 'already_redeemed', message: 'You\'ve already redeemed this code.' });
    }

    // 3. Write promoAccess to the user doc
    const now       = Date.now();
    const expiresAt = now + (promo.duration_ms || 86400000);
    const promoAccess = { code, redeemedAt: now, expiresAt };

    await db.collection('users').doc(uid).set({ promoAccess }, { merge: true });
    console.log(`[/redeem-code] Redeemed — uid=${uid} code=${code} expiresAt=${new Date(expiresAt).toISOString()}`);

    res.json({ success: true, promoAccess });

  } catch(err) {
    console.error('[/redeem-code] Error:', err.message);
    res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// ── USE CREDIT ──
// Deducts 1 credit (or passes through if promo is active).
// Called by the frontend before generating a guide.
app.post('/use-credit', requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database not configured' });

  const uid        = req.user.uid;
  const promoOnly  = req.body?.promoOnly === true;

  try {
    const userRef  = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    const userData = userSnap.exists ? userSnap.data() : {};

    // Check active promo
    const promo = userData.promoAccess;
    if (promo && promo.expiresAt > Date.now()) {
      console.log(`[/use-credit] Promo active for uid=${uid} — no deduction`);
      return res.json({ credits: userData.credits ?? 0, promoActive: true, promoAccess: promo });
    }

    // Promo expired or promoOnly request
    if (promoOnly) {
      console.log(`[/use-credit] promoOnly=true but promo expired for uid=${uid}`);
      return res.json({ credits: userData.credits ?? 0, promoExpired: true });
    }

    const current = userData.credits ?? 0;
    if (current <= 0) {
      console.log(`[/use-credit] No credits for uid=${uid}`);
      return res.status(402).json({ error: 'no_credits', credits: 0 });
    }

    await userRef.update({ credits: admin.firestore.FieldValue.increment(-1) });
    const newCredits = current - 1;
    console.log(`[/use-credit] Deducted 1 credit for uid=${uid} — remaining: ${newCredits}`);
    res.json({ credits: newCredits });

  } catch(err) {
    console.error('[/use-credit] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── SEND EMAIL (existing, kept for compatibility) ──
app.post('/send-email', async (req, res) => {
  // Lightweight stub — swap in your email provider (Resend, SendGrid, etc.)
  const { to, subject, text } = req.body || {};
  console.log(`[/send-email] to=${to} subject="${subject}"`);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SelfHaircut.ai backend running on port ${PORT}`));
