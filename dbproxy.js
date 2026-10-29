/* Xavfsiz ma'lumotlar bazasi "ko'prigi".
   Sayt endi Supabase'ga to'g'ridan-to'g'ri emas, shu server orqali murojaat qiladi.
   Server har so'rovda foydalanuvchi kimligini (imzolangan token) va roliga qarab ruxsatni tekshiradi.
   SUPABASE_SERVICE_KEY faqat shu yerda (Railway muhit o'zgaruvchisida) turadi. */
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const SB_URL = process.env.SUPABASE_URL || 'https://nyyspriexqbulupofeoo.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ENABLED = !!KEY;
const sc = ENABLED ? createClient(SB_URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
const SECRET = crypto.createHash('sha256').update('pushkina-session|' + KEY).digest();
const TOKEN_DAYS = 30;

const SAFE_USER_COLS = 'id,username,role,name,phone,status';
const b64 = (b) => Buffer.from(b).toString('base64url');

function signToken(uid) {
  const payload = b64(JSON.stringify({ u: String(uid), e: Date.now() + TOKEN_DAYS * 86400000 }));
  const sig = b64(crypto.createHmac('sha256', SECRET).update(payload).digest());
  return payload + '.' + sig;
}
function readToken(tok) {
  if (!tok || typeof tok !== 'string' || tok.length > 600) return null;
  const [payload, sig] = tok.split('.');
  if (!payload || !sig) return null;
  const good = crypto.createHmac('sha256', SECRET).update(payload).digest();
  let given; try { given = Buffer.from(sig, 'base64url'); } catch (e) { return null; }
  if (given.length !== good.length || !crypto.timingSafeEqual(given, good)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!p.u || !p.e || p.e < Date.now()) return null;
    return p;
  } catch (e) { return null; }
}

/* foydalanuvchi konteksti (rol, o'quvchi/ustoz id) — 30 soniya keshlanadi */
const ctxCache = new Map();
async function loadCtx(uid) {
  const c = ctxCache.get(uid);
  if (c && Date.now() - c.at < 30000) return c.ctx;
  const { data: u } = await sc.from('users').select(SAFE_USER_COLS).eq('id', uid).maybeSingle();
  let ctx = null;
  if (u && u.status !== 'pending') {
    ctx = { uid: String(u.id), role: u.role, user: u, sid: null, tid: null, online: true };
    if (u.role === 'student') {
      const { data } = await sc.from('students').select('id,online_approved').eq('user_id', u.id).limit(1);
      ctx.sid = data && data[0] ? data[0].id : null;
      ctx.online = !!(data && data[0] && data[0].online_approved);
    } else if (u.role === 'teacher') {
      const { data } = await sc.from('teachers').select('id').eq('user_id', u.id).limit(1);
      ctx.tid = data && data[0] ? data[0].id : null;
    }
  }
  ctxCache.set(uid, { at: Date.now(), ctx });
  return ctx;
}
async function ctxFromReq(req) {
  if (!ENABLED) return null;
  const h = String(req.headers.authorization || '');
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  const p = readToken(tok);
  if (!p) return null;
  return await loadCtx(p.u);
}

/* --------- ruxsat qoidalari --------- */
const ALL_TABLES = ['users', 'teachers', 'students', 'schedule', 'attendance', 'payments', 'videos', 'materials', 'announcements',
  'ratings', 'settings', 'tests', 'test_questions', 'test_attempts', 'homework', 'homework_status', 'rewards', 'reward_requests',
  'reviews', 'daily_totals', 'nazorat_scores', 'teacher_checkins', 'flashcard_sets', 'teacher_ratings', 'daily_words',
  'bot_questions', 'video_progress', 'teacher_payouts', 'practice_items', 'leads', 'wheel_questions',
  'vocab_progress', 'vocab_daily', 'topic_results'];
const STUDENT_OWN_RW = ['test_attempts', 'homework_status', 'reward_requests', 'video_progress', 'teacher_ratings', 'ratings',
  'vocab_progress', 'vocab_daily', 'topic_results'];
const STUDENT_OWN_RO = ['attendance', 'payments', 'nazorat_scores'];
const OPEN_READ = ['schedule', 'videos', 'materials', 'announcements', 'settings', 'tests', 'test_questions', 'homework',
  'rewards', 'reviews', 'daily_totals', 'flashcard_sets', 'daily_words', 'practice_items', 'wheel_questions'];
const ADMIN_ONLY_WRITE = ['settings', 'rewards', 'teacher_payouts', 'leads'];
const ANON_READ = ['teachers', 'schedule', 'settings', 'reviews', 'wheel_questions', 'practice_items', 'daily_words'];

