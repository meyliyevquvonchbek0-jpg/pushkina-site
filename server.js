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


// ============ TELEGRAM (token faqat serverda) ============
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.TOKEN || '';
const SB_URL = process.env.SUPABASE_URL || 'https://nyyspriexqbulupofeoo.supabase.co';
const SB_KEY = process.env.SUPABASE_KEY || 'sb_publishable_R0pt22Bd2HkLGkC9omlHTQ_Wg9A1ta2';
let tgAllowed = { at: 0, ids: new Set() };
async function loadAllowedChats(){
  if (Date.now() - tgAllowed.at < 60000) return tgAllowed.ids;
  const ids = new Set();
  const get = async (path) => {
    const r = await fetch(SB_URL + '/rest/v1/' + path, { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } });
    return r.ok ? r.json() : [];
  };
  try {
    (await get('students?select=telegram_chat_id')).forEach(x => x.telegram_chat_id && ids.add(String(x.telegram_chat_id)));
    (await get('teachers?select=telegram_chat_id')).forEach(x => x.telegram_chat_id && ids.add(String(x.telegram_chat_id)));
    (await get('settings?select=admin_telegram_chat_id')).forEach(x => x.admin_telegram_chat_id && ids.add(String(x.admin_telegram_chat_id)));
    tgAllowed = { at: Date.now(), ids };
  } catch (e) { console.error('allowed chats', e); }
  return tgAllowed.ids;
}
const tgHits = new Map();
app.post('/api/telegram', async (req, res) => {
  if (!TG_TOKEN) return res.status(503).json({ ok: false, error: 'Bot token serverda sozlanmagan' });
  const ip = req.headers['x-forwarded-for'] || req.ip || 'x';
  const now = Date.now();
  const arr = (tgHits.get(ip) || []).filter(t => now - t < 60000);
  if (arr.length >= 120) return res.status(429).json({ ok: false, error: 'Juda ko\'p so\'rov' });
  arr.push(now); tgHits.set(ip, arr);
  const chatId = String((req.body && req.body.chat_id) || '');
  const text = String((req.body && req.body.text) || '').slice(0, 3500);
  if (!chatId || !text) return res.status(400).json({ ok: false });
  const allowed = await loadAllowedChats();
  if (!allowed.has(chatId)) return res.status(403).json({ ok: false, error: 'Ruxsat etilmagan chat' });
  try {
    const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    res.json(await r.json());
  } catch (e) { console.error('telegram', e); res.status(502).json({ ok: false }); }
});


