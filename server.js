const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const fetch   = require('node-fetch');
const OpenAI  = require('openai');
const { toFile } = require('openai');

const app    = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());

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

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/analyze', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No photo uploaded' });
    }

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

    const data = await response.json();

    if (data.error) {
      return res.status(500).json({ error: data.error.message });
    }

    const raw    = data.content.map(c => c.text || '').join('');
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());

    res.json(parsed);

  } catch (err) {
    console.error('[/analyze error]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── TAPER PREVIEW GENERATION ──
app.post('/generate-preview', upload.single('photo'), async (req, res) => {
  console.log('[/generate-preview] Request received');

  try {
    if (!req.file) {
      console.error('[/generate-preview] No photo in request');
      return res.status(400).json({ error: 'No photo uploaded' });
    }

    console.log('[/generate-preview] Cropped image received —', req.file.originalname || 'crop.jpg',
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
      console.error('[/generate-preview] OpenAI returned no image data:', JSON.stringify(result).slice(0, 300));
      return res.status(500).json({ error: 'No image data in OpenAI response' });
    }

    const previewUrl = `data:image/png;base64,${b64}`;
    console.log('[/generate-preview] Preview image returned to frontend —',
      `${(b64.length / 1024).toFixed(0)} KB base64`);

    res.json({ previewUrl });

  } catch (err) {
    console.error('[/generate-preview] Generation failed:', err.status || '', err.message);
    if (err.error) console.error('[/generate-preview] OpenAI error detail:', JSON.stringify(err.error));
    res.status(500).json({ error: err.message, detail: err.error || null });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SelfHaircut.ai backend running on port ${PORT}`));