const isAdmin = (c) => c && (c.role === 'admin' || c.role === 'owner');
const isStaffCtx = (c) => c && (c.role === 'admin' || c.role === 'owner' || c.role === 'teacher');
const pick = (obj, keys) => { const o = {}; for (const k of keys) if (obj && obj[k] !== undefined) o[k] = obj[k]; return o; };
const DENY = (msg) => ({ deny: true, msg: msg || "Ruxsat yo'q" });

function eqId(filters) { const f = filters.find(x => x[0] === 'eq' && x[1][0] === 'id'); return f ? f[1][1] : null; }

/* qaytadigan qatorlardan maxfiy maydonlarni olib tashlash */
function stripRows(ctx, table, rows) {
  if (!Array.isArray(rows)) return rows;
  const role = ctx ? ctx.role : 'anon';
  return rows.map(r => {
    if (!r || typeof r !== 'object') return r;
    const o = Object.assign({}, r);
    if (table === 'users') delete o.password;
    if (table === 'teachers') {
      const own = ctx && ctx.tid && o.id === ctx.tid;
      if (!isAdmin(ctx) && !own) delete o.face_descriptor;
      if (role === 'anon' || role === 'student') delete o.telegram_chat_id;
    }
    if (table === 'users' && role === 'student' && ctx && String(o.id) !== ctx.uid) { delete o.phone; delete o.username; }
    if (table === 'students' && role === 'student' && !(ctx.sid && o.id === ctx.sid)) {
      return pick(o, ['id', 'user_id', 'teacher_id', 'group', 'coins', 'schedule_slot_id']);
    }
    return o;
  });
}

