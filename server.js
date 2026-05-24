const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');

const app = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());

const SYSTEM_PROMPT = `You are SelfHaircut.ai, an expert AI barber assistant. When given a side profile photo of a person's head, analyze it and return ONLY a JSON object with no extra text or markdown.

JSON structure:
{
  "tapperLineY": <0.3-0.7, vertical position of bald line as fraction of image height>,
  "tapperLineStartX": <0.0-0.5, where line starts horizontally>,
  "tapperLineEndX": <0.5-1.0, where line ends horizontally>,
  "fadeZoneHeight": <0.05-0.2, height of fade zone as fraction of image height>,
  "taperType": <"low", "mid", or "high">,
  "advice": <2-3 sentence plain text tip for this specific cut>,
  "confidence": <"high", "medium", or "low">
}

Analyze the ear position, temple, and natural hairline. If photo is unclear, set confidence to "low" and use defaults (tapperLineY:0.5, startX:0.2, endX:0.8, fadeZoneHeight:0.1).`;

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
            { type: 'text', text: 'Analyze this side profile and return only the JSON.' }
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