// ============ OCHIQ DARS (Daily.co) — kalit faqat serverda ============
const DAILY_KEY = process.env.DAILY_API_KEY || '';
const DAILY_BASE = process.env.DAILY_API_BASE || 'https://api.daily.co/v1';
const dailyHits = new Map();
function dailyLimit(req, res, max) {
  const ip = String(req.headers['x-forwarded-for'] || req.ip || 'x').split(',')[0].trim();
  const now = Date.now();
  const arr = (dailyHits.get(ip) || []).filter(t => now - t < 3600000);
  if (arr.length >= max) { res.status(429).json({ ok: false, error: "Juda ko'p urinish. Birozdan keyin qayta urinib ko'ring." }); return false; }
  arr.push(now); dailyHits.set(ip, arr); return true;
}
async function dailyApi(method, path, body) {
  const r = await fetch(DAILY_BASE + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + DAILY_KEY },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null; try { data = await r.json(); } catch (e) {}
  return { ok: r.ok, status: r.status, data };
}
function dailyReady(res) {
  if (!DAILY_KEY) { res.status(503).json({ ok: false, error: "Daily.co hali sozlanmagan. Railway'da DAILY_API_KEY qo'shilishi kerak." }); return false; }
  return true;
}
async function isStaff(userId) {
  if (!userId) return false;
  try {
    const r = await fetch(SB_URL + '/rest/v1/users_public?select=role,status&id=eq.' + encodeURIComponent(userId), { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } });
    if (!r.ok) return false;
    const rows = await r.json();
    return !!(rows[0] && (rows[0].role === 'teacher' || rows[0].role === 'admin') && rows[0].status !== 'pending');
  } catch (e) { return false; }
}
function cleanName(n, fallback) { return String(n || '').replace(/[<>"'\\]/g, '').trim().slice(0, 40) || fallback; }
function cleanRoom(r) { r = String(r || ''); return /^[a-z0-9-]{6,40}$/.test(r) ? r : ''; }
const DAILY_HOURS = 4;

app.post('/api/daily/start', async (req, res) => {
  if (!dailyReady(res)) return;
  if (!dailyLimit(req, res, 30)) return;
  const { userId, name } = req.body || {};
  if (!(await isStaff(userId))) return res.status(403).json({ ok: false, error: "Faqat ustoz yoki admin ochiq dars yarata oladi." });
  const exp = Math.floor(Date.now() / 1000) + DAILY_HOURS * 3600;
  const room = 'pk-' + Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);
  try {
    let r = await dailyApi('POST', '/rooms', { name: room, privacy: 'public', properties: { exp, eject_at_room_exp: true, enable_screenshare: true, enable_chat: true, enable_prejoin_ui: true } });
    if (!r.ok && r.status === 400) r = await dailyApi('POST', '/rooms', { name: room, privacy: 'public', properties: { exp } });
    if (!r.ok || !r.data || !r.data.url) return res.status(502).json({ ok: false, error: 'Daily.co xona yaratmadi: ' + ((r.data && (r.data.info || r.data.error)) || r.status) });
    const t = await dailyApi('POST', '/meeting-tokens', { properties: { room_name: room, is_owner: true, user_name: cleanName(name, 'Ustoz'), exp } });
    if (!t.ok || !t.data || !t.data.token) return res.status(502).json({ ok: false, error: 'Daily.co token bermadi: ' + ((t.data && (t.data.info || t.data.error)) || t.status) });
    res.json({ ok: true, room, url: r.data.url, token: t.data.token, exp });
  } catch (e) { console.error('daily start', e); res.status(502).json({ ok: false, error: "Daily.co ga ulanib bo'lmadi." }); }
});

app.post('/api/daily/owner', async (req, res) => {
  if (!dailyReady(res)) return;
  if (!dailyLimit(req, res, 60)) return;
  const { userId, name } = req.body || {}; const room = cleanRoom(req.body && req.body.room);
  if (!room || !(await isStaff(userId))) return res.status(403).json({ ok: false, error: 'Ruxsat yo\'q.' });
  try {
    const g = await dailyApi('GET', '/rooms/' + room);
    if (!g.ok) return res.status(404).json({ ok: false, error: 'Dars xonasi topilmadi yoki tugagan.' });
    const exp = (g.data && g.data.config && g.data.config.exp) || Math.floor(Date.now() / 1000) + DAILY_HOURS * 3600;
    const t = await dailyApi('POST', '/meeting-tokens', { properties: { room_name: room, is_owner: true, user_name: cleanName(name, 'Ustoz'), exp } });
    if (!t.ok || !t.data || !t.data.token) return res.status(502).json({ ok: false, error: 'Token olinmadi.' });
    res.json({ ok: true, room, url: g.data.url, token: t.data.token });
  } catch (e) { console.error('daily owner', e); res.status(502).json({ ok: false, error: "Daily.co ga ulanib bo'lmadi." }); }
});

app.get('/api/daily/room/:room', async (req, res) => {
  if (!dailyReady(res)) return;
  if (!dailyLimit(req, res, 600)) return;
  const room = cleanRoom(req.params.room);
  if (!room) return res.status(404).json({ ok: false, error: 'Dars topilmadi.' });
  try {
    const g = await dailyApi('GET', '/rooms/' + room);
    if (!g.ok) return res.status(404).json({ ok: false, error: 'Dars topilmadi yoki tugagan.' });
    res.json({ ok: true, room });
  } catch (e) { res.status(502).json({ ok: false, error: "Daily.co ga ulanib bo'lmadi." }); }
});

app.post('/api/daily/join', async (req, res) => {
  if (!dailyReady(res)) return;
  if (!dailyLimit(req, res, 120)) return;
  const room = cleanRoom(req.body && req.body.room);
  const name = cleanName(req.body && req.body.name, '');
  if (!room || !name) return res.status(400).json({ ok: false, error: 'Ismingizni kiriting.' });
  try {
    const g = await dailyApi('GET', '/rooms/' + room);
    if (!g.ok) return res.status(404).json({ ok: false, error: 'Dars topilmadi yoki tugagan.' });
    const exp = Math.min((g.data && g.data.config && g.data.config.exp) || Infinity, Math.floor(Date.now() / 1000) + DAILY_HOURS * 3600);
    const t = await dailyApi('POST', '/meeting-tokens', { properties: { room_name: room, is_owner: false, user_name: name, exp, enable_screenshare: false, start_audio_off: true } });
    if (!t.ok || !t.data || !t.data.token) return res.status(502).json({ ok: false, error: 'Darsga qo\'shilib bo\'lmadi. Qayta urinib ko\'ring.' });
    res.json({ ok: true, room, url: g.data.url, token: t.data.token });
  } catch (e) { console.error('daily join', e); res.status(502).json({ ok: false, error: "Daily.co ga ulanib bo'lmadi." }); }
});


function classRoomName(teacherId) { const t = String(teacherId || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32); return t.length >= 1 ? 'pk-t-' + t : ''; }
app.get('/api/daily/ping', (req, res) => { if (!DAILY_KEY) return res.status(503).json({ ok: false }); res.json({ ok: true }); });

app.post('/api/daily/class', async (req, res) => {
  if (!dailyReady(res)) return;
  if (!dailyLimit(req, res, 60)) return;
  const { userId, teacherId, name } = req.body || {};
  const room = classRoomName(teacherId);
  if (!room || !(await isStaff(userId))) return res.status(403).json({ ok: false, error: 'Ruxsat yo\'q.' });
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  try {
    let g = await dailyApi('GET', '/rooms/' + room);
    if (!g.ok) {
      let r = await dailyApi('POST', '/rooms', { name: room, privacy: 'public', properties: { exp, eject_at_room_exp: true, enable_screenshare: true, enable_chat: true, enable_prejoin_ui: true } });
      if (!r.ok && r.status === 400) r = await dailyApi('POST', '/rooms', { name: room, privacy: 'public', properties: { exp } });
      if (!r.ok || !r.data || !r.data.url) return res.status(502).json({ ok: false, error: 'Daily.co xona yaratmadi: ' + ((r.data && (r.data.info || r.data.error)) || r.status) });
      g = r;
    }
    const t = await dailyApi('POST', '/meeting-tokens', { properties: { room_name: room, is_owner: true, user_name: cleanName(name, 'Ustoz'), exp } });
    if (!t.ok || !t.data || !t.data.token) return res.status(502).json({ ok: false, error: 'Daily.co token bermadi.' });
    res.json({ ok: true, room, url: g.data.url, token: t.data.token });
  } catch (e) { console.error('daily class', e); res.status(502).json({ ok: false, error: "Daily.co ga ulanib bo'lmadi." }); }
});

app.post('/api/daily/classjoin', async (req, res) => {
  if (!dailyReady(res)) return;
  if (!dailyLimit(req, res, 200)) return;
  const room = classRoomName(req.body && req.body.teacherId);
  const name = cleanName(req.body && req.body.name, '');
  if (!room || !name) return res.status(400).json({ ok: false, error: 'Ma\'lumot yetarli emas.' });
  try {
    const g = await dailyApi('GET', '/rooms/' + room);
    if (!g.ok) return res.status(404).json({ ok: false, error: 'O\'qituvchi hali darsni boshlamagan.' });
    const exp = Math.floor(Date.now() / 1000) + 8 * 3600;
    const t = await dailyApi('POST', '/meeting-tokens', { properties: { room_name: room, is_owner: false, user_name: name, exp, start_audio_off: true } });
    if (!t.ok || !t.data || !t.data.token) return res.status(502).json({ ok: false, error: 'Darsga qo\'shilib bo\'lmadi.' });
    res.json({ ok: true, room, url: g.data.url, token: t.data.token });
  } catch (e) { console.error('daily classjoin', e); res.status(502).json({ ok: false, error: "Daily.co ga ulanib bo'lmadi." }); }
});


app.get('/api/daily/classstatus/:tid', async (req, res) => {
  if (!dailyReady(res)) return;
  if (!dailyLimit(req, res, 900)) return;
  const room = classRoomName(req.params.tid);
  if (!room) return res.status(404).json({ ok: false });
  try { const g = await dailyApi('GET', '/rooms/' + room); if (!g.ok) return res.status(404).json({ ok: false }); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ ok: false }); }
});

app.post('/api/daily/end', async (req, res) => {
  if (!dailyReady(res)) return;
  if (!dailyLimit(req, res, 60)) return;
  const { userId } = req.body || {}; const room = (req.body && req.body.teacherId) ? classRoomName(req.body.teacherId) : cleanRoom(req.body && req.body.room);
  if (!room || !(await isStaff(userId))) return res.status(403).json({ ok: false, error: 'Ruxsat yo\'q.' });
  try { await dailyApi('DELETE', '/rooms/' + room); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ ok: false, error: "Daily.co ga ulanib bo'lmadi." }); }
});

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