/* qoida: so'rovga ruxsat berish/majburiy filtr qo'yish */
async function policy(ctx, table, op, filters, payload) {
  const role = ctx ? ctx.role : 'anon';
  const P = { forceEq: [], rowSet: {}, cols: null };

  /* ----- mehmon (tokensiz) ----- */
  if (!ctx) {
    if (op === 'select') {
      if (table === 'users') { P.forceEq.push(['role', 'teacher']); P.cols = 'id,name,role'; return P; }
      if (table === 'reviews') { P.forceEq.push(['approved', true]); return P; }
      if (ANON_READ.includes(table)) return P;
      return { emptyRead: true };
    }
    if (op === 'insert' && table === 'users') {
      P.rowSet = { role: 'student', status: 'pending' };
      P.cols = ['username', 'password', 'name', 'phone'];
      P.check = async (rows) => {
        const r = rows[0] || {};
        const un = String(r.username || '').trim();
        if (un.length < 3 || un.length > 40 || String(r.password || '').length < 4) return "Login kamida 3, parol kamida 4 belgidan iborat bo'lsin";
        const { data } = await sc.from('users').select('id').eq('username', un).limit(1);
        if (data && data.length) return 'Bu login band. Boshqasini tanlang.';
        return null;
      };
      return P;
    }
    if (op === 'insert' && table === 'students') {
      P.cols = ['user_id', 'group', 'teacher_id', 'telegram_chat_id', 'schedule_slot_id', 'online_requested', 'extra_teacher_ids', 'extra_slot_ids'];
      P.check = async (rows) => {
        const r = rows[0] || {};
        const { data: u } = await sc.from('users').select('id,status,role').eq('id', r.user_id).maybeSingle();
        if (!u || u.status !== 'pending' || u.role !== 'student') return "Ruxsat yo'q";
        const { data: ex } = await sc.from('students').select('id').eq('user_id', r.user_id).limit(1);
        if (ex && ex.length) return "Ruxsat yo'q";
        return null;
      };
      return P;
    }
    if (op === 'delete' && table === 'users') {
      P.check = async () => {
        const id = eqId(filters); if (!id) return "Ruxsat yo'q";
        const { data: u } = await sc.from('users').select('id,status,role').eq('id', id).maybeSingle();
        if (!u || u.status !== 'pending' || u.role !== 'student') return "Ruxsat yo'q";
        const { data: ex } = await sc.from('students').select('id').eq('user_id', id).limit(1);
        if (ex && ex.length) return "Ruxsat yo'q";
        return null;
      };
      return P;
    }
    return DENY();
  }

  /* ----- foydalanuvchi bor ----- */
  if (!ALL_TABLES.includes(table)) return DENY();
  if (table === 'users') P.cols = SAFE_USER_COLS;

  if (isAdmin(ctx)) {
    if (table === 'users' && op !== 'select') {
      if (payload) { const rows = Array.isArray(payload) ? payload : [payload]; if (rows.some(r => r && r.role === 'owner') && ctx.role !== 'owner') return DENY("Faqat egasi 'owner' qila oladi"); }
      if (op === 'update' || op === 'delete') {
        P.check = async () => {
          const id = eqId(filters); if (!id) return "Ruxsat yo'q";
          const { data: u } = await sc.from('users').select('role').eq('id', id).maybeSingle();
          if (u && u.role === 'owner' && ctx.role !== 'owner') return "Egasini o'zgartirib bo'lmaydi";
          return null;
        };
      }
    }
    return P;
  }

  if (role === 'teacher') {
    if (op === 'select') {
      if (table === 'leads') return { emptyRead: true };
      if (table === 'teacher_payouts') { P.forceEq.push(['teacher_id', ctx.tid || '-']); }
      return P;
    }
    if (ADMIN_ONLY_WRITE.includes(table)) return DENY();
    if (table === 'users') {
      if (op === 'insert') { P.rowSet = { role: 'student' }; P.cols = ['username', 'password', 'name', 'phone', 'status']; return P; }
      P.check = async () => {
        const id = eqId(filters); if (!id) return "Ruxsat yo'q";
        if (String(id) === ctx.uid) return null;
        const { data: u } = await sc.from('users').select('role').eq('id', id).maybeSingle();
        return u && u.role === 'student' ? null : "Ruxsat yo'q";
      };
      if (op === 'update') P.cols = ['username', 'password', 'name', 'phone'], P.colsMode = 'update';
      return P;
    }
    if (table === 'teachers') {
      if (op === 'insert' || op === 'delete') return DENY();
      P.forceEq.push(['id', ctx.tid || '-']); return P;
    }
    if (table === 'teacher_checkins' && op === 'insert') P.rowSet = { teacher_id: ctx.tid };
    if (table === 'reviews' && op !== 'insert') return DENY();
    if (table === 'reviews' && op === 'insert') P.rowSet = { author_user_id: ctx.uid, approved: false };
    return P;
  }

  if (role === 'student') {
    const sid = ctx.sid;
    if (op === 'select') {
      if (!ctx.online) {
        if (table === 'videos') return { emptyRead: true };
        if (table === 'tests' || table === 'homework') { P.dropVideoLinked = true; return P; }
        if (table === 'test_questions') {
          const { data: vt } = await sc.from('tests').select('id').not('video_id', 'is', null);
          P.excludeTestIds = (vt || []).map(x => x.id);
          return P;
        }
        if (table === 'video_progress') return { emptyRead: true };
      }
      if (table === 'users' || table === 'teachers' || table === 'students' || OPEN_READ.includes(table)) return P;
      if (STUDENT_OWN_RW.includes(table) || STUDENT_OWN_RO.includes(table)) { P.forceEq.push(['student_id', sid || '-']); return P; }
      return { emptyRead: true };
    }
    if (!sid && table !== 'users') return DENY();
    if (STUDENT_OWN_RW.includes(table)) {
      if (op === 'insert') P.rowSet = { student_id: sid }; else P.forceEq.push(['student_id', sid]);
      return P;
    }
    if (table === 'students' && op === 'update') { P.forceEq.push(['id', sid]); P.cols = ['coins']; P.colsMode = 'update'; return P; }
    if (table === 'users' && op === 'update') { P.forceEq.push(['id', ctx.uid]); P.cols = ['username', 'password', 'name', 'phone']; P.colsMode = 'update'; return P; }
    if (table === 'reviews' && op === 'insert') { P.rowSet = { author_user_id: ctx.uid, approved: false }; return P; }
    return DENY();
  }
  return DENY();
}

const FILTERS = ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'not', 'contains'];
const MODS = ['order', 'limit', 'range', 'single', 'maybeSingle'];

