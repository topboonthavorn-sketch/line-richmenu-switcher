/**
 * LINE Rich Menu Manager v2 — บุญถาวร
 * - หลายชุดเมนู (แต่ละชุด 2 แท็บ) + ดูสถานะสดจาก LINE
 * - ตั้งเวลาขึ้น-ลงอัตโนมัติ (scheduler) + กดเองได้
 * - Storage ยืดหยุ่น: ใช้ Supabase ถ้าตั้ง env ไว้ ไม่งั้นเก็บไฟล์ local (free-tier จะหายตอน restart)
 * - webhook เก็บ event การกดปุ่ม (groundwork สำหรับ segment/broadcast)
 * Pure Node.js (ไม่มี dependency) — รันด้วย node server.js (Node 18+)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

const MENU_W = 2500;
const MENU_H = 1686;
const ALIASES = { tab1: 'switcher-tab-1', tab2: 'switcher-tab-2' };

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPA_KEY = process.env.SUPABASE_KEY || '';
const USE_SUPA = !!(SUPA_URL && SUPA_KEY);

// ---------------------------------------------------------------- state
function defaultState() {
  return {
    config: {
      channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN || '',
      channelSecret: process.env.CHANNEL_SECRET || '',
      chatBarText: 'เมนู',
    },
    sets: {},          // id -> set
    defaultSetId: null,
    clicks: [],        // fallback เก็บ event ถ้าไม่ได้ใช้ Supabase (cap)
  };
}

function newTab(name) {
  return { name, template: 'tabbar-6', areas: [], image: null };
}
function newSet(name, layout) {
  const id = crypto.randomUUID();
  const slug = (name || 'menu').toLowerCase().replace(/[^a-z0-9ก-๙]+/gi, '-').replace(/^-|-$/g, '').slice(0, 24) || 'menu';
  const t1 = newTab('แถบ 1'); const t2 = newTab('แถบ 2');
  if (layout) { t1.template = layout; t2.template = layout; }
  return {
    id, name: name || 'ชุดเมนูใหม่', slug,
    chatBarText: 'เมนู',
    schedule: { startAt: '', endAt: '' },
    tabs: { tab1: t1, tab2: t2 },
    status: 'draft',           // draft | scheduled | live | ended
    draftSavedAt: null,
    lastModifiedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    published: null,           // { tab1, tab2, at }
  };
}

let state = defaultState();

// ---------------------------------------------------------------- storage layer
async function sbReq(method, pathq, body, extraPrefer) {
  const headers = {
    apikey: SUPA_KEY,
    Authorization: `Bearer ${SUPA_KEY}`,
    'Content-Type': 'application/json',
  };
  if (method === 'POST') headers.Prefer = 'resolution=merge-duplicates,return=representation';
  if (extraPrefer) headers.Prefer = extraPrefer;
  const res = await fetch(`${SUPA_URL}/rest/v1/${pathq}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text}`);
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

async function loadState() {
  if (USE_SUPA) {
    try {
      const rows = await sbReq('GET', 'app_state?id=eq.main&select=data');
      if (rows && rows[0] && rows[0].data) { state = applyEnv(rows[0].data); return; }
      state = defaultState(); await saveState(); return;
    } catch (e) {
      console.error('โหลดจาก Supabase ไม่สำเร็จ, ใช้ค่าเริ่มต้น:', e.message);
      state = defaultState(); return;
    }
  }
  try { state = applyEnv(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); }
  catch { state = defaultState(); }
}

function applyEnv(s) {
  s = Object.assign(defaultState(), s);
  if (!s.config) s.config = defaultState().config;
  if (process.env.CHANNEL_ACCESS_TOKEN) s.config.channelAccessToken = process.env.CHANNEL_ACCESS_TOKEN;
  if (process.env.CHANNEL_SECRET) s.config.channelSecret = process.env.CHANNEL_SECRET;
  if (!s.sets) s.sets = {};
  if (!Array.isArray(s.clicks)) s.clicks = [];
  return s;
}

let saveQueued = false;
async function saveState() {
  if (USE_SUPA) {
    try { await sbReq('POST', 'app_state', [{ id: 'main', data: state, updated_at: new Date().toISOString() }]); }
    catch (e) { console.error('บันทึก Supabase ไม่สำเร็จ:', e.message); }
    return;
  }
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (e) { console.error(e.message); }
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

function dataUrlToBuffer(dataUrl) {
  const m = /^data:image\/jpeg;base64,(.+)$/.exec(dataUrl || '');
  return m ? Buffer.from(m[1], 'base64') : null;
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
      case 'track': action = { type: 'postback', data: a.action.value || 'btn', displayText: undefined }; break;
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
  for (const id of ['tab1', 'tab2']) {
    const t = s.tabs[id];
    if (!t.image) throw new Error(`${t.name}: ยังไม่ได้อัปโหลดรูป`);
    if (!t.areas || !t.areas.length) throw new Error(`${t.name}: ยังไม่ได้กำหนดปุ่ม`);
    if (!t.areas.some((a) => a.action.type === 'switch'))
      throw new Error(`${t.name}: ต้องมีปุ่ม "สลับแท็บ" อย่างน้อย 1 ปุ่ม`);
    t.areas.forEach((a, i) => {
      const n = i + 1; const v = String((a.action && a.action.value) || '').trim();
      if (a.action.type === 'none' || a.action.type === 'switch') return;
      if (a.action.type === 'uri' || a.action.type === 'track') {
        const placeholder = v === '' || v === 'https://' || v === 'http://';
        const valid = /^(https?:\/\/.+|line:\/\/.+|tel:.+|mailto:.+)/i.test(v);
        if (placeholder || !valid) throw new Error(`${t.name} — ปุ่มที่ ${n}: ยังไม่ได้ใส่ลิงก์ (ใส่ URL เต็ม เช่น https://www.example.com)`);
      }
      if (a.action.type === 'message' && !v) throw new Error(`${t.name} — ปุ่มที่ ${n}: ยังไม่ได้ใส่ข้อความ`);
    });
  }
}

async function publishSet(setId, { auto = false } = {}) {
  const logs = []; const log = (m) => logs.push(m);
  const token = state.config.channelAccessToken;
  if (!token) throw Object.assign(new Error('ยังไม่ได้ตั้งค่า Channel Access Token'), { logs });
  const s = state.sets[setId];
  if (!s) throw Object.assign(new Error('ไม่พบชุดเมนู'), { logs });
  if (!auto) {
    if (!s.draftSavedAt || (s.lastModifiedAt && s.draftSavedAt < s.lastModifiedAt))
      throw Object.assign(new Error('กรุณากด "บันทึกแบบร่าง" ก่อน Deploy'), { logs });
  }
  validateSet(s);

  const prevDefault = state.defaultSetId && state.sets[state.defaultSetId];
  const oldPublished = s.published;
  const newIds = {};
  try {
    for (const id of ['tab1', 'tab2']) {
      const t = s.tabs[id];
      const menu = {
        size: { width: MENU_W, height: MENU_H }, selected: true,
        name: `${s.slug}-${id}-${Date.now()}`.slice(0, 300),
        chatBarText: s.chatBarText || state.config.chatBarText || 'เมนู',
        areas: buildLineAreas(t),
      };
      const { richMenuId } = await lineApi('POST', 'https://api.line.me/v2/bot/richmenu', { token, body: menu });
      log(`สร้าง rich menu "${t.name}" (${richMenuId})`);
      const imgBuf = dataUrlToBuffer(t.image);
      if (!imgBuf) throw new Error(`${t.name}: รูปไม่ถูกต้อง`);
      await lineApi('POST', `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, { token, rawBody: imgBuf, contentType: 'image/jpeg' });
      log(`อัปโหลดรูป "${t.name}" (${Math.round(imgBuf.length / 1024)} KB)`);
      newIds[id] = richMenuId;
    }
    await ensureAlias(token, ALIASES.tab1, newIds.tab1, log);
    await ensureAlias(token, ALIASES.tab2, newIds.tab2, log);
    await lineApi('POST', `https://api.line.me/v2/bot/user/all/richmenu/${newIds.tab1}`, { token });
    log('ตั้งเป็นเมนูเริ่มต้นของผู้ใช้ทุกคนแล้ว');

    // ลบเมนูเก่าของชุดนี้
    if (oldPublished) for (const id of ['tab1', 'tab2']) {
      const oid = oldPublished[id];
      if (oid && oid !== newIds[id]) { try { await lineApi('DELETE', `https://api.line.me/v2/bot/richmenu/${oid}`, { token }); } catch {} }
    }
    // ชุด default เดิม (ถ้าเป็นคนละชุด) → ปลดสถานะ + ลบเมนูมันออกจาก channel
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
    state.defaultSetId = s.id;
    await saveState();
    return { logs };
  } catch (e) {
    for (const idv of Object.values(newIds)) { try { await lineApi('DELETE', `https://api.line.me/v2/bot/richmenu/${idv}`, { token }); } catch {} }
    e.logs = logs; throw e;
  }
}

async function endSet(setId) {
  const token = state.config.channelAccessToken;
  const s = state.sets[setId]; if (!s) return;
  try { await lineApi('DELETE', 'https://api.line.me/v2/bot/user/all/richmenu', { token }); } catch {}
  if (s.published) for (const id of ['tab1', 'tab2']) {
    const oid = s.published[id]; if (oid) { try { await lineApi('DELETE', `https://api.line.me/v2/bot/richmenu/${oid}`, { token }); } catch {} }
  }
  s.status = 'ended'; s.published = null;
  if (state.defaultSetId === s.id) state.defaultSetId = null;
  await saveState();
}

// ---------------------------------------------------------------- scheduler
let ticking = false;
async function tick() {
  if (ticking || !state.config.channelAccessToken) return;
  ticking = true;
  const now = Date.now();
  try {
    for (const s of Object.values(state.sets)) {
      const start = s.schedule && s.schedule.startAt ? new Date(s.schedule.startAt).getTime() : null;
      const end = s.schedule && s.schedule.endAt ? new Date(s.schedule.endAt).getTime() : null;
      if (s.status === 'scheduled' && start && start <= now && (!end || end > now)) {
        try { await publishSet(s.id, { auto: true }); } catch (e) { console.error('auto publish', e.message); }
      }
      if (s.status === 'live' && end && end <= now) {
        try { await endSet(s.id); } catch (e) { console.error('auto end', e.message); }
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
function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon' };
function serveFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// คืน state เบาๆ (ไม่แนบ base64 รูป — ใช้ URL แทน)
function publicState() {
  const s = JSON.parse(JSON.stringify(state));
  const tkn = s.config.channelAccessToken;
  s.config.tokenSet = !!tkn;
  s.config.tokenHint = tkn ? '••••••' + tkn.slice(-6) : '';
  s.config.secretSet = !!s.config.channelSecret;
  delete s.config.channelAccessToken; delete s.config.channelSecret;
  delete s.clicks;
  s.storage = USE_SUPA ? 'supabase' : 'local';
  for (const set of Object.values(s.sets)) {
    for (const id of ['tab1', 'tab2']) {
      const t = set.tabs[id];
      t.hasImage = !!t.image;
      t.image = t.image ? `/api/sets/${set.id}/${id}/image?t=${Date.parse(set.lastModifiedAt) || 0}` : null;
    }
  }
  return s;
}

// ---------------------------------------------------------------- webhook tracking
function recordClick(ev, destination) {
  const userId = ev.source && ev.source.userId;
  if (!userId) return;
  const data = (ev.postback && ev.postback.data) || '';
  const tag = /(?:^|[&;])(?:btn|tag)=([^&;]+)/.exec(data);
  const sw = /switch=(tab\d)/.exec(data);
  const row = { user_id: userId, button_tag: tag ? decodeURIComponent(tag[1]) : (sw ? 'switch:' + sw[1] : data || 'postback'), tab: sw ? sw[1] : '', clicked_at: new Date(ev.timestamp || Date.now()).toISOString(), destination };
  if (USE_SUPA) { sbReq('POST', 'click_events', [row], 'return=minimal').catch(() => {}); }
  else { state.clicks.push(row); if (state.clicks.length > 5000) state.clicks.shift(); saveState(); }
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    // webhook + health ไม่ต้อง auth
    if (p === '/webhook' && req.method === 'POST') {
      const raw = await readBody(req);
      // verify signature ถ้ามี channelSecret
      if (state.config.channelSecret) {
        const sig = crypto.createHmac('SHA256', state.config.channelSecret).update(raw).digest('base64');
        if (sig !== req.headers['x-line-signature']) { res.writeHead(401); return res.end('bad signature'); }
      }
      let body = {}; try { body = JSON.parse(raw.toString() || '{}'); } catch {}
      for (const ev of body.events || []) { if (ev.type === 'postback') recordClick(ev, body.destination); }
      res.writeHead(200); return res.end('OK');
    }
    if (p === '/health' || p === '/cron') { tick().catch(() => {}); res.writeHead(200); return res.end('ok'); }

    // basic auth (admin)
    if (ADMIN_PASSWORD) {
      const [scheme, encoded] = (req.headers.authorization || '').split(' ');
      const pass = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':') : '';
      if (pass !== ADMIN_PASSWORD) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="RichMenu"' }); return res.end('Authentication required'); }
    }

    // static
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const root = path.join(__dirname, 'index.html');
      return serveFile(res, fs.existsSync(root) ? root : path.join(__dirname, 'public', 'index.html'));
    }

    // serve stored image of a set tab
    let m = p.match(/^\/api\/sets\/([^/]+)\/(tab1|tab2)\/image$/);
    if (m && req.method === 'GET') {
      const set = state.sets[m[1]];
      const buf = set && dataUrlToBuffer(set.tabs[m[2]].image);
      if (!buf) { res.writeHead(404); return res.end('no image'); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' });
      return res.end(buf);
    }

    // ---------- API ----------
    if (p === '/api/state' && req.method === 'GET') return sendJson(res, 200, publicState());

    if (p === '/api/config' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      if (b.channelAccessToken) state.config.channelAccessToken = String(b.channelAccessToken).trim();
      if (b.channelSecret !== undefined) state.config.channelSecret = String(b.channelSecret).trim();
      if (b.chatBarText) state.config.chatBarText = String(b.chatBarText).slice(0, 14);
      await saveState(); return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/test-connection' && req.method === 'POST') {
      try {
        const token = state.config.channelAccessToken;
        if (!token) return sendJson(res, 400, { ok: false, error: 'ยังไม่ได้ใส่ Channel Access Token' });
        const info = await lineApi('GET', 'https://api.line.me/v2/bot/info', { token });
        return sendJson(res, 200, { ok: true, bot: info });
      } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }

    // create set
    if (p === '/api/sets' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const s = newSet(b.name, b.layout);
      state.sets[s.id] = s; await saveState();
      return sendJson(res, 200, { ok: true, id: s.id });
    }

    // set-level ops
    m = p.match(/^\/api\/sets\/([^/]+)$/);
    if (m) {
      const s = state.sets[m[1]];
      if (!s) return sendJson(res, 404, { error: 'ไม่พบชุดเมนู' });
      if (req.method === 'POST') {
        const b = JSON.parse((await readBody(req)).toString() || '{}');
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
        await saveState(); return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        if (s.status === 'live') { try { await endSet(s.id); } catch {} }
        delete state.sets[m[1]];
        if (state.defaultSetId === m[1]) state.defaultSetId = null;
        await saveState(); return sendJson(res, 200, { ok: true });
      }
    }

    // image upload for a set tab
    m = p.match(/^\/api\/sets\/([^/]+)\/(tab1|tab2)\/image$/);
    if (m && req.method === 'POST') {
      const s = state.sets[m[1]]; if (!s) return sendJson(res, 404, { error: 'ไม่พบชุดเมนู' });
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      const buf = dataUrlToBuffer(b.dataUrl);
      if (!buf) return sendJson(res, 400, { error: 'รูปต้องเป็น JPEG' });
      if (buf.length > 1024 * 1024) return sendJson(res, 400, { error: `รูปใหญ่เกิน 1MB (${Math.round(buf.length / 1024)} KB)` });
      s.tabs[m[2]].image = b.dataUrl;
      s.lastModifiedAt = new Date().toISOString();
      await saveState();
      return sendJson(res, 200, { ok: true, sizeKB: Math.round(buf.length / 1024) });
    }

    // save draft (+schedule) ; optionally mark scheduled
    m = p.match(/^\/api\/sets\/([^/]+)\/draft$/);
    if (m && req.method === 'POST') {
      const s = state.sets[m[1]]; if (!s) return sendJson(res, 404, { error: 'ไม่พบชุดเมนู' });
      const b = JSON.parse((await readBody(req)).toString() || '{}');
      if (b.schedule) s.schedule = { startAt: String(b.schedule.startAt || ''), endAt: String(b.schedule.endAt || '') };
      s.draftSavedAt = new Date().toISOString();
      // ถ้ามีเวลาเริ่มในอนาคต และยังไม่ live → ตั้งเป็น scheduled
      const start = s.schedule.startAt ? new Date(s.schedule.startAt).getTime() : null;
      if (s.status !== 'live' && start && start > Date.now()) s.status = 'scheduled';
      else if (s.status === 'scheduled' && (!start || start <= Date.now())) s.status = 'draft';
      await saveState();
      return sendJson(res, 200, { ok: true, draftSavedAt: s.draftSavedAt, status: s.status });
    }

    // publish set now
    m = p.match(/^\/api\/sets\/([^/]+)\/publish$/);
    if (m && req.method === 'POST') {
      try { const r = await publishSet(m[1]); return sendJson(res, 200, { ok: true, logs: r.logs }); }
      catch (e) { return sendJson(res, 400, { ok: false, error: e.message, logs: e.logs || [] }); }
    }

    // take a set down now
    m = p.match(/^\/api\/sets\/([^/]+)\/end$/);
    if (m && req.method === 'POST') {
      try { await endSet(m[1]); return sendJson(res, 200, { ok: true }); }
      catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }

    // live from LINE (เมนูจริงบน OA)
    if (p === '/api/live' && req.method === 'GET') {
      try {
        const token = state.config.channelAccessToken;
        const list = await lineApi('GET', 'https://api.line.me/v2/bot/richmenu/list', { token });
        let defaultId = null;
        try { const d = await lineApi('GET', 'https://api.line.me/v2/bot/user/all/richmenu', { token }); defaultId = d.richMenuId; }
        catch {}
        let aliases = [];
        try { const a = await lineApi('GET', 'https://api.line.me/v2/bot/richmenu/alias/list', { token }); aliases = a.aliases || []; }
        catch {}
        return sendJson(res, 200, { ok: true, richmenus: list.richmenus || [], defaultId, aliases });
      } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }
    // proxy image of a live rich menu
    m = p.match(/^\/api\/live-image\/([^/]+)$/);
    if (m && req.method === 'GET') {
      try {
        const token = state.config.channelAccessToken;
        const r = await fetch(`https://api-data.line.me/v2/bot/richmenu/${m[1]}/content`, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) { res.writeHead(404); return res.end('no image'); }
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'no-cache' });
        return res.end(buf);
      } catch { res.writeHead(404); return res.end('no image'); }
    }

    // stats: click counts by tag (จาก Supabase หรือ local)
    if (p === '/api/stats' && req.method === 'GET') {
      try {
        if (USE_SUPA) {
          const rows = await sbReq('GET', 'click_events?select=button_tag,user_id');
          const agg = {}; const uniq = {};
          for (const r of rows || []) {
            agg[r.button_tag] = (agg[r.button_tag] || 0) + 1;
            (uniq[r.button_tag] = uniq[r.button_tag] || new Set()).add(r.user_id);
          }
          const out = Object.keys(agg).map((k) => ({ tag: k, clicks: agg[k], unique: uniq[k].size }));
          return sendJson(res, 200, { ok: true, stats: out, total: (rows || []).length });
        } else {
          const agg = {}; const uniq = {};
          for (const r of state.clicks) { agg[r.button_tag] = (agg[r.button_tag] || 0) + 1; (uniq[r.button_tag] = uniq[r.button_tag] || new Set()).add(r.user_id); }
          const out = Object.keys(agg).map((k) => ({ tag: k, clicks: agg[k], unique: uniq[k].size }));
          return sendJson(res, 200, { ok: true, stats: out, total: state.clicks.length });
        }
      } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    }

    // reset everything on channel
    if (p === '/api/reset-richmenus' && req.method === 'POST') {
      const logs = [];
      try {
        const token = state.config.channelAccessToken;
        const a = await lineApi('GET', 'https://api.line.me/v2/bot/richmenu/alias/list', { token }).catch(() => ({ aliases: [] }));
        for (const al of a.aliases || []) { await lineApi('DELETE', `https://api.line.me/v2/bot/richmenu/alias/${al.richMenuAliasId}`, { token }).catch(() => {}); logs.push(`ลบ alias ${al.richMenuAliasId}`); }
        const d = await lineApi('GET', 'https://api.line.me/v2/bot/richmenu/list', { token });
        for (const menu of d.richmenus || []) { await lineApi('DELETE', `https://api.line.me/v2/bot/richmenu/${menu.richMenuId}`, { token }).catch(() => {}); logs.push(`ลบ ${menu.richMenuId}`); }
        for (const s of Object.values(state.sets)) { if (s.status === 'live') { s.status = 'ended'; s.published = null; } }
        state.defaultSetId = null; await saveState();
        return sendJson(res, 200, { ok: true, logs });
      } catch (e) { return sendJson(res, 400, { ok: false, error: e.message, logs }); }
    }

    res.writeHead(404); res.end('Not found');
  } catch (e) { sendJson(res, 500, { error: e.message }); }
});

loadState().then(() => {
  server.listen(PORT, () => console.log(`✅ Rich Menu Manager v2 running on :${PORT} (storage: ${USE_SUPA ? 'Supabase' : 'local'})`));
});
