/**
 * LINE Richmenu Setting — multi-workspace backend
 * - 1 workspace = 1 ทีม / 1 LINE OA (ข้อมูลแยกกันสนิท, login ด้วยรหัสของ workspace)
 * - เก็บถาวรใน Supabase (ตาราง workspaces, click_events + Storage สำหรับรูป)
 *   ถ้าไม่ตั้ง SUPABASE_URL/KEY จะเก็บไฟล์ local (ใช้ทดสอบเท่านั้น)
 * - Token/Secret ของแต่ละ OA เข้ารหัส AES-256-GCM ก่อนเก็บ
 * - ตั้งเวลาขึ้น-ลงอัตโนมัติ (scheduler) + webhook เก็บการกดปุ่ม
 * Pure Node.js 18+ (ไม่มี dependency)
 *
 * ENV: SUPABASE_URL, SUPABASE_KEY, ADMIN_PASSWORD = รหัสเข้าหน้า /admin
 *      (รหัสสร้าง workspace ตั้ง/เปลี่ยนได้ที่หน้า /admin),
 *      APP_SECRET (ไม่บังคับ — ใช้เข้ารหัส ถ้าไม่ตั้งจะใช้ค่าจาก SUPABASE_KEY)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const MENU_W = 2500;
const MENU_H = 1686;
const ALIASES = { tab1: 'switcher-tab-1', tab2: 'switcher-tab-2' };

const SUPA_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPA_KEY = (process.env.SUPABASE_KEY || '').trim();
const USE_SUPA = !!(SUPA_URL && SUPA_KEY);
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();   // รหัสเข้าหน้า /admin
const SECRET = crypto.createHash('sha256').update(process.env.APP_SECRET || SUPA_KEY || 'local-dev-secret').digest();
const BUCKET = 'richmenu-images';

// ---------------------------------------------------------------- crypto helpers
function enc(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', SECRET, iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}
function dec(s) {
  if (!s) return '';
  try {
    const [, iv, tag, ct] = s.split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', SECRET, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch { return ''; }
}
function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(String(pw), salt, 32).toString('hex')}`;
}
function checkPw(pw, h) {
  try {
    const [, salt, hex] = String(h).split('$');
    const a = crypto.scryptSync(String(pw), salt, 32);
    const b = Buffer.from(hex, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
function sign(v) { return crypto.createHmac('sha256', SECRET).update(v).digest('base64url'); }
function makeSession(id) { const v = `${id}.${Date.now() + 30 * 864e5}`; return `${v}.${sign(v)}`; }
function readSession(req) {
  const m = /(?:^|;\s*)rm_session=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const parts = decodeURIComponent(m[1]).split('.');
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  if (sign(`${id}.${exp}`) !== sig || Number(exp) < Date.now()) return null;
  return id;
}
function sessionCookie(req, value, maxAge, name = 'rm_session') {
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
function makeAdminSession() { const v = `admin.${Date.now() + 12 * 3600e3}`; return `${v}.${sign(v)}`; }
function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const m = /(?:^|;\s*)rm_admin=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [who, exp, sig] = decodeURIComponent(m[1]).split('.');
  return who === 'admin' && sign(`${who}.${exp}`) === sig && Number(exp) > Date.now();
}
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function randomCode(n) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(n), (b) => chars[b % chars.length]).join('');
}

// ---------------------------------------------------------------- Supabase helpers
function sbHeaders(extra) {
  const h = { apikey: SUPA_KEY, ...(extra || {}) };
  if (SUPA_KEY.startsWith('eyJ')) h.Authorization = `Bearer ${SUPA_KEY}`; // legacy service_role (JWT)
  return h;
}
async function sb(method, p, body, prefer) {
  const h = sbHeaders({ 'Content-Type': 'application/json' });
  if (prefer) h.Prefer = prefer;
  const r = await fetch(`${SUPA_URL}/rest/v1/${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${t.slice(0, 300)}`);
  try { return t ? JSON.parse(t) : null; } catch { return null; }
}
function sbStorage(method, p, body, headers) {
  return fetch(`${SUPA_URL}/storage/v1/${p}`, { method, headers: sbHeaders(headers), body });
}
async function ensureBucket() {
  try {
    const r = await sbStorage('POST', 'bucket', JSON.stringify({ id: BUCKET, name: BUCKET, public: false }), { 'Content-Type': 'application/json' });
    if (!r.ok) {
      const t = await r.text();
      if (!/already exists|duplicate|409/i.test(`${r.status} ${t}`)) console.error('สร้าง bucket ไม่สำเร็จ:', r.status, t.slice(0, 200));
    }
  } catch (e) { console.error('ensureBucket', e.message); }
}

// ---------------------------------------------------------------- storage layer (Supabase หรือ local)
const LOCAL_FILE = path.join(DATA_DIR, 'db.json');
const LOCAL_IMG = path.join(DATA_DIR, 'img');
let localDb = { workspaces: [], clicks: [] };
const imgCache = new Map();
function localWrite() { fs.writeFileSync(LOCAL_FILE, JSON.stringify(localDb)); }

const store = {
  async loadAll() {
    if (USE_SUPA) return (await sb('GET', 'workspaces?select=*')) || [];
    try { localDb = JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8')); } catch { localDb = { workspaces: [], clicks: [] }; }
    return localDb.workspaces;
  },
  async insert(row) {
    if (USE_SUPA) { const r = await sb('POST', 'workspaces', [row], 'return=representation'); return r[0]; }
    const saved = { ...row, id: crypto.randomUUID(), created_at: new Date().toISOString() };
    localDb.workspaces.push(saved); localWrite(); return saved;
  },
  async save(ws) {
    const patch = { name: ws.name, password_hash: ws.password_hash, bot_user_id: ws.bot_user_id || null, data: ws.data, updated_at: new Date().toISOString() };
    if (USE_SUPA) { await sb('PATCH', `workspaces?id=eq.${ws.id}`, patch, 'return=minimal'); return; }
    const i = localDb.workspaces.findIndex((w) => w.id === ws.id);
    if (i >= 0) { localDb.workspaces[i] = { ...localDb.workspaces[i], ...patch }; localWrite(); }
  },
  async putImg(key, buf) {
    if (USE_SUPA) {
      const r = await sbStorage('POST', `object/${BUCKET}/${key}`, buf, { 'Content-Type': 'image/jpeg', 'x-upsert': 'true' });
      if (!r.ok) throw new Error(`อัปโหลดรูปไป Supabase ไม่สำเร็จ (${r.status}): ${(await r.text()).slice(0, 200)}`);
    } else {
      const f = path.join(LOCAL_IMG, key); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf);
    }
    imgCache.set(key, buf);
  },
  async getImg(key) {
    if (imgCache.has(key)) return imgCache.get(key);
    let buf = null;
    if (USE_SUPA) {
      const r = await sbStorage('GET', `object/${BUCKET}/${key}`);
      if (r.ok) buf = Buffer.from(await r.arrayBuffer());
    } else { try { buf = fs.readFileSync(path.join(LOCAL_IMG, key)); } catch {} }
    if (buf) imgCache.set(key, buf);
    return buf;
  },
  async delImgs(keys) {
    keys.forEach((k) => imgCache.delete(k));
    if (!keys.length) return;
    if (USE_SUPA) { await sbStorage('DELETE', `object/${BUCKET}`, JSON.stringify({ prefixes: keys }), { 'Content-Type': 'application/json' }).catch(() => {}); return; }
    for (const k of keys) { try { fs.unlinkSync(path.join(LOCAL_IMG, k)); } catch {} }
  },
  async remove(id) {
    if (USE_SUPA) { await sb('DELETE', `workspaces?id=eq.${id}`, undefined, 'return=minimal'); return; }
    localDb.workspaces = localDb.workspaces.filter((w) => w.id !== id);
    localDb.clicks = localDb.clicks.filter((c) => c.workspace_id !== id);
    localWrite();
  },
  async addClick(row) {
    if (USE_SUPA) { await sb('POST', 'click_events', [row], 'return=minimal'); return; }
    localDb.clicks.push(row); if (localDb.clicks.length > 20000) localDb.clicks.shift(); localWrite();
  },
  async clicks(wsId) {
    if (USE_SUPA) return (await sb('GET', `click_events?workspace_id=eq.${wsId}&select=button_tag,user_id&limit=50000`)) || [];
    return localDb.clicks.filter((c) => c.workspace_id === wsId);
  },
};

// ---------------------------------------------------------------- workspaces (cache ในหน่วยความจำ)
const WS = new Map();
// แถวระบบ (slug "_system") เก็บค่าตั้งของ admin เช่น รหัสสร้าง workspace — ผู้ใช้สร้าง slug ขึ้นต้นด้วย _ ไม่ได้
let SYS = null;
function signupCode() { return (SYS && SYS.data && SYS.data.signupCode) || ''; }
function normData(d) {
  d = d && typeof d === 'object' ? d : {};
  d.config = d.config || {};
  if (!d.config.chatBarText) d.config.chatBarText = 'เมนู';
  d.sets = d.sets || {};
  if (d.defaultSetId === undefined) d.defaultSetId = null;
  return d;
}
function wsBySlug(slug) { for (const w of WS.values()) if (w.slug === slug) return w; return null; }
function tokenOf(ws) { return dec(ws.data.config.tokenEnc); }
function secretOf(ws) { return dec(ws.data.config.secretEnc); }
// บันทึกทีละคำขอตามลำดับ (กันคำขอเก่าไปถึง Supabase ทีหลังแล้วเขียนทับข้อมูลใหม่)
const saveChains = new Map();
function saveWs(ws) {
  const prev = saveChains.get(ws.id) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => store.save(ws));
  saveChains.set(ws.id, next);
  return next;
}
function imgKey(ws, setId, tab) { return `${ws.id}/${setId}/${tab}.jpg`; }

// ---------------------------------------------------------------- sets
function tabIds(s) { return s.tabCount === 1 ? ['tab1'] : ['tab1', 'tab2']; }
function newTab(name) { return { name, template: 'tabbar-6', areas: [], image: null }; }
function newSet(name, layout, tabCount) {
  const id = crypto.randomUUID();
  const slug = (name || 'menu').toLowerCase().replace(/[^a-z0-9ก-๙]+/gi, '-').replace(/^-|-$/g, '').slice(0, 24) || 'menu';
  const t1 = newTab(tabCount === 1 ? 'เมนู' : 'แถบ 1'); const t2 = newTab('แถบ 2');
  if (layout) { t1.template = layout; t2.template = layout; }
  return {
    id, name: name || 'ชุดเมนูใหม่', slug,
    tabCount: tabCount === 1 ? 1 : 2,
    chatBarText: 'เมนู',
    schedule: { startAt: '', endAt: '' },
    tabs: { tab1: t1, tab2: t2 },
    status: 'draft',
    draftSavedAt: null,
    lastModifiedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    published: null,
  };
}

// ---------------------------------------------------------------- LINE API
async function lineApi(method, url, { token, body, rawBody, contentType } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (rawBody) { headers['Content-Type'] = contentType; payload = rawBody; }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = json.message || json.raw || res.statusText;
    const details = json.details ? ' — ' + JSON.stringify(json.details) : '';
    const err = new Error(`LINE API ${res.status}: ${msg}${details}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

function buildLineAreas(tab) {
  return (tab.areas || []).filter((a) => a.action.type !== 'none').map((a) => {
    const x = Math.max(0, Math.round(a.x));
    const y = Math.max(0, Math.round(a.y));
    const bounds = { x, y, width: Math.min(Math.round(a.w), MENU_W - x), height: Math.min(Math.round(a.h), MENU_H - y) };
    let action;
    switch (a.action.type) {
      case 'switch': {
        const target = a.action.value === 'tab1' ? 'tab1' : 'tab2';
        action = { type: 'richmenuswitch', richMenuAliasId: ALIASES[target], data: `switch=${target}` };
        break;
      }
      case 'uri': action = { type: 'uri', uri: a.action.value }; break;
      case 'message': action = { type: 'message', text: a.action.value }; break;
      default: action = { type: 'postback', data: a.action.value || 'noop' };
    }
    return { bounds, action };
  });
}

async function ensureAlias(token, aliasId, richMenuId, log) {
  try {
    await lineApi('POST', 'https://api.line.me/v2/bot/richmenu/alias', { token, body: { richMenuAliasId: aliasId, richMenuId } });
    log(`สร้าง alias "${aliasId}"`);
  } catch (e) {
    if (e.status === 400 || e.status === 409) {
      await lineApi('POST', `https://api.line.me/v2/bot/richmenu/alias/${aliasId}`, { token, body: { richMenuId } });
      log(`อัปเดต alias "${aliasId}"`);
    } else throw e;
  }
}

function validateSet(s) {
  for (const id of tabIds(s)) {
    const t = s.tabs[id];
    if (!t.image) throw new Error(`${t.name}: ยังไม่ได้อัปโหลดรูป`);
    if (!t.areas || !t.areas.length) throw new Error(`${t.name}: ยังไม่ได้กำหนดปุ่ม`);
    if (s.tabCount !== 1 && !t.areas.some((a) => a.action.type === 'switch'))
      throw new Error(`${t.name}: ต้องมีปุ่ม "สลับแท็บ" อย่างน้อย 1 ปุ่ม`);
    t.areas.forEach((a, i) => {
      const n = i + 1; const v = String((a.action && a.action.value) || '').trim();
      if (a.action.type === 'none' || a.action.type === 'switch') return;
      if (a.action.type === 'uri') {
        const placeholder = v === '' || v === 'https://' || v === 'http://';
        const valid = /^(https?:\/\/.+|line:\/\/.+|tel:.+|mailto:.+)/i.test(v);
        if (placeholder || !valid) throw new Error(`${t.name} — ปุ่มที่ ${n}: ยังไม่ได้ใส่ลิงก์ (ใส่ URL เต็ม เช่น https://www.example.com)`);
      }
      if (a.action.type === 'message' && !v) throw new Error(`${t.name} — ปุ่มที่ ${n}: ยังไม่ได้ใส่ข้อความ`);
    });
  }
}

async function publishSet(ws, setId, { auto = false } = {}) {
  const logs = []; const log = (m) => logs.push(m);
  const token = tokenOf(ws);
  const D = ws.data;
  if (!token) throw Object.assign(new Error('ยังไม่ได้ตั้งค่า Channel Access Token (ปุ่ม "ตั้งค่าระบบ")'), { logs });
  const s = D.sets[setId];
  if (!s) throw Object.assign(new Error('ไม่พบชุดเมนู'), { logs });
  if (!auto && (!s.draftSavedAt || (s.lastModifiedAt && s.draftSavedAt < s.lastModifiedAt)))
    throw Object.assign(new Error('กรุณากด "บันทึกแบบร่าง" ก่อน Deploy'), { logs });
  try { validateSet(s); } catch (e) { e.logs = logs; throw e; }

  const prevDefault = D.defaultSetId && D.sets[D.defaultSetId];
  const oldPublished = s.published;
  const newIds = {};
  try {
    for (const id of tabIds(s)) {
      const t = s.tabs[id];
      const menu = {
        size: { width: MENU_W, height: MENU_H }, selected: true,
        name: `${s.slug}-${id}-${Date.now()}`.slice(0, 300),
        chatBarText: s.chatBarText || D.config.chatBarText || 'เมนู',
        areas: buildLineAreas(s.tabCount === 1 ? { areas: t.areas.filter((a) => a.action.type !== 'switch') } : t),
      };
      const { richMenuId } = await lineApi('POST', 'https://api.line.me/v2/bot/richmenu', { token, body: menu });
      log(`สร้าง rich menu "${t.name}" (${richMenuId})`);
      const imgBuf = await store.getImg(imgKey(ws, s.id, id));
      if (!imgBuf) throw new Error(`${t.name}: ไม่พบไฟล์รูป กรุณาอัปโหลดใหม่`);
      await lineApi('POST', `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, { token, rawBody: imgBuf, contentType: 'image/jpeg' });
      log(`อัปโหลดรูป "${t.name}" (${Math.round(imgBuf.length / 1024)} KB)`);
      newIds[id] = richMenuId;
    }
    if (s.tabCount !== 1) {
      await ensureAlias(token, ALIASES.tab1, newIds.tab1, log);
      await ensureAlias(token, ALIASES.tab2, newIds.tab2, log);
    }
    await lineApi('POST', `https://api.line.me/v2/bot/user/all/richmenu/${newIds.tab1}`, { token });
    log('ตั้งเป็นเมนูเริ่มต้นของผู้ใช้ทุกคนแล้ว');

    if (oldPublished) for (const id of ['tab1', 'tab2']) {
      const oid = oldPublished[id];
      if (oid && oid !== newIds[id]) { try { await lineApi('DELETE', `https://api.line.me/v2/bot/richmenu/${oid}`, { token }); } catch {} }
    }
    if (prevDefault && prevDefault.id !== s.id) {
      if (prevDefault.published) for (const id of ['tab1', 'tab2']) {
        const oid = prevDefault.published[id];
        if (oid) { try { await lineApi('DELETE', `https://api.line.me/v2/bot/richmenu/${oid}`, { token }); } catch {} }
      }
      prevDefault.status = 'ended'; prevDefault.published = null;
      log(`ปลดชุดเดิม "${prevDefault.name}" ออก`);
    }
    s.published = { ...newIds, at: new Date().toISOString() };
    s.status = 'live';
    D.defaultSetId = s.id;
    await saveWs(ws);
    return { logs };
  } catch (e) {
    for (const idv of Object.values(newIds)) { try { await lineApi('DELETE', `https://api.line.me/v2/bot/richmenu/${idv}`, { token }); } catch {} }
    e.logs = logs; throw e;
  }
}

async function endSet(ws, setId) {
  const token = tokenOf(ws);
  const D = ws.data;
  const s = D.sets[setId]; if (!s) return;
  if (token) {
    if (D.defaultSetId === s.id) { try { await lineApi('DELETE', 'https://api.line.me/v2/bot/user/all/richmenu', { token }); } catch {} }
    if (s.published) for (const id of ['tab1', 'tab2']) {
      const oid = s.published[id]; if (oid) { try { await lineApi('DELETE', `https://api.line.me/v2/bot/richmenu/${oid}`, { token }); } catch {} }
    }
  }
  s.status = 'ended'; s.published = null;
  if (D.defaultSetId === s.id) D.defaultSetId = null;
  await saveWs(ws);
}

// ---------------------------------------------------------------- scheduler (ทุก workspace)
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  const now = Date.now();
  try {
    for (const ws of WS.values()) {
      if (!tokenOf(ws)) continue;
      for (const s of Object.values(ws.data.sets)) {
        const start = s.schedule && s.schedule.startAt ? new Date(s.schedule.startAt).getTime() : null;
        const end = s.schedule && s.schedule.endAt ? new Date(s.schedule.endAt).getTime() : null;
        if (s.status === 'scheduled' && start && start <= now && (!end || end > now)) {
          try { await publishSet(ws, s.id, { auto: true }); } catch (e) { console.error(`[${ws.slug}] auto publish`, e.message); }
        }
        if (s.status === 'live' && end && end <= now) {
          try { await endSet(ws, s.id); } catch (e) { console.error(`[${ws.slug}] auto end`, e.message); }
        }
      }
    }
  } finally { ticking = false; }
}
setInterval(() => tick().catch(() => {}), 60 * 1000);

// ---------------------------------------------------------------- HTTP helpers
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) { const raw = (await readBody(req)).toString(); return raw ? JSON.parse(raw) : {}; }
function sendJson(res, code, obj, headers) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, ...(headers || {}) });
  res.end(buf);
}
function serveFile(res, filePath, type, cache) {
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache || 'no-cache' });
    res.end(buf);
  });
}

function publicState(ws) {
  const d = JSON.parse(JSON.stringify(ws.data));
  const t = tokenOf(ws);
  const out = {
    workspace: { id: ws.id, slug: ws.slug, name: ws.name },
    config: { tokenSet: !!t, tokenHint: t ? '••••••' + t.slice(-6) : '', secretSet: !!secretOf(ws), chatBarText: d.config.chatBarText, botName: d.config.botName || '', botBasicId: d.config.botBasicId || '' },
    sets: d.sets,
    defaultSetId: d.defaultSetId,
    storage: USE_SUPA ? 'supabase' : 'local',
  };
  for (const set of Object.values(out.sets)) {
    for (const id of ['tab1', 'tab2']) {
      const tb = set.tabs[id];
      tb.hasImage = !!tb.image;
      tb.image = tb.image ? `/api/sets/${set.id}/${id}/image?v=${encodeURIComponent(tb.image)}` : null;
    }
  }
  return out;
}

// ดึงข้อมูลบอทเพื่อผูก webhook กับ workspace ที่ถูกต้อง
async function refreshBotInfo(ws) {
  const token = tokenOf(ws);
  if (!token) return null;
  const info = await lineApi('GET', 'https://api.line.me/v2/bot/info', { token });
  ws.bot_user_id = info.userId || null;
  ws.data.config.botName = info.displayName || '';
  ws.data.config.botBasicId = info.basicId || '';
  await saveWs(ws);
  return info;
}

async function recordClick(ws, ev) {
  const userId = ev.source && ev.source.userId;
  if (!userId) return;
  const data = (ev.postback && ev.postback.data) || '';
  const tag = /(?:^|[&;])(?:btn|tag)=([^&;]+)/.exec(data);
  const sw = /switch=(tab\d)/.exec(data);
  const row = {
    workspace_id: ws.id, user_id: userId,
    button_tag: tag ? decodeURIComponent(tag[1]) : (sw ? 'switch:' + sw[1] : data || 'postback'),
    tab: sw ? sw[1] : '',
    clicked_at: new Date(ev.timestamp || Date.now()).toISOString(),
  };
  try { await store.addClick(row); } catch (e) { console.error('click', e.message); }
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const M = req.method;

    // ----- public -----
    if (M === 'GET' && (p === '/' || p === '/index.html' || p === '/admin')) return serveFile(res, path.join(__dirname, 'index.html'), 'text/html; charset=utf-8');
    if (M === 'GET' && p === '/logo.png') return serveFile(res, path.join(__dirname, 'logo.png'), 'image/png', 'public, max-age=86400');
    if (M === 'GET' && (p === '/favicon.png' || p === '/favicon.ico')) return serveFile(res, path.join(__dirname, 'favicon.png'), 'image/png', 'public, max-age=86400');
    if (p === '/health' || p === '/cron') { tick().catch(() => {}); res.writeHead(200); return res.end('ok'); }

    if (p === '/webhook' && M === 'POST') {
      const raw = await readBody(req);
      let body = {}; try { body = JSON.parse(raw.toString() || '{}'); } catch {}
      const ws = [...WS.values()].find((w) => w.bot_user_id && w.bot_user_id === body.destination);
      if (ws) {
        const sec = secretOf(ws);
        if (sec) {
          const sig = crypto.createHmac('SHA256', sec).update(raw).digest('base64');
          if (sig !== req.headers['x-line-signature']) { res.writeHead(401); return res.end('bad signature'); }
        }
        for (const ev of body.events || []) if (ev.type === 'postback') await recordClick(ws, ev);
      }
      res.writeHead(200); return res.end('OK');
    }

    if (p === '/api/meta' && M === 'GET') return sendJson(res, 200, { signupCodeRequired: !!signupCode() });

    // ----- ลืมรหัสผ่าน: ส่งคำขอให้ admin รีเซ็ต -----
    if (p === '/api/auth/forgot' && M === 'POST') {
      const b = await readJson(req);
      const ws = wsBySlug(String(b.slug || '').trim().toLowerCase());
      if (ws) {
        ws.data.resetRequest = { at: new Date().toISOString(), contact: String(b.contact || '').slice(0, 120) };
        await saveWs(ws);
      }
      // ตอบเหมือนกันเสมอ ไม่บอกว่ามี workspace นี้หรือไม่
      return sendJson(res, 200, { ok: true });
    }

    // ----- admin -----
    if (p === '/api/admin/login' && M === 'POST') {
      const b = await readJson(req);
      if (!ADMIN_PASSWORD) return sendJson(res, 403, { error: 'ยังไม่ได้ตั้ง ADMIN_PASSWORD ใน Render' });
      if (!safeEqual(b.password || '', ADMIN_PASSWORD)) { await new Promise((r) => setTimeout(r, 800)); return sendJson(res, 401, { error: 'รหัสผู้ดูแลไม่ถูกต้อง' }); }
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, makeAdminSession(), 43200, 'rm_admin') });
    }
    if (p === '/api/admin/logout' && M === 'POST') return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0, 'rm_admin') });
    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return sendJson(res, 401, { error: 'unauthorized' });
      if (p === '/api/admin/overview' && M === 'GET') {
        const list = [...WS.values()].map((w) => {
          const sets = Object.values(w.data.sets || {});
          return {
            id: w.id, slug: w.slug, name: w.name, createdAt: w.created_at,
            botName: w.data.config.botName || '', botBasicId: w.data.config.botBasicId || '',
            tokenSet: !!w.data.config.tokenEnc, secretSet: !!w.data.config.secretEnc,
            sets: sets.length, live: sets.filter((s) => s.status === 'live').length,
            scheduled: sets.filter((s) => s.status === 'scheduled').length,
            resetRequest: w.data.resetRequest || null,
          };
        }).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        return sendJson(res, 200, { ok: true, signupCode: signupCode(), workspaces: list });
      }
      if (p === '/api/admin/signup-code' && M === 'POST') {
        const b = await readJson(req);
        const code = String(b.code || '').trim();
        if (code.length < 4) return sendJson(res, 400, { error: 'รหัสอย่างน้อย 4 ตัว' });
        SYS.data.signupCode = code; await saveWs(SYS);
        return sendJson(res, 200, { ok: true });
      }
      let am = p.match(/^\/api\/admin\/workspaces\/([^/]+)\/reset-password$/);
      if (am && M === 'POST') {
        const w = WS.get(am[1]); if (!w) return sendJson(res, 404, { error: 'ไม่พบ workspace' });
        const temp = randomCode(8);
        w.password_hash = hashPw(temp); delete w.data.resetRequest; await saveWs(w);
        return sendJson(res, 200, { ok: true, tempPassword: temp });
      }
      am = p.match(/^\/api\/admin\/workspaces\/([^/]+)$/);
      if (am && M === 'DELETE') {
        const w = WS.get(am[1]); if (!w) return sendJson(res, 404, { error: 'ไม่พบ workspace' });
        const keys = [];
        for (const s of Object.values(w.data.sets || {})) for (const t of ['tab1', 'tab2']) keys.push(imgKey(w, s.id, t));
        await store.delImgs(keys);
        await store.remove(w.id);
        WS.delete(w.id);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 404, { error: 'Not found' });
    }

    if (p === '/api/auth/register' && M === 'POST') {
      const b = await readJson(req);
      const slug = String(b.slug || '').trim().toLowerCase();
      const name = String(b.name || '').trim().slice(0, 60);
      const pw = String(b.password || '');
      if (!SYS) return sendJson(res, 503, { error: 'ระบบยังเชื่อมฐานข้อมูลไม่สำเร็จ ลองใหม่ภายหลัง' });
      if (signupCode() && String(b.signupCode || '').trim() !== signupCode()) return sendJson(res, 403, { error: 'รหัสสร้าง workspace ไม่ถูกต้อง (ขอจากผู้ดูแลระบบ)' });
      if (!/^[a-z0-9][a-z0-9-]{2,30}$/.test(slug)) return sendJson(res, 400, { error: 'Workspace ID ใช้ได้เฉพาะ a-z, 0-9, ขีด (-) ยาว 3–31 ตัว' });
      if (!name) return sendJson(res, 400, { error: 'กรุณาใส่ชื่อทีม/แบรนด์' });
      if (pw.length < 6) return sendJson(res, 400, { error: 'รหัสผ่านอย่างน้อย 6 ตัว' });
      if (wsBySlug(slug)) return sendJson(res, 409, { error: 'Workspace ID นี้มีคนใช้แล้ว' });
      const saved = await store.insert({ slug, name, password_hash: hashPw(pw), bot_user_id: null, data: normData({}) });
      saved.data = normData(saved.data);
      WS.set(saved.id, saved);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, makeSession(saved.id), 2592000) });
    }

    if (p === '/api/auth/login' && M === 'POST') {
      const b = await readJson(req);
      const ws = wsBySlug(String(b.slug || '').trim().toLowerCase());
      if (!ws || !checkPw(b.password || '', ws.password_hash)) {
        await new Promise((r) => setTimeout(r, 600));
        return sendJson(res, 401, { error: 'Workspace ID หรือรหัสผ่านไม่ถูกต้อง' });
      }
      if (ws.data.resetRequest) { delete ws.data.resetRequest; saveWs(ws).catch(() => {}); }
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, makeSession(ws.id), 2592000) });
    }

    if (p === '/api/auth/logout' && M === 'POST') return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });

    // ----- ต้อง login -----
    if (!p.startsWith('/api/')) { res.writeHead(404); return res.end('Not found'); }
    const ws = WS.get(readSession(req));
    if (!ws) return sendJson(res, 401, { error: 'unauthorized' });
    const D = ws.data;

    if (p === '/api/me' && M === 'GET') return sendJson(res, 200, { ok: true, workspace: { id: ws.id, slug: ws.slug, name: ws.name } });
    if (p === '/api/state' && M === 'GET') return sendJson(res, 200, publicState(ws));

    if (p === '/api/auth/password' && M === 'POST') {
      const b = await readJson(req);
      if (!checkPw(b.current || '', ws.password_hash)) return sendJson(res, 400, { error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
      if (String(b.newPassword || '').length < 6) return sendJson(res, 400, { error: 'รหัสผ่านใหม่อย่างน้อย 6 ตัว' });
      ws.password_hash = hashPw(b.newPassword); await saveWs(ws);
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/config' && M === 'POST') {
      const b = await readJson(req);
      if (b.disconnect) {
        delete D.config.tokenEnc; delete D.config.secretEnc; delete D.config.botName; delete D.config.botBasicId;
        ws.bot_user_id = null; await saveWs(ws);
        return sendJson(res, 200, { ok: true });
      }
      if (b.name) ws.name = String(b.name).slice(0, 60);
      if (b.channelAccessToken) D.config.tokenEnc = enc(String(b.channelAccessToken).trim());
      if (b.channelSecret) D.config.secretEnc = enc(String(b.channelSecret).trim());
      if (b.chatBarText) D.config.chatBarText = String(b.chatBarText).slice(0, 14);
      await saveWs(ws);
      let bot = null, warn = '';
      if (b.channelAccessToken) { try { bot = await refreshBotInfo(ws); } catch (e) { warn = e.message; } }
      return sendJson(res, 200, { ok: true, bot, warn });
    }

    if (p === '/api/test-connection' && M === 'POST') {
      try {
        if (!tokenOf(ws)) return sendJson(res, 400, { ok: false, error: 'ยังไม่ได้ใส่ Channel Access Token' });
        const info = await refreshBotInfo(ws);
        return sendJson(res, 200, { ok: true, bot: info });
      } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }

    if (p === '/api/sets' && M === 'POST') {
      const b = await readJson(req);
      const s = newSet(b.name, b.layout, Number(b.tabCount) === 1 ? 1 : 2);
      D.sets[s.id] = s; await saveWs(ws);
      return sendJson(res, 200, { ok: true, id: s.id });
    }

    let m = p.match(/^\/api\/sets\/([^/]+)\/(tab1|tab2)\/image$/);
    if (m) {
      const s = D.sets[m[1]]; if (!s) return sendJson(res, 404, { error: 'ไม่พบชุดเมนู' });
      if (M === 'GET') {
        const buf = await store.getImg(imgKey(ws, s.id, m[2]));
        if (!buf) { res.writeHead(404); return res.end('no image'); }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=600' });
        return res.end(buf);
      }
      if (M === 'POST') {
        const b = await readJson(req);
        const mm = /^data:image\/jpeg;base64,(.+)$/.exec(b.dataUrl || '');
        if (!mm) return sendJson(res, 400, { error: 'รูปต้องเป็น JPEG' });
        const buf = Buffer.from(mm[1], 'base64');
        if (buf.length > 1024 * 1024) return sendJson(res, 400, { error: `รูปใหญ่เกิน 1MB (${Math.round(buf.length / 1024)} KB)` });
        await store.putImg(imgKey(ws, s.id, m[2]), buf);
        s.tabs[m[2]].image = new Date().toISOString();
        s.lastModifiedAt = new Date().toISOString();
        await saveWs(ws);
        return sendJson(res, 200, { ok: true, sizeKB: Math.round(buf.length / 1024) });
      }
    }

    m = p.match(/^\/api\/sets\/([^/]+)$/);
    if (m) {
      const s = D.sets[m[1]];
      if (!s) return sendJson(res, 404, { error: 'ไม่พบชุดเมนู' });
      if (M === 'POST') {
        const b = await readJson(req);
        if (b.name !== undefined) s.name = String(b.name).slice(0, 60);
        if (b.chatBarText !== undefined) s.chatBarText = String(b.chatBarText).slice(0, 14);
        if (b.schedule) s.schedule = { startAt: String(b.schedule.startAt || ''), endAt: String(b.schedule.endAt || '') };
        if (b.tabs) for (const id of ['tab1', 'tab2']) if (b.tabs[id]) {
          const t = s.tabs[id];
          if (b.tabs[id].name !== undefined) t.name = String(b.tabs[id].name).slice(0, 50);
          if (b.tabs[id].template !== undefined) t.template = b.tabs[id].template;
          if (Array.isArray(b.tabs[id].areas)) t.areas = b.tabs[id].areas;
        }
        s.lastModifiedAt = new Date().toISOString();
        await saveWs(ws); return sendJson(res, 200, { ok: true });
      }
      if (M === 'DELETE') {
        if (s.status === 'live') { try { await endSet(ws, s.id); } catch {} }
        await store.delImgs(['tab1', 'tab2'].map((t) => imgKey(ws, s.id, t)));
        delete D.sets[m[1]];
        if (D.defaultSetId === m[1]) D.defaultSetId = null;
        await saveWs(ws); return sendJson(res, 200, { ok: true });
      }
    }

    m = p.match(/^\/api\/sets\/([^/]+)\/draft$/);
    if (m && M === 'POST') {
      const s = D.sets[m[1]]; if (!s) return sendJson(res, 404, { error: 'ไม่พบชุดเมนู' });
      const b = await readJson(req);
      if (b.schedule) s.schedule = { startAt: String(b.schedule.startAt || ''), endAt: String(b.schedule.endAt || '') };
      s.draftSavedAt = new Date().toISOString();
      const start = s.schedule.startAt ? new Date(s.schedule.startAt).getTime() : null;
      if (s.status !== 'live' && start && start > Date.now()) s.status = 'scheduled';
      else if (s.status === 'scheduled' && (!start || start <= Date.now())) s.status = 'draft';
      await saveWs(ws);
      return sendJson(res, 200, { ok: true, draftSavedAt: s.draftSavedAt, status: s.status });
    }

    m = p.match(/^\/api\/sets\/([^/]+)\/publish$/);
    if (m && M === 'POST') {
      try { const r = await publishSet(ws, m[1]); return sendJson(res, 200, { ok: true, logs: r.logs }); }
      catch (e) { return sendJson(res, 400, { ok: false, error: e.message, logs: e.logs || [] }); }
    }

    m = p.match(/^\/api\/sets\/([^/]+)\/end$/);
    if (m && M === 'POST') {
      try { await endSet(ws, m[1]); return sendJson(res, 200, { ok: true }); }
      catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }

    if (p === '/api/live' && M === 'GET') {
      try {
        const token = tokenOf(ws);
        if (!token) return sendJson(res, 400, { ok: false, error: 'ยังไม่ได้ใส่ Channel Access Token' });
        const list = await lineApi('GET', 'https://api.line.me/v2/bot/richmenu/list', { token });
        let defaultId = null;
        try { defaultId = (await lineApi('GET', 'https://api.line.me/v2/bot/user/all/richmenu', { token })).richMenuId; } catch {}
        let aliases = [];
        try { aliases = (await lineApi('GET', 'https://api.line.me/v2/bot/richmenu/alias/list', { token })).aliases || []; } catch {}
        return sendJson(res, 200, { ok: true, richmenus: list.richmenus || [], defaultId, aliases });
      } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }
    m = p.match(/^\/api\/live-image\/([A-Za-z0-9-]+)$/);
    if (m && M === 'GET') {
      try {
        const r = await fetch(`https://api-data.line.me/v2/bot/richmenu/${m[1]}/content`, { headers: { Authorization: `Bearer ${tokenOf(ws)}` } });
        if (!r.ok) { res.writeHead(404); return res.end('no image'); }
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'private, max-age=600' });
        return res.end(buf);
      } catch { res.writeHead(404); return res.end('no image'); }
    }

    if (p === '/api/stats' && M === 'GET') {
      try {
        const rows = await store.clicks(ws.id);
        const agg = {}; const uniq = {};
        for (const r of rows) { agg[r.button_tag] = (agg[r.button_tag] || 0) + 1; (uniq[r.button_tag] = uniq[r.button_tag] || new Set()).add(r.user_id); }
        return sendJson(res, 200, { ok: true, total: rows.length, stats: Object.keys(agg).map((k) => ({ tag: k, clicks: agg[k], unique: uniq[k].size })) });
      } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }

    if (p === '/api/reset-richmenus' && M === 'POST') {
      const logs = [];
      try {
        const token = tokenOf(ws);
        const a = await lineApi('GET', 'https://api.line.me/v2/bot/richmenu/alias/list', { token }).catch(() => ({ aliases: [] }));
        for (const al of a.aliases || []) { await lineApi('DELETE', `https://api.line.me/v2/bot/richmenu/alias/${al.richMenuAliasId}`, { token }).catch(() => {}); logs.push(`ลบ alias ${al.richMenuAliasId}`); }
        const d = await lineApi('GET', 'https://api.line.me/v2/bot/richmenu/list', { token });
        for (const menu of d.richmenus || []) { await lineApi('DELETE', `https://api.line.me/v2/bot/richmenu/${menu.richMenuId}`, { token }).catch(() => {}); logs.push(`ลบ ${menu.richMenuId}`); }
        for (const s of Object.values(D.sets)) if (s.status === 'live') { s.status = 'ended'; s.published = null; }
        D.defaultSetId = null; await saveWs(ws);
        return sendJson(res, 200, { ok: true, logs });
      } catch (e) { return sendJson(res, 400, { ok: false, error: e.message, logs }); }
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: e.message });
  }
});

(async () => {
  try {
    if (USE_SUPA) await ensureBucket();
    const rows = await store.loadAll();
    for (const r of rows) {
      if (r.slug === '_system') { SYS = r; SYS.data = SYS.data || {}; continue; }
      r.data = normData(r.data); WS.set(r.id, r);
    }
    if (!SYS) {
      // ครั้งแรก: สร้างแถวระบบ + รหัสสร้าง workspace แบบสุ่ม (admin เปลี่ยนได้ที่ /admin)
      SYS = await store.insert({ slug: '_system', name: 'system', password_hash: '-', bot_user_id: null, data: { signupCode: (process.env.SIGNUP_CODE || '').trim() || `RM-${randomCode(6)}` } });
      SYS.data = SYS.data || {};
    }
    console.log(`โหลด ${WS.size} workspace (storage: ${USE_SUPA ? 'Supabase' : 'local'})`);
  } catch (e) {
    console.error('❌ โหลดข้อมูลไม่สำเร็จ:', e.message);
  }
  server.listen(PORT, () => console.log(`✅ LINE Richmenu Setting running on :${PORT}`));
})();