async function execute(ctx, body) {
  let table = String(body.table || '');
  if (table === 'users_public') table = 'users';
  const ops = body.ops;
  if (!Array.isArray(ops) || !ops.length || ops.length > 40) return { status: 400, error: { message: "Noto'g'ri so'rov" } };
  for (const o of ops) if (!Array.isArray(o) || typeof o[0] !== 'string' || !Array.isArray(o[1])) return { status: 400, error: { message: "Noto'g'ri so'rov" } };
  const op = ops[0][0];
  if (!['select', 'insert', 'update', 'delete'].includes(op)) return { status: 400, error: { message: "Noto'g'ri amal" } };
  const rest = ops.slice(1);
  const filters = rest.filter(o => FILTERS.includes(o[0]));
  for (const o of rest) if (!FILTERS.includes(o[0]) && !MODS.includes(o[0]) && o[0] !== 'select') return { status: 400, error: { message: "Noto'g'ri amal: " + o[0] } };
  for (const f of filters) if (String(f[1][0]) === 'password') return { status: 403, error: { message: "Ruxsat yo'q" } };

  const payload = ops[0][1][0];
  const P = await policy(ctx, table, op, filters, payload);
  if (P.emptyRead) return { status: 200, data: [], count: null };
  if (P.deny) return { status: 403, error: { message: P.msg } };

  let q = sc.from(table);
  const selCols = (typeof P.cols === 'string') ? P.cols : (table === 'users' ? SAFE_USER_COLS : null);
  if (op === 'select') {
    const opts = ops[0][1][1] && typeof ops[0][1][1] === 'object' ? pick(ops[0][1][1], ['count', 'head']) : undefined;
    q = q.select(selCols || (typeof ops[0][1][0] === 'string' ? ops[0][1][0] : '*'), opts);
  } else if (op === 'delete') {
    if (P.check) { const m = await P.check([]); if (m) return { status: 403, error: { message: m } }; }
    q = q.delete();
  } else {
    let vals = ops[0][1][0];
    const isArr = Array.isArray(vals);
    let rows = isArr ? vals : [vals];
    if (!rows.length || rows.length > 500 || rows.some(r => !r || typeof r !== 'object')) return { status: 400, error: { message: "Noto'g'ri ma'lumot" } };
    if (Array.isArray(P.cols)) rows = rows.map(r => pick(r, P.cols));
    if (op === 'update') rows = rows.map(r => { const c = Object.assign({}, r); delete c.id; return c; });
    rows = rows.map(r => Object.assign({}, r, P.rowSet));
    if (op === 'update' && !Object.keys(rows[0]).length) return { status: 403, error: { message: "Ruxsat yo'q" } };
    if (P.check) { const m = await P.check(rows); if (m) return { status: 403, error: { message: m } }; }
    q = op === 'insert' ? q.insert(isArr ? rows : rows[0]) : q.update(rows[0]);
  }
  for (const [c, v] of P.forceEq) q = q.eq(c, v);
  if (P.excludeTestIds && P.excludeTestIds.length) q = q.not('test_id', 'in', '(' + P.excludeTestIds.join(',') + ')');
  for (const [m, a] of rest) {
    if (m === 'select') q = q.select(selCols || (typeof a[0] === 'string' ? a[0] : '*'));
    else q = q[m](...a);
  }
  const { data, error, count } = await q;
  if (error) return { status: 200, error: { message: error.message, details: error.details, hint: error.hint, code: error.code } };
  let out = data;
  if (P.dropVideoLinked && Array.isArray(out)) out = out.filter(r => !r.video_id);
  if (Array.isArray(out)) out = stripRows(ctx, table, out);
  else if (out && typeof out === 'object') out = stripRows(ctx, table, [out])[0];
  return { status: 200, data: out, count: count == null ? null : count };
}

/* RPC: p_user har doim tokendagi foydalanuvchidan olinadi */
async function runRpc(ctx, name, args) {
  args = args && typeof args === 'object' ? args : {};
  const admin = isAdmin(ctx);
  if (name === 'add_usage') return sc.rpc('add_usage', { p_user: ctx.uid, p_seconds: Math.max(0, Math.min(86400, Number(args.p_seconds) || 0)) });
  if (name === 'add_usage_tabs') return sc.rpc('add_usage_tabs', { p_user: ctx.uid, p_data: args.p_data });
  if (name === 'log_login') return sc.rpc('log_login', { p_user: ctx.uid, p_ua: String(args.p_ua || '').slice(0, 300) });
  if (name === 'get_flags') return sc.rpc('get_flags');
  if (!admin) return { data: null, error: { message: "Ruxsat yo'q" } };
  if (name === 'set_flag') return sc.rpc('set_flag', { p_user: ctx.uid, p_key: String(args.p_key || ''), p_value: String(args.p_value == null ? '' : args.p_value) });
  if (name === 'login_history') return sc.rpc('login_history', { p_user: ctx.uid, p_limit: Math.min(1000, Number(args.p_limit) || 500) });
  if (name === 'usage_summary') return sc.rpc('usage_summary');
  if (name === 'usage_tabs_summary') return sc.rpc('usage_tabs_summary');
  return { data: null, error: { message: "Noma'lum funksiya" } };
}

/* tezlikni cheklash */
const hits = new Map();
function limited(key, max, ms) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < ms);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr); return false;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 600000)) hits.delete(k); }, 300000).unref();
const ip = (req) => String(req.headers['x-forwarded-for'] || req.ip || 'x').split(',')[0].trim();

