const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');

const app = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());

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

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/analyze', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No photo uploaded' });
    }

    const base64 = req.file.buffer.toString('base64');
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

    const raw = data.content.map(c => c.text || '').join('');
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());

    res.json(parsed);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SelfHaircut.ai backend running on port ${PORT}`));
