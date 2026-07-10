/**
 * LINE Rich Menu Switcher — Admin Backend (zero-dependency, pure Node.js)
 * สำหรับ LINE OA: TOP TEST 3
 *
 *  - Config หน้าเว็บสำหรับใส่ Channel Access Token / Channel Secret
 *  - Upload รูป rich menu แถบ 1 / แถบ 2 (browser ย่อ/ครอปเป็น 2500x1686 + บีบอัด <1MB ให้เอง)
 *  - เลือก template ปุ่ม หรือวาดพื้นที่ปุ่มเอง
 *  - Publish: สร้าง rich menu 2 อัน + upload รูป + สร้าง alias + ตั้ง default
 *  - สลับแท็บด้วย action "richmenuswitch" (ไม่ต้องมี webhook)
 *
 * รันด้วย:  node server.js   (Node 18+ — ไม่ต้อง npm install)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MENU_W = 2500;
const MENU_H = 1686;
const ALIASES = { tab1: 'switcher-tab-1', tab2: 'switcher-tab-2' };

// ---------------------------------------------------------------- state
function defaultState() {
  return {
    config: {
      channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN || '',
      channelSecret: process.env.CHANNEL_SECRET || '',
      chatBarText: 'เมนู',
    },
    tabs: {
      tab1: { name: 'แถบ 1', template: 'tabbar-6', image: null, areas: [] },
      tab2: { name: 'แถบ 2', template: 'tabbar-6', image: null, areas: [] },
    },
    published: null,
  };
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (process.env.CHANNEL_ACCESS_TOKEN) s.config.channelAccessToken = process.env.CHANNEL_ACCESS_TOKEN;
    if (process.env.CHANNEL_SECRET) s.config.channelSecret = process.env.CHANNEL_SECRET;
    return s;
  } catch {
    return defaultState();
  }
}
function saveState() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
let state = loadState();

// ---------------------------------------------------------------- LINE API helper
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

// ---------------------------------------------------------------- publish helpers
function buildLineAreas(tab) {
  return tab.areas.map((a) => {
    const x = Math.max(0, Math.round(a.x));
    const y = Math.max(0, Math.round(a.y));
    const bounds = {
      x, y,
      width: Math.min(Math.round(a.w), MENU_W - x),
      height: Math.min(Math.round(a.h), MENU_H - y),
    };
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
    await lineApi('POST', 'https://api.line.me/v2/bot/richmenu/alias', {
      token, body: { richMenuAliasId: aliasId, richMenuId },
    });
    log(`สร้าง alias "${aliasId}" สำเร็จ`);
  } catch (e) {
    if (e.status === 400 || e.status === 409) {
      await lineApi('POST', `https://api.line.me/v2/bot/richmenu/alias/${aliasId}`, { token, body: { richMenuId } });
      log(`อัปเดต alias "${aliasId}" สำเร็จ`);
    } else throw e;
  }
}

async function publish() {
  const logs = [];
  const log = (m) => logs.push(m);
  const token = state.config.channelAccessToken;
  if (!token) throw Object.assign(new Error('ยังไม่ได้ตั้งค่า Channel Access Token (ขั้นตอนที่ 1)'), { logs });
  for (const id of ['tab1', 'tab2']) {
    const t = state.tabs[id];
    if (!t.image) throw Object.assign(new Error(`${t.name}: ยังไม่ได้อัปโหลดรูป`), { logs });
    if (!t.areas.length) throw Object.assign(new Error(`${t.name}: ยังไม่ได้กำหนดปุ่ม`), { logs });
    if (!t.areas.some((a) => a.action.type === 'switch'))
      throw Object.assign(new Error(`${t.name}: ต้องมีปุ่ม "สลับแท็บ" อย่างน้อย 1 ปุ่ม`), { logs });
  }

  const oldPublished = state.published;
  const newIds = {};
  try {
    for (const id of ['tab1', 'tab2']) {
      const t = state.tabs[id];
      const menu = {
        size: { width: MENU_W, height: MENU_H },
        selected: true,
        name: `${id}-${Date.now()}`,
        chatBarText: state.config.chatBarText || 'เมนู',
        areas: buildLineAreas(t),
      };
      const { richMenuId } = await lineApi('POST', 'https://api.line.me/v2/bot/richmenu', { token, body: menu });
      log(`สร้าง rich menu "${t.name}" สำเร็จ (${richMenuId})`);

      const imgBuf = fs.readFileSync(path.join(UPLOAD_DIR, t.image));
      await lineApi('POST', `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
        token, rawBody: imgBuf, contentType: 'image/jpeg',
      });
      log(`อัปโหลดรูป "${t.name}" สำเร็จ (${Math.round(imgBuf.length / 1024)} KB)`);
      newIds[id] = richMenuId;
    }

    await ensureAlias(token, ALIASES.tab1, newIds.tab1, log);
    await ensureAlias(token, ALIASES.tab2, newIds.tab2, log);

    await lineApi('POST', `https://api.line.me/v2/bot/user/all/richmenu/${newIds.tab1}`, { token });
    log('ตั้ง "แถบ 1" เป็นเมนูเริ่มต้นของผู้ใช้ทุกคนแล้ว');

    if (oldPublished) {
      for (const id of ['tab1', 'tab2']) {
        const oldId = oldPublished[id];
        if (oldId && oldId !== newIds[id]) {
          try {
            await lineApi('DELETE', `https://api.line.me/v2/bot/richmenu/${oldId}`, { token });
            log(`ลบ rich menu เก่า (${oldId}) แล้ว`);
          } catch (e) { log(`ข้ามการลบเมนูเก่า: ${e.message}`); }
        }
      }
    }
    state.published = { ...newIds, at: new Date().toISOString() };
    saveState();
    return { logs, published: state.published };
  } catch (e) {
    e.logs = logs;
    throw e;
  }
}

// ---------------------------------------------------------------- HTTP plumbing
function readBody(req, limit = 6 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// ---------------------------------------------------------------- server
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const server = http.createServer(async (req, res) => {
  try {
    // optional basic auth
    if (ADMIN_PASSWORD) {
      const [scheme, encoded] = (req.headers.authorization || '').split(' ');
      const pass = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':') : '';
      if (pass !== ADMIN_PASSWORD) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="RichMenu Admin"' });
        return res.end('Authentication required');
      }
    }

    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    // ---------- static ----------
    if (req.method === 'GET' && (p === '/' || p === '/index.html'))
      return serveFile(res, path.join(__dirname, 'public', 'index.html'));
    if (req.method === 'GET' && p.startsWith('/uploads/')) {
      const name = path.basename(p); // prevent traversal
      return serveFile(res, path.join(UPLOAD_DIR, name));
    }

    // ---------- API ----------
    if (p === '/api/state' && req.method === 'GET') {
      const s = JSON.parse(JSON.stringify(state));
      const t = s.config.channelAccessToken;
      s.config.tokenSet = !!t;
      s.config.tokenHint = t ? '••••••' + t.slice(-6) : '';
      delete s.config.channelAccessToken;
      s.config.secretSet = !!s.config.channelSecret;
      delete s.config.channelSecret;
      return sendJson(res, 200, s);
    }

    if (p === '/api/config' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      if (body.channelAccessToken) state.config.channelAccessToken = String(body.channelAccessToken).trim();
      if (body.channelSecret !== undefined) state.config.channelSecret = String(body.channelSecret).trim();
      if (body.chatBarText) state.config.chatBarText = String(body.chatBarText).slice(0, 14);
      saveState();
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/test-connection' && req.method === 'POST') {
      try {
        const token = state.config.channelAccessToken;
        if (!token) return sendJson(res, 400, { ok: false, error: 'ยังไม่ได้ใส่ Channel Access Token' });
        const info = await lineApi('GET', 'https://api.line.me/v2/bot/info', { token });
        return sendJson(res, 200, { ok: true, bot: info });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message });
      }
    }

    // save tab settings
    let m = p.match(/^\/api\/tabs\/(tab1|tab2)$/);
    if (m && req.method === 'POST') {
      const tab = state.tabs[m[1]];
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      if (body.name !== undefined) tab.name = String(body.name).slice(0, 50);
      if (body.template !== undefined) tab.template = body.template;
      if (Array.isArray(body.areas)) tab.areas = body.areas;
      saveState();
      return sendJson(res, 200, { ok: true });
    }

    // upload image: JSON { dataUrl: "data:image/jpeg;base64,..." } (browser already resized to 2500x1686, <1MB)
    m = p.match(/^\/api\/tabs\/(tab1|tab2)\/image$/);
    if (m && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const match = /^data:image\/jpeg;base64,(.+)$/.exec(body.dataUrl || '');
      if (!match) return sendJson(res, 400, { error: 'รูปไม่ถูกต้อง (ต้องเป็น JPEG)' });
      const buf = Buffer.from(match[1], 'base64');
      if (buf.length > 1024 * 1024) return sendJson(res, 400, { error: `รูปใหญ่เกิน 1MB (${Math.round(buf.length / 1024)} KB)` });
      const filename = `${m[1]}.jpg`;
      fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
      state.tabs[m[1]].image = filename;
      saveState();
      return sendJson(res, 200, { ok: true, url: `/uploads/${filename}?t=${Date.now()}`, sizeKB: Math.round(buf.length / 1024) });
    }

    if (p === '/api/publish' && req.method === 'POST') {
      try {
        const result = await publish();
        return sendJson(res, 200, { ok: true, ...result });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message, logs: e.logs || [] });
      }
    }

    if (p === '/api/richmenus' && req.method === 'GET') {
      try {
        const data = await lineApi('GET', 'https://api.line.me/v2/bot/richmenu/list', { token: state.config.channelAccessToken });
        return sendJson(res, 200, { ok: true, richmenus: data.richmenus || [] });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message });
      }
    }

    if (p === '/api/reset-richmenus' && req.method === 'POST') {
      const logs = [];
      try {
        const token = state.config.channelAccessToken;
        const aliasData = await lineApi('GET', 'https://api.line.me/v2/bot/richmenu/alias/list', { token }).catch(() => ({ aliases: [] }));
        for (const a of aliasData.aliases || []) {
          await lineApi('DELETE', `https://api.line.me/v2/bot/richmenu/alias/${a.richMenuAliasId}`, { token }).catch(() => {});
          logs.push(`ลบ alias ${a.richMenuAliasId}`);
        }
        const data = await lineApi('GET', 'https://api.line.me/v2/bot/richmenu/list', { token });
        for (const menu of data.richmenus || []) {
          await lineApi('DELETE', `https://api.line.me/v2/bot/richmenu/${menu.richMenuId}`, { token }).catch(() => {});
          logs.push(`ลบ rich menu ${menu.richMenuId}`);
        }
        state.published = null;
        saveState();
        return sendJson(res, 200, { ok: true, logs });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message, logs });
      }
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`✅ Rich Menu Switcher admin running on http://localhost:${PORT}`);
});