function mount(app) {
  app.get('/api/dbstatus', (req, res) => res.json({ proxy: ENABLED }));
  if (!ENABLED) return;

  const fails = new Map();
  app.post('/api/login', async (req, res) => {
    const username = String((req.body && req.body.username) || '').trim().slice(0, 80);
    const password = String((req.body && req.body.password) || '').slice(0, 200);
    if (!username || !password) return res.status(400).json({ ok: false });
    if (limited('lg:' + ip(req), 30, 60000)) return res.status(429).json({ ok: false, error: "Juda ko'p urinish. Bir daqiqa kuting." });
    const fk = username.toLowerCase();
    const f = fails.get(fk);
    if (f && f.n >= 8 && Date.now() - f.at < 300000) return res.status(429).json({ ok: false, error: "Juda ko'p xato urinish. 5 daqiqadan keyin urinib ko'ring." });
    const { data, error } = await sc.rpc('verify_login', { p_username: username, p_password: password });
    if (error) { console.error('verify_login', error.message); return res.status(500).json({ ok: false }); }
    const u = data && data[0];
    if (!u) { fails.set(fk, { n: ((f && Date.now() - f.at < 300000) ? f.n : 0) + 1, at: Date.now() }); return res.json({ ok: false }); }
    fails.delete(fk);
    const user = pick(u, ['id', 'username', 'role', 'name', 'phone', 'status']);
    if (req.body.check) return res.json({ ok: true });
    if (user.status === 'pending') return res.json({ ok: true, user });
    ctxCache.delete(String(user.id));
    sc.rpc('log_login', { p_user: String(user.id), p_ua: String(req.body.ua || req.headers['user-agent'] || '').slice(0, 300) }).then(() => {}, () => {});
    res.json({ ok: true, token: signToken(user.id), user });
  });

  app.get('/api/me', async (req, res) => {
    const ctx = await ctxFromReq(req);
    if (!ctx) return res.status(401).json({ ok: false });
    res.json({ ok: true, user: ctx.user });
  });

  app.post('/api/db', async (req, res) => {
    if (limited('db:' + ip(req), 900, 60000)) return res.status(429).json({ error: { message: "Juda ko'p so'rov" } });
    try {
      const ctx = await ctxFromReq(req);
      if (!ctx && String(req.headers.authorization || '').startsWith('Bearer ')) return res.status(401).json({ error: { message: 'Sessiya tugagan. Qayta kiring.', code: 'AUTH' } });
      const r = await execute(ctx, req.body || {});
      const { status, ...rest } = r;
      res.status(status).json(rest);
    } catch (e) {
      console.error('db', e);
      res.status(500).json({ error: { message: 'Server xatosi' } });
    }
  });

  app.get('/api/vurl', async (req, res) => {
    try {
      if (limited('vu:' + ip(req), 300, 60000)) return res.status(429).json({ error: 'limit' });
      const ctx = await ctxFromReq(req);
      if (!ctx) return res.status(401).json({ error: 'auth' });
      if (!(isStaffCtx(ctx) || (ctx.role === 'student' && ctx.online))) return res.status(403).json({ error: 'forbidden' });
      const id = String(req.query.id || '');
      const { data: v } = await sc.from('videos').select('url').eq('id', id).maybeSingle();
      if (!v || !v.url) return res.status(404).json({ error: 'yoq' });
      const m = String(v.url).match(/\/storage\/v1\/object\/public\/videos\/([^?]+)/);
      if (!m) return res.json({ url: v.url });
      const { data, error } = await sc.storage.from('videos').createSignedUrl(decodeURIComponent(m[1]), 7200);
      if (error || !data) return res.status(502).json({ error: 'sign' });
      res.json({ url: data.signedUrl });
    } catch (e) { console.error('vurl', e); res.status(500).json({ error: 'server' }); }
  });

  app.post('/api/rpc', async (req, res) => {
    try {
      const ctx = await ctxFromReq(req);
      if (!ctx) return res.status(401).json({ error: { message: 'Sessiya tugagan. Qayta kiring.', code: 'AUTH' } });
      const { data, error } = await runRpc(ctx, String((req.body && req.body.name) || ''), req.body && req.body.args);
      res.json({ data: data == null ? null : data, error: error ? { message: error.message } : null });
    } catch (e) { console.error('rpc', e); res.status(500).json({ error: { message: 'Server xatosi' } }); }
  });
}

module.exports = { mount, ctxFromReq, sc, ENABLED, isStaffCtx, SAFE_USER_COLS, execute, policy };
