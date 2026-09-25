const express = require('express');
const path = require('path');
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json());

// Prevent browsers from caching the HTML shell / manifest / version files
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html') || req.path === '/manifest.json' || req.path === '/version.json') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const SYSTEM_PROMPTS = {
  ru: (level) => `Sen — rus tilini mashq qilish uchun do'stona suhbatdoshsan. Suhbatdoshingning darajasi ${level} (CEFR shkalasi bo'yicha). FAQAT rus tilida gaplash, ${level} darajasiga mos so'z boyligi va grammatikadan foydalan. Javoblaringni qisqa tut (2-3 gap). Jiddiy xatolarni muloyimlik bilan tuzat, lekin ortiqcha tanqid qilma. Iliq va rag'batlantiruvchi bo'l.`,
  en: (level) => `You are a friendly conversation partner for English practice. Your partner's level is ${level} (CEFR scale). Speak ONLY in English, using vocabulary and grammar appropriate for ${level} level. Keep your responses short (2-3 sentences). Gently correct serious mistakes, but don't be overly critical. Be warm and encouraging.`
};

app.post('/api/chat', async (req, res) => {
  try {
    const { message, history, language, level } = req.body || {};
    if (!message || !language || !level) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'API kalit sozlanmagan (ANTHROPIC_API_KEY topilmadi)' });
    }
    const promptFn = SYSTEM_PROMPTS[language] || SYSTEM_PROMPTS.en;
    const systemPrompt = promptFn(level);
    const trimmedHistory = Array.isArray(history) ? history.slice(-10) : [];
    const messages = trimmedHistory.concat([{ role: 'user', content: String(message).slice(0, 1000) }]);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 220,
        system: systemPrompt,
        messages
      })
    });
    const data = await response.json();
    if (data.error) {
      console.error('Anthropic API error:', data.error);
      return res.status(500).json({ error: 'AI xizmatida xatolik yuz berdi.' });
    }
    const reply = (data.content && data.content[0] && data.content[0].text) || '';
    res.json({ reply });
  } catch (e) {
    console.error('Chat proxy error:', e);
    res.status(500).json({ error: 'Server xatoligi.' });
  }
});

app.post('/api/extract-text', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Fayl topilmadi' });
    const { originalname, buffer, mimetype } = req.file;
    const nameLower = (originalname || '').toLowerCase();
    let text = '';
    if (mimetype === 'application/pdf' || nameLower.endsWith('.pdf')) {
      const data = await pdfParse(buffer);
      text = data.text;
    } else if (nameLower.endsWith('.docx') || (mimetype && mimetype.includes('word'))) {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } else {
      return res.status(400).json({ error: "Faqat PDF yoki DOCX fayllar qo'llab-quvvatlanadi" });
    }
    text = (text || '').trim();
    if (!text) return res.status(400).json({ error: "Fayldan matn topilmadi (skanerlangan rasm bo'lishi mumkin)" });
    res.json({ text: text.slice(0, 60000) });
  } catch (e) {
    console.error('extract-text error:', e);
    res.status(500).json({ error: 'Fayldan matn olishda xatolik yuz berdi.' });
  }
});

app.post('/api/generate-flashcards', async (req, res) => {
  try {
    const { text, count } = req.body || {};
    if (!text) return res.status(400).json({ error: 'Matn kerak' });
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'API kalit sozlanmagan (ANTHROPIC_API_KEY topilmadi)' });
    }
    const n = Math.min(Math.max(Number(count) || 20, 5), 50);
    const prompt = `Quyidagi matn asosida ${n} ta flashcard (lug'at/bilim kartochkasi) tuz. Har bir kartochka {"front": "so'z, ibora yoki savol", "back": "tarjimasi yoki javobi (o'zbek tilida tushuntir)"} ko'rinishida bo'lsin. Matndagi eng muhim va foydali so'z/tushunchalarni tanla. FAQAT JSON massiv qaytar, boshqa hech qanday matn, izoh yoki \`\`\` belgisi qo'shma.\n\nMatn:\n${String(text).slice(0, 10000)}`;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 3500,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    if (data.error) {
      console.error('Anthropic API error:', data.error);
      return res.status(500).json({ error: 'AI xizmatida xatolik yuz berdi.' });
    }
    let raw = (data.content && data.content[0] && data.content[0].text) || '[]';
    raw = raw.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
    let cards = [];
    try { cards = JSON.parse(raw); } catch (e) { console.error('flashcard JSON parse error', e, raw); }
    if (!Array.isArray(cards)) cards = [];
    res.json({ cards });
  } catch (e) {
    console.error('generate-flashcards error:', e);
    res.status(500).json({ error: 'Server xatoligi.' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Pushkina site running on port ${PORT}`));
