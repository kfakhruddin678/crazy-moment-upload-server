/**
 * Crazy Moment Photo Print Station — Cloud Server (Fasa 1)
 * --------------------------------------------------------------------
 * Satu server untuk TIGA pihak:
 *   • Telefon pelanggan  → scan QR & upload gambar           (/u/:id, /api/sessions/...)
 *   • Kiosk              → tarik config, heartbeat, lapor order (/api/kiosk/...)
 *   • Admin Dashboard    → urus produk, templat, kiosk, order  (/admin, /api/admin/...)
 *
 * Storan: PostgreSQL jika DATABASE_URL diset, jika tidak fail JSON (sementara). Lihat store.js.
 * Gambar pelanggan kekal dalam MEMORI sahaja dan dipadam selepas cetak/tamat sesi (PDPA).
 *
 * Environment Variables (Render → Environment):
 *   DATABASE_URL     Internal Database URL dari Render Postgres (DISYORKAN)
 *   ADMIN_EMAIL      emel Super Admin pertama   (lalai: admin@crazymoment.my)
 *   ADMIN_PASSWORD   kata laluan Super Admin pertama (lalai: crazymoment123 — wajib tukar semasa log masuk)
 *   KIOSK_API_KEY    (pilihan, cara lama) satu kunci untuk semua kiosk
 *   PUBLIC_URL       (pilihan) https://crazy-moment-upload-server.onrender.com
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./store');

// ---------- Config ----------
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const GLOBAL_KIOSK_KEY = process.env.KIOSK_API_KEY || '';
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 15);
const MAX_ASSET_MB = 6;
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 60);
const GRACE_MS = 5 * 60_000;
const ONLINE_MS = 90_000;          // kiosk dianggap offline jika tiada heartbeat > 90 saat
const TZ_OFFSET_MS = 8 * 3600_000; // Asia/Kuala_Lumpur (UTC+8, tiada DST)
const APP_VERSION = '1.1.0';

const store = new Store();

// Susun atur (layout) yang disokong oleh enjin cetak kiosk. Bilangan gambar & saiz
// ditentukan oleh layout — dashboard tak boleh ubah (kiosk akan rosak jika berbeza).
const LAYOUTS = {
  strip:  { name: 'Photo Strip',   photos: 4,  size: '2 × 6 inch', output: '2 strips', legacyKey: 'photo-strip' },
  duo:    { name: 'Duo Photo',     photos: 2,  size: '4 × 6 inch', output: '1 print',  legacyKey: 'duo-photo' },
  single: { name: 'Single Photo',  photos: 1,  size: '4 × 6 inch', output: '1 print',  legacyKey: 'single-photo' },
  grid12: { name: '12 Photo Grid', photos: 12, size: '4 × 6 inch', output: '1 print',  legacyKey: 'photo-grid-12' },
};
const LEGACY_KEYS = Object.fromEntries(Object.entries(LAYOUTS).map(([k, v]) => [v.legacyKey, k]));
const ALLOWED_MIME = /^image\/(jpeg|png|webp|heic|heif)$/i;
const ASSET_MIME = /^image\/(jpeg|png|webp)$/i;

// ---------- Helpers ----------
const newId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');
const now = () => Date.now();
const iso = (t) => new Date(t).toISOString();
const dayKey = (t) => new Date(t + TZ_OFFSET_MS).toISOString().slice(0, 10);   // YYYY-MM-DD waktu Malaysia
const hourOf = (t) => new Date(t + TZ_OFFSET_MS).getUTCHours();
const dayStart = (key) => Date.parse(key + 'T00:00:00Z') - TZ_OFFSET_MS;
const addDays = (key, n) => dayKey(dayStart(key) + n * 86400_000 + 3600_000);
const str = (v, max = 200) => (v == null ? '' : String(v)).trim().slice(0, max);
const num = (v, min, max, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };
const money = (n) => Math.round(Number(n || 0) * 100) / 100;
const pct = (a, b) => (b ? Math.round(((a - b) / b) * 1000) / 10 : null);
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

// ================================================================
//  SEED — data awal (sama seperti yang ditulis dalam kiosk software)
// ================================================================
const SEED_PRODUCTS = [
  { id: 'strip',  layout: 'strip',  name: 'Photo Strip',   description: '2 strips per print (4 photos each)', price: 15, icon: '🎞️', popular: true,  gradient: 'linear-gradient(160deg,#F2C879,#C98D00)' },
  { id: 'duo',    layout: 'duo',    name: 'Duo Photo',     description: '1 print per order',                  price: 15, icon: '🖇️', popular: false, gradient: 'linear-gradient(160deg,#8CA9E0,#3F5B99)' },
  { id: 'single', layout: 'single', name: 'Single Photo',  description: '1 print per order',                  price: 15, icon: '🙂', popular: false, gradient: 'linear-gradient(160deg,#7ECB9A,#2E7D53)' },
  { id: 'grid12', layout: 'grid12', name: '12 Photo Grid', description: '1 print per order',                  price: 20, icon: '🔳', popular: false, gradient: 'linear-gradient(160deg,#E888B4,#B23D6E)' },
];
const SEED_TEMPLATES = [
  { id: 'classic',   name: 'Classic',      scope: 'simple', category: 'General', bg: '#F3EEE2', pattern: 'none', textColor: 'var(--grey)' },
  { id: 'minimal',   name: 'Minimal',      scope: 'simple', category: 'General', bg: '#FFFFFF', pattern: 'none', textColor: 'var(--grey)' },
  { id: 'frame',     name: 'Frame Pink',   scope: 'simple', category: 'General', bg: 'linear-gradient(135deg,#FBD8E6,#FCE9F0)', pattern: 'none', textColor: 'var(--grey)' },
  { id: 'travel',    name: 'Travel Green', scope: 'simple', category: 'Travel',  bg: 'linear-gradient(135deg,#DCEBD8,#F1F7EE)', pattern: 'none', textColor: 'var(--grey)' },
  { id: 'sunset',    name: 'Sunset',       scope: 'simple', category: 'Travel',  bg: 'linear-gradient(135deg,#FBE3C7,#FCEFE0)', pattern: 'none', textColor: 'var(--grey)' },
  { id: 'night',     name: 'Night',        scope: 'simple', category: 'General', bg: '#17130E', pattern: 'none', textColor: 'rgba(255,255,255,0.65)' },
  { id: 'retroDots', name: 'Retro Dots',   scope: 'simple', category: 'Event',   bg: '#17130E', pattern: 'dots', patternColor: 'rgba(255,255,255,0.22)', textColor: 'rgba(255,255,255,0.7)' },
  { id: 'goldFrame', name: 'Gold Frame',   scope: 'simple', category: 'Event',   bg: 'linear-gradient(160deg,#D9AA4F,#B9812E)', pattern: 'none', textColor: '#3A2A0E' },
  { id: 'special-grid12-sweet', name: 'Sweet Grid', scope: 'special', layouts: ['grid12'], category: 'General', bg: '#FFFFFF', pattern: 'none', textColor: 'var(--grey)',
    corners: [{ pos: 'tl', type: 'icon', icon: 'heart', color: '#D6473C', size: 16 }, { pos: 'tr', type: 'icon', icon: 'smiley', color: '#3F5B99', size: 20 }],
    captions: [{ pos: 'bl', text: 'Good Friends\nGreat Moments', icon: 'heart' }, { pos: 'br', text: 'Collect Moments\nNot Things' }] },
  { id: 'special-duo-goodtimes', name: 'Good Times', scope: 'special', layouts: ['duo'], category: 'General', bg: '#FFFFFF', pattern: 'none', textColor: 'var(--grey)',
    corners: [{ pos: 'tl', type: 'splash', color: '#F5D06B' }, { pos: 'br', type: 'splash', color: '#F3AFC4' }],
    captions: [{ pos: 'bl', text: 'Good Times\nTogether', icon: 'heart' }] },
  { id: 'special-strip-hearts', name: 'Strip Hearts', scope: 'special', layouts: ['strip'], category: 'General', bg: '#F3EEE2', pattern: 'none', textColor: 'var(--grey)',
    corners: [{ pos: 'bl', type: 'icon', icon: 'heart', color: '#D6473C', size: 12 }, { pos: 'br', type: 'icon', icon: 'heart', color: '#D6473C', size: 12 }] },
  { id: 'special-single-capture', name: 'Capture Today', scope: 'special', layouts: ['single'], category: 'General', bg: '#FFFFFF', pattern: 'none', textColor: 'var(--grey)',
    corners: [{ pos: 'tl', type: 'splash', color: '#9FC6E8' }, { pos: 'tr', type: 'splash', color: '#F3AFC4' }],
    captions: [{ pos: 'br', text: 'Capture Today\nCherish Forever' }] },
];
const SEED_KIOSKS = [
  { id: 'KIOSK-01', name: 'Kiosk 01', location: 'Bandar Hilir',   city: 'Melaka' },
  { id: 'KIOSK-02', name: 'Kiosk 02', location: 'Jonker Walk',    city: 'Melaka' },
  { id: 'KIOSK-03', name: 'Kiosk 03', location: 'Pantai Klebang', city: 'Melaka' },
];
const DEFAULT_SETTINGS = {
  business: { name: 'Crazy Moment Photo Print Station', email: '', phone: '', currency: 'MYR', timezone: 'Asia/Kuala_Lumpur', address: 'Melaka, Malaysia' },
  kiosk: { sessionMinutes: 10, extendMinutes: 5, idleSeconds: 30, language: 'en', showPrice: true },
  printer: { autoCut: true, quality: 'standard', border: 'white' },
  payment: { duitnow: true, card: true, timeoutMinutes: 5 },
  templateCategories: ['General', 'Travel', 'Event'],
};

async function seed() {
  const t = now();
  if (!store.count('products')) {
    for (const [i, p] of SEED_PRODUCTS.entries()) {
      const L = LAYOUTS[p.layout];
      await store.put('products', p.id, { ...p, photos: L.photos, size: L.size, output: L.output, allowQty: true, minQty: 1, maxQty: 20, status: 'active', sort: i + 1, createdAt: t, updatedAt: t });
    }
  }
  if (!store.count('templates')) {
    for (const [i, tp] of SEED_TEMPLATES.entries()) {
      await store.put('templates', tp.id, { layouts: [], bgImage: null, ...tp, status: 'active', sort: i + 1, createdAt: t - (SEED_TEMPLATES.length - i) * 1000, updatedAt: t });
    }
  }
  if (!store.count('kiosks')) {
    for (const k of SEED_KIOSKS) await store.put('kiosks', k.id, { ...k, keyHash: null, status: 'active', lastSeen: null, createdAt: t });
  }
  if (!store.get('settings', 'main')) {
    await store.put('settings', 'main', { ...DEFAULT_SETTINGS, configVersion: 1, secret: newId(32), updatedAt: t });
  }
  if (!store.count('users')) {
    const email = (process.env.ADMIN_EMAIL || 'admin@crazymoment.my').toLowerCase();
    const password = process.env.ADMIN_PASSWORD || 'crazymoment123';
    const uid = 'u_' + newId(6);
    await store.put('users', uid, {
      id: uid, ...(await hashPassword(password)), email, name: 'Admin', role: 'superadmin', status: 'active',
      mustChange: !process.env.ADMIN_PASSWORD, createdAt: t, lastLogin: null,
    });
    console.log(`Super Admin dicipta: ${email}${process.env.ADMIN_PASSWORD ? '' : ' / kata laluan lalai "crazymoment123" (wajib tukar)'}`);
  }
  // indeks clientRef → order id
  for (const o of store.all('orders')) if (o.clientRef) orderByRef.set(o.clientRef, o.id);
}

const settings = () => store.get('settings', 'main');
async function bumpConfig() {
  const s = settings();
  await store.put('settings', 'main', { ...s, configVersion: (s.configVersion || 1) + 1, updatedAt: now() });
}

// ================================================================
//  AUTH — kata laluan (scrypt) + token bertandatangan (HMAC)
// ================================================================
function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((res, rej) => crypto.scrypt(String(pw), salt, 64, (e, k) => (e ? rej(e) : res({ salt, passHash: k.toString('hex') }))));
}
async function checkPassword(user, pw) {
  const { passHash } = await hashPassword(pw, user.salt);
  return crypto.timingSafeEqual(Buffer.from(passHash, 'hex'), Buffer.from(user.passHash, 'hex'));
}
const sign = (data) => crypto.createHmac('sha256', settings().secret).update(data).digest('base64url');
function issueToken(user) {
  const payload = Buffer.from(JSON.stringify({ u: user.id, e: now() + 12 * 3600_000, v: user.tokenVersion || 0 })).toString('base64url');
  return payload + '.' + sign(payload);
}
function userFromReq(req) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [payload, sig] = tok.split('.');
  if (!payload || !sig) return null;
  const expect = sign(payload);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  let d; try { d = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
  if (!d || d.e < now()) return null;
  const u = store.get('users', d.u);
  if (!u || u.status !== 'active' || (u.tokenVersion || 0) !== d.v) return null;
  return u;
}
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, mustChange: !!u.mustChange, createdAt: u.createdAt, lastLogin: u.lastLogin });
const loginAttempts = new Map(); // ip → {n, until}

async function audit(user, action, target, detail) {
  const id = 'a_' + now().toString(36) + newId(3);
  await store.put('audit', id, { id, at: now(), userId: user ? user.id : null, userName: user ? user.name : 'system', action, target, detail: detail || '' });
}

// ---------- Kiosk auth ----------
const hashKey = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');
/** Pulangkan rekod kiosk jika dibenarkan, atau {error, code}. Kiosk baharu didaftar automatik. */
async function kioskAuth(req, kioskId, location) {
  const id = str(kioskId || req.headers['x-kiosk-id'] || 'KIOSK-01', 40).toUpperCase().replace(/[^A-Z0-9_-]/g, '') || 'KIOSK-01';
  const key = req.headers['x-kiosk-key'] || '';
  let k = store.get('kiosks', id);
  if (k && k.keyHash) {
    if (!key || hashKey(key) !== k.keyHash) return { error: 'Invalid kiosk key', code: 401 };
  } else if (GLOBAL_KIOSK_KEY && key !== GLOBAL_KIOSK_KEY) {
    return { error: 'Invalid kiosk key', code: 401 };
  }
  if (!k) {
    const n = id.match(/\d+/);
    k = { id, name: 'Kiosk ' + (n ? n[0].padStart(2, '0') : id), location: str(location, 60) || 'Belum ditetapkan', city: '', keyHash: null, status: 'active', lastSeen: null, createdAt: now(), autoRegistered: true };
    await store.put('kiosks', id, k);
  }
  if (k.status === 'disabled') return { error: 'Kiosk disabled by admin', code: 403 };
  return { kiosk: k };
}

// ================================================================
//  UPLOAD SESSIONS (telefon → kiosk) — dalam memori sahaja
// ================================================================
const sessions = new Map();
const kioskLive = new Map();   // kioskId → data heartbeat terkini
const orderByRef = new Map();  // clientRef → order id

function view(s, req) {
  const b = baseUrl(req);
  return {
    id: s.id, kioskId: s.kioskId, location: s.location, product: s.productKey, productName: s.product.name,
    required: s.required, received: s.photos.length, status: s.status, phoneConnected: s.phoneConnected,
    createdAt: iso(s.createdAt), expiresAt: iso(s.expiresAt),
    secondsLeft: Math.max(0, Math.round((s.expiresAt - now()) / 1000)),
    uploadUrl: `${b}/u/${s.id}`,
    photos: s.photos.map((p, i) => ({ id: p.id, index: i + 1, name: p.name, bytes: p.buffer.length, mime: p.mime, url: `${b}/api/sessions/${s.id}/photos/${p.id}` })),
  };
}
function getSession(id) {
  const s = sessions.get(id);
  if (s && s.status !== 'complete' && s.status !== 'expired' && now() > s.expiresAt) { s.status = 'expired'; bumpStat('expired'); }
  return s || null;
}
async function bumpStat(field, n = 1) {
  const key = 'stats:' + dayKey(now());
  const cur = store.get('counters', key) || { sessions: 0, expired: 0, photos: 0 };
  cur[field] = (cur[field] || 0) + n;
  await store.put('counters', key, cur).catch(() => {});
}
setInterval(() => {
  const cutoff = now() - GRACE_MS;
  for (const [id, s] of sessions) { getSession(id); if (s.expiresAt < cutoff) sessions.delete(id); }
}, 30_000).unref();

function productFor(key) {
  const id = LEGACY_KEYS[key] || key;
  return store.get('products', id) || store.all('products').find((p) => p.layout === id) || null;
}

// ================================================================
//  HTTP helpers
// ================================================================
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Kiosk-Key,X-Kiosk-Id,X-File-Name',
  'Access-Control-Max-Age': '86400',
};
function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { ...CORS, 'Content-Type': isBuf || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(data);
}
const json = (res, status, obj) => send(res, status, obj);
function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limitBytes) return reject(Object.assign(new Error('TOO_LARGE'), { code: 413 }));
    const chunks = []; let size = 0; let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > limitBytes) { failed = true; reject(Object.assign(new Error('TOO_LARGE'), { code: 413 })); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => !failed && resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req, 200 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { return {}; }
}

const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const PUBLIC_FILES = new Set(['index.html', 'upload.html', 'kiosk-test.html', 'kiosk-client.js', 'admin.html']);
const SEARCH_DIRS = [path.join(__dirname, 'public'), __dirname];
function serveFile(res, file) {
  if (!PUBLIC_FILES.has(file)) return json(res, 404, { error: 'Not found' });
  const tryDir = (i) => {
    if (i >= SEARCH_DIRS.length) return json(res, 404, { error: `File ${file} is missing from the repository` });
    fs.readFile(path.join(SEARCH_DIRS[i], file), (err, data) => {
      if (err) return tryDir(i + 1);
      send(res, 200, data, { 'Content-Type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    });
  };
  tryDir(0);
}
for (const f of PUBLIC_FILES) {
  const where = SEARCH_DIRS.find((d) => fs.existsSync(path.join(d, f)));
  console.log(`${where ? '✓' : '✗ MISSING'} ${f}`);
}

// ================================================================
//  VIEW MODELS
// ================================================================
function kioskStatus(k) {
  const live = kioskLive.get(k.id);
  const lastSeen = (live && live.at) || k.lastSeen || null;
  const online = !!lastSeen && now() - lastSeen < ONLINE_MS;
  let state = 'offline';
  if (k.status === 'disabled') state = 'disabled';
  else if (online) state = live && live.state === 'in-use' ? 'busy' : 'online';
  return {
    id: k.id, name: k.name, location: k.location, city: k.city, status: k.status, state, online,
    protected: !!k.keyHash, autoRegistered: !!k.autoRegistered,
    lastSeen: lastSeen ? iso(lastSeen) : null,
    appVersion: live ? live.appVersion : null,
    configVersion: live ? live.configVersion : null,
    configCurrent: live ? live.configVersion === settings().configVersion : null,
    printer: (live && live.printer) || { status: 'unknown' },
    session: online && live && live.session ? live.session : null,
    step: online && live ? live.step : null,
  };
}

function kioskConfig(req) {
  const s = settings();
  const b = baseUrl(req);
  const products = store.all('products').filter((p) => p.status === 'active').sort((a, z) => a.sort - z.sort).map((p) => ({
    id: p.id, layout: p.layout, name: p.name, description: p.description, photos: LAYOUTS[p.layout].photos, size: LAYOUTS[p.layout].size,
    price: p.price, icon: p.icon, popular: !!p.popular, gradient: p.gradient,
    allowQty: p.allowQty !== false, minQty: p.minQty || 1, maxQty: p.maxQty || 20,
  }));
  const templates = store.all('templates').filter((t) => t.status === 'active').sort((a, z) => a.sort - z.sort).map((t) => {
    const out = { id: t.id, name: t.name, scope: t.scope, bg: t.bg, pattern: t.pattern || 'none', textColor: t.textColor || 'var(--grey)' };
    if (t.patternColor) out.patternColor = t.patternColor;
    if (t.decor) out.decor = t.decor;
    if (t.corners) out.corners = t.corners;
    if (t.captions) out.captions = t.captions;
    if (t.bgImage) { out.bgImageUrl = `${b}/api/assets/${t.bgImage}`; out.bg = `url('${out.bgImageUrl}') center/cover no-repeat`; }
    if (t.scope === 'special') out.products = t.layouts || [];
    return out;
  });
  return {
    configVersion: s.configVersion, generatedAt: iso(now()),
    business: { name: s.business.name, currency: s.business.currency },
    kiosk: s.kiosk, payment: s.payment, printer: s.printer, products, templates,
  };
}

function orderView(o) { return { ...o, createdAt: iso(o.createdAt), paidAt: o.paidAt ? iso(o.paidAt) : null, completedAt: o.completedAt ? iso(o.completedAt) : null }; }
const isPaid = (o) => o.paymentStatus === 'paid';
const ordersOn = (key) => store.all('orders').filter((o) => o.day === key);

function summarize(list) {
  const paid = list.filter(isPaid);
  return {
    sales: money(paid.reduce((a, o) => a + o.total, 0)),
    orders: paid.length,
    prints: paid.filter((o) => o.status !== 'cancelled').reduce((a, o) => a + (o.qty || 1), 0),
    completed: list.filter((o) => o.status === 'completed').length,
    processing: list.filter((o) => o.status === 'printing' || o.status === 'pending').length,
    cancelled: list.filter((o) => o.status === 'cancelled' || o.status === 'failed').length,
    failedPayments: list.filter((o) => o.paymentStatus === 'failed').length,
    total: list.length,
  };
}

function salesSeries(range, dateKey) {
  if (range === 'today') {
    const arr = Array(24).fill(0);
    for (const o of ordersOn(dateKey)) if (isPaid(o)) arr[hourOf(o.createdAt)] += o.total;
    return arr.map((v, h) => ({ label: `${String(h).padStart(2, '0')}:00`, value: money(v) }));
  }
  const days = range === '30d' ? 30 : 7;
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const k = addDays(dateKey, -i);
    out.push({ label: k, value: money(ordersOn(k).filter(isPaid).reduce((a, o) => a + o.total, 0)) });
  }
  return out;
}

function overview(req, dateKey, range) {
  const today = ordersOn(dateKey), yest = ordersOn(addDays(dateKey, -1));
  const T = summarize(today), Y = summarize(yest);
  const kiosks = store.all('kiosks').sort((a, z) => a.id.localeCompare(z.id)).map(kioskStatus);
  const byMethod = {};
  for (const m of ['duitnow', 'card']) {
    const paid = today.filter((o) => isPaid(o) && o.payMethod === m);
    byMethod[m] = { amount: money(paid.reduce((a, o) => a + o.total, 0)), count: paid.length };
  }
  const active = [...sessions.values()].filter((s) => s.status !== 'expired' && getSession(s.id) && s.status !== 'expired').map((s) => ({
    id: s.id.slice(0, 8).toUpperCase(), kioskId: s.kioskId, product: s.product.name, received: s.photos.length, required: s.required,
    secondsLeft: Math.max(0, Math.round((s.expiresAt - now()) / 1000)), status: s.status,
  }));
  const st = store.get('counters', 'stats:' + dateKey) || { sessions: 0, expired: 0, photos: 0 };
  const alerts = [];
  for (const k of kiosks) {
    if (k.status === 'disabled') continue;
    if (k.state === 'offline') alerts.push({ level: 'error', text: `${k.name} (${k.location}) is offline`, target: 'kiosks' });
    if (k.online && k.configCurrent === false) alerts.push({ level: 'info', text: `${k.name} is using an older configuration`, target: 'kiosks' });
  }
  const noKey = kiosks.filter((k) => k.status !== 'disabled' && !k.protected);
  if (noKey.length) alerts.push({ level: 'warn', text: noKey.length === 1 ? `${noKey[0].name} has no security key` : `${noKey.length} kiosks have no security key`, target: 'kiosks' });
  if (T.failedPayments) alerts.push({ level: 'warn', text: `${T.failedPayments} payment transaction(s) failed`, target: 'orders' });
  if (store.kind !== 'postgres') alerts.unshift({ level: 'error', text: 'Temporary storage — data will be lost on server restart. Connect PostgreSQL.', target: 'settings' });
  if (today.some((o) => isPaid(o) && !o.paymentVerified)) alerts.push({ level: 'info', text: 'Payments are simulated (demo) until the payment gateway is connected in Phase 2', target: 'orders' });
  return {
    date: dateKey, storage: store.kind,
    kpi: {
      sales: T.sales, salesChange: pct(T.sales, Y.sales),
      orders: T.orders, ordersChange: pct(T.orders, Y.orders),
      prints: T.prints, printsChange: pct(T.prints, Y.prints),
    },
    series: salesSeries(range, dateKey), range,
    kiosks,
    kioskSummary: ['online', 'busy', 'offline', 'disabled'].reduce((a, s) => ((a[s] = kiosks.filter((k) => k.state === s).length), a), {}),
    recentOrders: today.sort((a, z) => z.createdAt - a.createdAt).slice(0, 6).map(orderView),
    payments: { byMethod, total: T.sales, successful: T.orders, failed: T.failedPayments, refunded: 0 },
    sessions: { active: active.length, expired: st.expired || 0, started: st.sessions || 0, photos: st.photos || 0, list: active.slice(0, 6) },
    alerts,
  };
}

// ================================================================
//  ROUTES
// ================================================================
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;
  const seg = p.split('/').filter(Boolean);
  const q = url.searchParams;

  if (m === 'OPTIONS') return send(res, 204, '');
  if (p === '/health') return json(res, 200, { ok: true, service: 'crazy-moment-upload-server', version: APP_VERSION, storage: store.kind, sessions: sessions.size, time: iso(now()) });

  if (m === 'GET' && p === '/') return serveFile(res, 'index.html');
  if (m === 'GET' && p === '/admin') return serveFile(res, 'admin.html');
  if (m === 'GET' && p === '/kiosk-test') return serveFile(res, 'kiosk-test.html');
  if (m === 'GET' && seg[0] === 'u' && seg.length === 2) return serveFile(res, 'upload.html');
  if (m === 'GET' && seg.length === 1 && /^[\w.-]+\.(js|css|svg|png|ico|html)$/.test(seg[0])) return serveFile(res, seg[0]);

  if (seg[0] !== 'api') return json(res, 404, { error: 'Not found' });

  // ---------- Public ----------
  if (m === 'GET' && p === '/api/products') {
    const out = {};
    for (const pr of store.all('products')) out[pr.id] = { name: pr.name, required: LAYOUTS[pr.layout].photos, size: LAYOUTS[pr.layout].size, layout: pr.layout };
    return json(res, 200, out);
  }
  if (m === 'GET' && seg[1] === 'assets' && seg[2]) {
    const a = await store.getAsset(seg[2]);
    if (!a) return json(res, 404, { error: 'Asset not found' });
    return send(res, 200, a.buffer, { 'Content-Type': a.mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
  }

  if (seg[1] === 'kiosk') return handleKiosk(req, res, m, seg, q);
  if (seg[1] === 'admin') return handleAdmin(req, res, m, seg, q, p);
  if (seg[1] === 'sessions') return handleSessions(req, res, m, seg, p);
  return json(res, 404, { error: 'Not found' });
}

// ---------- Upload sessions ----------
async function handleSessions(req, res, m, seg, p) {
  if (m === 'POST' && p === '/api/sessions') {
    const body = await readJson(req);
    const auth = await kioskAuth(req, body.kioskId, body.location);
    if (auth.error) return json(res, auth.code, { error: auth.error });
    const prod = productFor(body.product || 'strip');
    if (!prod) return json(res, 400, { error: `Unknown product "${body.product}"` });
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) sessions.delete(oldest.id);
    }
    const t = now();
    const s = {
      id: newId(), kioskId: auth.kiosk.id, location: auth.kiosk.location,
      productKey: prod.id, product: { name: prod.name }, required: LAYOUTS[prod.layout].photos, photos: [],
      status: 'waiting', phoneConnected: false, createdAt: t, expiresAt: t + settings().kiosk.sessionMinutes * 60_000,
    };
    sessions.set(s.id, s);
    bumpStat('sessions');
    return json(res, 201, view(s, req));
  }
  if (!seg[2]) return json(res, 404, { error: 'Not found' });
  const id = seg[2];

  if (m === 'GET' && seg.length === 3) {
    const s = getSession(id);
    return s ? json(res, 200, view(s, req)) : json(res, 404, { error: 'Session not found or already closed' });
  }
  if (m === 'DELETE' && seg.length === 3) {
    const s = sessions.get(id);
    if (s) { const a = await kioskAuth(req, s.kioskId); if (a.error) return json(res, a.code, { error: a.error }); }
    return json(res, 200, { ok: true, deleted: sessions.delete(id) });
  }
  if (m === 'POST' && seg[3] === 'connect') {
    const s = getSession(id);
    if (!s) return json(res, 404, { error: 'Session not found' });
    if (s.status === 'expired') return json(res, 410, { error: 'Session expired' });
    s.phoneConnected = true;
    if (s.status === 'waiting') s.status = 'connected';
    return json(res, 200, view(s, req));
  }
  if (m === 'POST' && seg[3] === 'extend') {
    const s = sessions.get(id);
    if (!s) return json(res, 404, { error: 'Session not found' });
    const a = await kioskAuth(req, s.kioskId); if (a.error) return json(res, a.code, { error: a.error });
    s.expiresAt = Math.max(s.expiresAt, now()) + (settings().kiosk.extendMinutes || 5) * 60_000;
    if (s.status === 'expired') s.status = s.photos.length ? 'uploading' : (s.phoneConnected ? 'connected' : 'waiting');
    return json(res, 200, view(s, req));
  }
  if (m === 'POST' && seg[3] === 'photos' && seg.length === 4) {
    const s = getSession(id);
    if (!s) return json(res, 404, { error: 'Session not found' });
    if (s.status === 'expired') return json(res, 410, { error: 'Session expired. Please start again at the kiosk.' });
    if (s.status === 'complete' || s.photos.length >= s.required) return json(res, 409, { error: 'This session already has all its photos.' });
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_MIME.test(mime)) return json(res, 415, { error: 'Only JPG, PNG, WEBP or HEIC photos are allowed' });
    let buffer;
    try { buffer = await readBody(req, MAX_FILE_MB * 1024 * 1024); }
    catch (e) { return json(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? `Each photo must be under ${MAX_FILE_MB} MB` : 'Upload interrupted' }); }
    if (!buffer.length) return json(res, 400, { error: 'Empty photo' });
    if (getSession(id) !== s || s.status === 'expired') return json(res, 410, { error: 'Session expired' });
    if (s.photos.length >= s.required) return json(res, 409, { error: 'This session already has all its photos.' });
    let name = 'photo.jpg';
    try { name = decodeURIComponent(req.headers['x-file-name'] || name).slice(0, 120); } catch {}
    s.photos.push({ id: newId(6), name, mime, buffer, at: now() });
    s.phoneConnected = true;
    s.status = s.photos.length >= s.required ? 'complete' : 'uploading';
    bumpStat('photos');
    return json(res, 200, view(s, req));
  }
  if (m === 'GET' && seg[3] === 'photos' && seg[4]) {
    const s = sessions.get(id);
    const ph = s && s.photos.find((x) => x.id === seg[4]);
    if (!ph) return json(res, 404, { error: 'Photo not found' });
    return send(res, 200, ph.buffer, { 'Content-Type': ph.mime, 'Cache-Control': 'private, no-store' });
  }
  if (m === 'DELETE' && seg[3] === 'photos' && seg[4]) {
    const s = getSession(id);
    if (!s) return json(res, 404, { error: 'Session not found' });
    if (s.status === 'complete' || s.status === 'expired') return json(res, 409, { error: 'Session locked' });
    s.photos = s.photos.filter((x) => x.id !== seg[4]);
    s.status = s.photos.length ? 'uploading' : 'connected';
    return json(res, 200, view(s, req));
  }
  return json(res, 404, { error: 'Not found' });
}

// ---------- Kiosk API ----------
async function handleKiosk(req, res, m, seg, q) {
  const body = m === 'GET' ? {} : await readJson(req);
  const auth = await kioskAuth(req, body.kioskId || q.get('kioskId'), body.location);
  if (auth.error) return json(res, auth.code, { error: auth.error });
  const k = auth.kiosk;
  const action = seg[2];

  // GET /api/kiosk/config — produk, templat & tetapan terkini
  if (m === 'GET' && action === 'config') {
    return json(res, 200, { ...kioskConfig(req), self: { id: k.id, name: k.name, location: k.location, protected: !!k.keyHash } });
  }

  // POST /api/kiosk/heartbeat — setiap 30 saat
  if (m === 'POST' && action === 'heartbeat') {
    const t = now();
    const printer = body.printer && typeof body.printer === 'object' ? {
      status: str(body.printer.status, 20) || 'unknown', model: str(body.printer.model, 40) || null,
      mediaRemaining: body.printer.mediaRemaining == null ? null : num(body.printer.mediaRemaining, 0, 100000, null),
      mediaTotal: body.printer.mediaTotal == null ? null : num(body.printer.mediaTotal, 0, 100000, null),
      message: str(body.printer.message, 120) || null,
    } : { status: 'unknown' };
    const sess = body.session && typeof body.session === 'object' ? {
      product: str(body.session.product, 40), received: num(body.session.received, 0, 99, 0), required: num(body.session.required, 0, 99, 0),
      secondsLeft: num(body.session.secondsLeft, 0, 99999, 0),
    } : null;
    kioskLive.set(k.id, {
      at: t, state: body.state === 'in-use' ? 'in-use' : 'idle', step: num(body.step, 0, 9, 1),
      appVersion: str(body.appVersion, 20), configVersion: num(body.configVersion, 0, 1e9, 0), printer, session: sess,
    });
    if (!k.lastSeen || t - k.lastSeen > 5 * 60_000) await store.put('kiosks', k.id, { ...k, lastSeen: t });
    return json(res, 200, { ok: true, configVersion: settings().configVersion, serverTime: iso(t), commands: [] });
  }

  // POST /api/kiosk/orders — kiosk lapor order (idempotent ikut clientRef)
  if (m === 'POST' && action === 'orders' && !seg[3]) {
    const clientRef = str(body.clientRef, 60);
    if (!clientRef) return json(res, 400, { error: 'clientRef required' });
    if (orderByRef.has(clientRef)) return json(res, 200, orderView(store.get('orders', orderByRef.get(clientRef))));
    const prod = productFor(body.productId);
    const created = num(body.createdAt ? Date.parse(body.createdAt) : NaN, 0, now() + 60_000, now());
    const qty = num(body.qty, 1, 99, 1);
    // Harga SENTIASA dari server — kiosk tak boleh tentukan harga sendiri
    const unitPrice = prod ? money(prod.price) : money(body.unitPrice);
    const day = dayKey(created);
    const seq = await store.nextSeq('order:' + day);
    const id = 'CM' + day.slice(2).replace(/-/g, '') + String(seq).padStart(5, '0');
    const payStatus = ['paid', 'failed', 'pending'].includes(body.paymentStatus) ? body.paymentStatus : 'pending';
    const status = ['pending', 'printing', 'completed', 'cancelled', 'failed'].includes(body.status) ? body.status : 'pending';
    const tmpl = body.templateId ? store.get('templates', str(body.templateId, 60)) : null;
    const o = {
      id, clientRef, kioskId: k.id, kioskName: k.name, location: k.location,
      productId: prod ? prod.id : str(body.productId, 40), productName: prod ? prod.name : str(body.productName, 60),
      layout: prod ? prod.layout : null, size: prod ? LAYOUTS[prod.layout].size : '', photos: prod ? LAYOUTS[prod.layout].photos : 0,
      qty, unitPrice, total: money(unitPrice * qty),
      payMethod: body.payMethod === 'card' ? 'card' : 'duitnow', paymentStatus: payStatus,
      paymentVerified: false, // Fasa 2: hanya webhook gateway boleh set true
      paymentRef: str(body.paymentRef, 60) || null,
      status, templateId: tmpl ? tmpl.id : null, templateName: tmpl ? tmpl.name : null,
      priceMismatch: body.unitPrice != null && prod ? money(body.unitPrice) !== unitPrice : false,
      createdAt: created, paidAt: payStatus === 'paid' ? created : null, completedAt: status === 'completed' ? now() : null, day,
    };
    await store.put('orders', id, o);
    orderByRef.set(clientRef, id);
    return json(res, 201, orderView(o));
  }

  // PATCH /api/kiosk/orders/:clientRef — kemas kini status (printing → completed)
  if ((m === 'PATCH' || m === 'POST') && action === 'orders' && seg[3]) {
    const id = orderByRef.get(seg[3]) || seg[3];
    const o = store.get('orders', id);
    if (!o || o.kioskId !== k.id) return json(res, 404, { error: 'Order not found' });
    const upd = { ...o };
    if (['pending', 'printing', 'completed', 'cancelled', 'failed'].includes(body.status)) upd.status = body.status;
    if (['paid', 'failed', 'pending'].includes(body.paymentStatus)) { upd.paymentStatus = body.paymentStatus; if (body.paymentStatus === 'paid' && !upd.paidAt) upd.paidAt = now(); }
    if (upd.status === 'completed' && !upd.completedAt) upd.completedAt = now();
    await store.put('orders', id, upd);
    return json(res, 200, orderView(upd));
  }
  return json(res, 404, { error: 'Not found' });
}

// ---------- Admin API ----------
function requireRole(res, user, role) {
  if (!user) { json(res, 401, { error: 'Please log in' }); return false; }
  if (role === 'superadmin' && user.role !== 'superadmin') { json(res, 403, { error: 'Only Super Admin can do this' }); return false; }
  return true;
}

function cleanProduct(b, existing) {
  const layout = existing ? existing.layout : (LAYOUTS[b.layout] ? b.layout : null);
  if (!layout) return { error: 'Choose a valid layout' };
  const name = str(b.name, 60);
  if (!name) return { error: 'Product name is required' };
  const price = money(num(b.price, 0, 9999, NaN));
  if (!Number.isFinite(price) || price <= 0) return { error: 'Price must be more than 0' };
  const minQty = num(b.minQty, 1, 99, 1), maxQty = num(b.maxQty, 1, 99, 20);
  if (minQty > maxQty) return { error: 'Minimum quantity cannot exceed maximum' };
  return {
    layout, name, description: str(b.description, 200), price, minQty, maxQty,
    allowQty: b.allowQty !== false, popular: !!b.popular, status: b.status === 'inactive' ? 'inactive' : 'active',
    icon: str(b.icon, 8) || (existing && existing.icon) || '📷',
    gradient: str(b.gradient, 200) || (existing && existing.gradient) || 'linear-gradient(160deg,#F2C879,#C98D00)',
  };
}
const CSS_SAFE = /^[#\w\s(),.%'-]*$/;
function cleanTemplate(b) {
  const name = str(b.name, 60);
  if (!name) return { error: 'Template name is required' };
  const scope = b.scope === 'special' ? 'special' : 'simple';
  const layouts = scope === 'special' ? (Array.isArray(b.layouts) ? b.layouts.filter((l) => LAYOUTS[l]) : []) : [];
  if (scope === 'special' && !layouts.length) return { error: 'Special template needs at least one layout' };
  const bg = str(b.bg, 200) || '#FFFFFF';
  const textColor = str(b.textColor, 60) || 'var(--grey)';
  if (!CSS_SAFE.test(bg) || !CSS_SAFE.test(textColor)) return { error: 'Invalid colour value' };
  const pattern = ['none', 'dots'].includes(b.pattern) ? b.pattern : 'none';
  return {
    name, scope, layouts, category: str(b.category, 30) || 'General', bg, textColor, pattern,
    patternColor: pattern === 'dots' ? (str(b.patternColor, 60) || 'rgba(255,255,255,0.22)') : undefined,
    status: b.status === 'inactive' ? 'inactive' : 'active',
    bgImage: b.bgImage === null ? null : (typeof b.bgImage === 'string' && /^[\w-]{6,40}$/.test(b.bgImage) ? b.bgImage : undefined),
  };
}

function filterOrders(q) {
  const date = q.get('date') || 'all', kiosk = q.get('kiosk') || '', status = q.get('status') || '', search = (q.get('q') || '').toLowerCase();
  const method = q.get('method') || '', from = q.get('from'), to = q.get('to');
  return store.all('orders').filter((o) => {
    if (isDay(date) && o.day !== date) return false;
    if (isDay(from) && o.day < from) return false;
    if (isDay(to) && o.day > to) return false;
    if (kiosk && o.kioskId !== kiosk) return false;
    if (method && o.payMethod !== method) return false;
    if (status === 'processing' ? !(o.status === 'printing' || o.status === 'pending') : status && o.status !== status) return false;
    if (search && !(o.id.toLowerCase().includes(search) || (o.paymentRef || '').toLowerCase().includes(search) || o.productName.toLowerCase().includes(search))) return false;
    return true;
  }).sort((a, z) => z.createdAt - a.createdAt);
}
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

async function handleAdmin(req, res, m, seg, q, p) {
  const action = seg[2];

  // ----- Login -----
  if (m === 'POST' && action === 'login') {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const att = loginAttempts.get(ip) || { n: 0, until: 0 };
    if (att.until > now()) return json(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const b = await readJson(req);
    const u = store.all('users').find((x) => x.email === str(b.email, 120).toLowerCase() && x.status === 'active');
    if (!u || !(await checkPassword(u, str(b.password, 200)))) {
      att.n++; if (att.n >= 5) { att.until = now() + 5 * 60_000; att.n = 0; }
      loginAttempts.set(ip, att);
      return json(res, 401, { error: 'Wrong email or password' });
    }
    loginAttempts.delete(ip);
    await store.put('users', u.id, { ...u, lastLogin: now() });
    return json(res, 200, { token: issueToken(u), user: publicUser(u) });
  }

  const user = userFromReq(req);
  if (!requireRole(res, user)) return;

  if (m === 'GET' && action === 'me') return json(res, 200, { user: publicUser(user), storage: store.kind, version: APP_VERSION, layouts: LAYOUTS });

  if (m === 'POST' && action === 'password') {
    const b = await readJson(req);
    if (!(await checkPassword(user, str(b.current, 200)))) return json(res, 400, { error: 'Current password is wrong' });
    const np = str(b.next, 200);
    if (np.length < 8) return json(res, 400, { error: 'New password must be at least 8 characters' });
    const upd = { ...user, ...(await hashPassword(np)), mustChange: false, tokenVersion: (user.tokenVersion || 0) + 1 };
    await store.put('users', user.id, upd);
    await audit(user, 'password.change', user.email);
    return json(res, 200, { token: issueToken(upd), user: publicUser(upd) });
  }

  // ----- Overview -----
  if (m === 'GET' && action === 'overview') {
    const date = isDay(q.get('date')) ? q.get('date') : dayKey(now());
    const range = ['today', '7d', '30d'].includes(q.get('range')) ? q.get('range') : 'today';
    return json(res, 200, overview(req, date, range));
  }

  // ----- Products -----
  if (action === 'products') {
    const id = seg[3];
    if (m === 'GET' && !id) {
      const list = store.all('products').sort((a, z) => a.sort - z.sort);
      const sold = {};
      for (const o of store.all('orders')) if (isPaid(o)) sold[o.productId] = (sold[o.productId] || 0) + o.qty;
      return json(res, 200, { products: list.map((x) => ({ ...x, photos: LAYOUTS[x.layout].photos, size: LAYOUTS[x.layout].size, output: LAYOUTS[x.layout].output, sold: sold[x.id] || 0 })), layouts: LAYOUTS });
    }
    if (!requireRole(res, user, 'superadmin')) return;
    if (m === 'POST' && !id) {
      const c = cleanProduct(await readJson(req));
      if (c.error) return json(res, 400, c);
      const pid = 'p_' + newId(5);
      const sort = Math.max(0, ...store.all('products').map((x) => x.sort || 0)) + 1;
      const doc = { id: pid, ...c, photos: LAYOUTS[c.layout].photos, size: LAYOUTS[c.layout].size, output: LAYOUTS[c.layout].output, sort, createdAt: now(), updatedAt: now() };
      await store.put('products', pid, doc); await bumpConfig(); await audit(user, 'product.create', c.name);
      return json(res, 201, doc);
    }
    if (m === 'POST' && id === 'reorder') {
      const b = await readJson(req);
      if (Array.isArray(b.ids)) for (const [i, pid] of b.ids.entries()) { const x = store.get('products', pid); if (x) await store.put('products', pid, { ...x, sort: i + 1 }); }
      await bumpConfig(); await audit(user, 'product.reorder', '');
      return json(res, 200, { ok: true });
    }
    const ex = store.get('products', id);
    if (!ex) return json(res, 404, { error: 'Product not found' });
    if (m === 'PUT') {
      const c = cleanProduct(await readJson(req), ex);
      if (c.error) return json(res, 400, c);
      const doc = { ...ex, ...c, updatedAt: now() };
      await store.put('products', id, doc); await bumpConfig();
      await audit(user, 'product.update', doc.name, ex.price !== doc.price ? `price RM${ex.price} → RM${doc.price}` : '');
      return json(res, 200, doc);
    }
    if (m === 'DELETE') {
      if (store.all('products').filter((x) => x.status === 'active' && x.id !== id).length === 0) return json(res, 400, { error: 'At least one product must stay active' });
      await store.del('products', id); await bumpConfig(); await audit(user, 'product.delete', ex.name);
      return json(res, 200, { ok: true });
    }
  }

  // ----- Templates -----
  if (action === 'templates') {
    const id = seg[3];
    if (m === 'GET' && !id) return json(res, 200, { templates: store.all('templates').sort((a, z) => a.sort - z.sort), categories: settings().templateCategories || [], layouts: LAYOUTS });
    if (!requireRole(res, user, 'superadmin')) return;
    if (m === 'POST' && !id) {
      const c = cleanTemplate(await readJson(req));
      if (c.error) return json(res, 400, c);
      const tid = 't_' + newId(5);
      const sort = Math.max(0, ...store.all('templates').map((x) => x.sort || 0)) + 1;
      const doc = { id: tid, ...c, bgImage: c.bgImage || null, sort, createdAt: now(), updatedAt: now() };
      await store.put('templates', tid, doc); await bumpConfig(); await audit(user, 'template.create', c.name);
      return json(res, 201, doc);
    }
    const ex = store.get('templates', id);
    if (!ex) return json(res, 404, { error: 'Template not found' });
    if (m === 'PUT') {
      const c = cleanTemplate(await readJson(req));
      if (c.error) return json(res, 400, c);
      if (c.status === 'inactive' && ex.scope === 'simple' && store.all('templates').filter((x) => x.scope === 'simple' && x.status === 'active' && x.id !== id).length === 0) return json(res, 400, { error: 'At least one Simple template must stay active' });
      const doc = { ...ex, ...c, bgImage: c.bgImage === undefined ? ex.bgImage : c.bgImage, updatedAt: now() };
      if (ex.bgImage && ex.bgImage !== doc.bgImage) await store.delAsset(ex.bgImage);
      await store.put('templates', id, doc); await bumpConfig(); await audit(user, 'template.update', doc.name);
      return json(res, 200, doc);
    }
    if (m === 'DELETE') {
      if (ex.scope === 'simple' && store.all('templates').filter((x) => x.scope === 'simple' && x.status === 'active' && x.id !== id).length === 0) return json(res, 400, { error: 'At least one Simple template must stay active' });
      if (ex.bgImage) await store.delAsset(ex.bgImage);
      await store.del('templates', id); await bumpConfig(); await audit(user, 'template.delete', ex.name);
      return json(res, 200, { ok: true });
    }
  }

  // ----- Asset upload (gambar latar templat) -----
  if (m === 'POST' && action === 'assets') {
    if (!requireRole(res, user, 'superadmin')) return;
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!ASSET_MIME.test(mime)) return json(res, 415, { error: 'Only PNG, JPG or WEBP images' });
    let buf;
    try { buf = await readBody(req, MAX_ASSET_MB * 1024 * 1024); } catch { return json(res, 413, { error: `Image must be under ${MAX_ASSET_MB} MB` }); }
    if (!buf.length) return json(res, 400, { error: 'Empty image' });
    const aid = 'img' + newId(9);
    await store.putAsset(aid, mime, buf);
    return json(res, 201, { id: aid, url: `${baseUrl(req)}/api/assets/${aid}`, bytes: buf.length });
  }

  // ----- Kiosks -----
  if (action === 'kiosks') {
    const id = seg[3];
    if (m === 'GET' && !id) return json(res, 200, { kiosks: store.all('kiosks').sort((a, z) => a.id.localeCompare(z.id)).map(kioskStatus), configVersion: settings().configVersion });
    if (m === 'GET' && id) {
      const k = store.get('kiosks', id);
      if (!k) return json(res, 404, { error: 'Kiosk not found' });
      const today = dayKey(now());
      const list = store.all('orders').filter((o) => o.kioskId === id);
      return json(res, 200, { kiosk: kioskStatus(k), today: summarize(list.filter((o) => o.day === today)), recent: list.sort((a, z) => z.createdAt - a.createdAt).slice(0, 5).map(orderView) });
    }
    if (!requireRole(res, user, 'superadmin')) return;
    if (m === 'POST' && !id) {
      const b = await readJson(req);
      const kid = str(b.id, 40).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
      if (!kid) return json(res, 400, { error: 'Kiosk ID is required (e.g. KIOSK-04)' });
      if (store.get('kiosks', kid)) return json(res, 400, { error: 'Kiosk ID already exists' });
      const key = 'ck_' + newId(18);
      const doc = { id: kid, name: str(b.name, 40) || kid, location: str(b.location, 60), city: str(b.city, 40), keyHash: hashKey(key), status: 'active', lastSeen: null, createdAt: now() };
      await store.put('kiosks', kid, doc); await audit(user, 'kiosk.create', kid);
      return json(res, 201, { kiosk: kioskStatus(doc), key });
    }
    const k = store.get('kiosks', id);
    if (!k) return json(res, 404, { error: 'Kiosk not found' });
    if (m === 'PUT') {
      const b = await readJson(req);
      const doc = { ...k, name: str(b.name, 40) || k.name, location: str(b.location, 60), city: str(b.city, 40), status: b.status === 'disabled' ? 'disabled' : 'active', autoRegistered: false };
      await store.put('kiosks', id, doc); await audit(user, 'kiosk.update', id);
      return json(res, 200, kioskStatus(doc));
    }
    if (m === 'POST' && seg[4] === 'key') {
      const key = 'ck_' + newId(18);
      await store.put('kiosks', id, { ...k, keyHash: hashKey(key) }); await audit(user, 'kiosk.key', id);
      return json(res, 200, { key });
    }
    if (m === 'DELETE' && seg[4] === 'key') {
      await store.put('kiosks', id, { ...k, keyHash: null }); await audit(user, 'kiosk.key.remove', id);
      return json(res, 200, { ok: true });
    }
    if (m === 'DELETE' && !seg[4]) {
      await store.del('kiosks', id); kioskLive.delete(id); await audit(user, 'kiosk.delete', id);
      return json(res, 200, { ok: true });
    }
  }

  // ----- Orders -----
  if (m === 'GET' && action === 'orders' && !seg[3]) {
    const list = filterOrders(q);
    const page = num(q.get('page'), 1, 1e6, 1), size = num(q.get('pageSize'), 5, 100, 10);
    const date = q.get('date');
    const cmp = isDay(date) ? summarize(filterOrders(new URLSearchParams({ ...Object.fromEntries(q), date: addDays(date, -1) }))) : null;
    const sum = summarize(list);
    return json(res, 200, {
      orders: list.slice((page - 1) * size, page * size).map(orderView), total: list.length, page, pageSize: size,
      summary: { ...sum, ordersChange: cmp ? pct(sum.total, cmp.total) : null, salesChange: cmp ? pct(sum.sales, cmp.sales) : null },
    });
  }
  if (m === 'GET' && action === 'orders.csv') {
    const rows = [['Order ID', 'Date', 'Time', 'Kiosk', 'Location', 'Product', 'Size', 'Qty', 'Unit Price (RM)', 'Total (RM)', 'Payment Method', 'Payment Status', 'Verified', 'Order Status', 'Template']];
    for (const o of filterOrders(q)) {
      const d = new Date(o.createdAt + TZ_OFFSET_MS).toISOString();
      rows.push([o.id, d.slice(0, 10), d.slice(11, 16), o.kioskName, o.location, o.productName, o.size, o.qty, o.unitPrice.toFixed(2), o.total.toFixed(2), o.payMethod === 'card' ? 'Debit/Credit Card' : 'DuitNow QR', o.paymentStatus, o.paymentVerified ? 'yes' : 'no (demo)', o.status, o.templateName || '']);
    }
    return send(res, 200, '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="crazy-moment-orders-${q.get('date') || 'all'}.csv"` });
  }
  if (action === 'orders' && seg[3]) {
    const o = store.get('orders', seg[3]);
    if (!o) return json(res, 404, { error: 'Order not found' });
    if (m === 'GET') return json(res, 200, orderView(o));
    if (m === 'PATCH') {
      const b = await readJson(req);
      const upd = { ...o };
      if (['pending', 'printing', 'completed', 'cancelled', 'failed'].includes(b.status)) upd.status = b.status;
      if (upd.status === 'completed' && !upd.completedAt) upd.completedAt = now();
      if (typeof b.note === 'string') upd.note = str(b.note, 300);
      await store.put('orders', o.id, upd); await audit(user, 'order.update', o.id, `status ${o.status} → ${upd.status}`);
      return json(res, 200, orderView(upd));
    }
  }

  // ----- Settings -----
  if (action === 'settings') {
    const s = settings();
    if (m === 'GET') { const { secret, ...pub } = s; return json(res, 200, { ...pub, storage: store.kind }); }
    if (!requireRole(res, user, 'superadmin')) return;
    if (m === 'PUT') {
      const b = await readJson(req);
      const next = { ...s };
      if (b.business) next.business = { ...s.business, name: str(b.business.name, 80) || s.business.name, email: str(b.business.email, 120), phone: str(b.business.phone, 30), address: str(b.business.address, 300), currency: 'MYR', timezone: 'Asia/Kuala_Lumpur' };
      if (b.kiosk) next.kiosk = { ...s.kiosk, sessionMinutes: num(b.kiosk.sessionMinutes, 3, 60, s.kiosk.sessionMinutes), extendMinutes: num(b.kiosk.extendMinutes, 1, 30, s.kiosk.extendMinutes), idleSeconds: num(b.kiosk.idleSeconds, 10, 600, s.kiosk.idleSeconds), language: ['en', 'ms'].includes(b.kiosk.language) ? b.kiosk.language : s.kiosk.language, showPrice: b.kiosk.showPrice !== false };
      if (b.printer) next.printer = { autoCut: b.printer.autoCut !== false, quality: ['standard', 'fine'].includes(b.printer.quality) ? b.printer.quality : 'standard', border: ['white', 'none'].includes(b.printer.border) ? b.printer.border : 'white' };
      if (b.payment) {
        const pay = { duitnow: b.payment.duitnow !== false, card: b.payment.card !== false, timeoutMinutes: num(b.payment.timeoutMinutes, 1, 15, s.payment.timeoutMinutes) };
        if (!pay.duitnow && !pay.card) return json(res, 400, { error: 'At least one payment method must be ON' });
        next.payment = pay;
      }
      if (Array.isArray(b.templateCategories)) next.templateCategories = [...new Set(b.templateCategories.map((c) => str(c, 30)).filter(Boolean))].slice(0, 30);
      next.configVersion = (s.configVersion || 1) + 1; next.updatedAt = now();
      await store.put('settings', 'main', next); await audit(user, 'settings.update', Object.keys(b).join(', '));
      const { secret, ...pub } = next; return json(res, 200, { ...pub, storage: store.kind });
    }
  }

  // ----- Users -----
  if (action === 'users') {
    if (!requireRole(res, user, 'superadmin')) return;
    const id = seg[3];
    if (m === 'GET') return json(res, 200, { users: store.all('users').sort((a, z) => a.createdAt - z.createdAt).map(publicUser) });
    if (m === 'POST' && !id) {
      const b = await readJson(req);
      const email = str(b.email, 120).toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) return json(res, 400, { error: 'Valid email required' });
      if (store.all('users').some((x) => x.email === email)) return json(res, 400, { error: 'Email already used' });
      const pw = str(b.password, 200);
      if (pw.length < 8) return json(res, 400, { error: 'Password must be at least 8 characters' });
      const uid = 'u_' + newId(6);
      const doc = { id: uid, ...(await hashPassword(pw)), email, name: str(b.name, 60) || email, role: b.role === 'superadmin' ? 'superadmin' : 'operator', status: 'active', mustChange: true, createdAt: now(), lastLogin: null };
      await store.put('users', uid, doc); await audit(user, 'user.create', email, doc.role);
      return json(res, 201, publicUser(doc));
    }
    const u = store.get('users', id);
    if (!u) return json(res, 404, { error: 'User not found' });
    if (m === 'PUT') {
      const b = await readJson(req);
      if (u.id === user.id && (b.role === 'operator' || b.status === 'disabled')) return json(res, 400, { error: 'You cannot demote or disable yourself' });
      const doc = { ...u, name: str(b.name, 60) || u.name, role: b.role === 'superadmin' ? 'superadmin' : b.role === 'operator' ? 'operator' : u.role, status: b.status === 'disabled' ? 'disabled' : 'active' };
      if (b.password) {
        if (String(b.password).length < 8) return json(res, 400, { error: 'Password must be at least 8 characters' });
        Object.assign(doc, await hashPassword(b.password), { mustChange: true, tokenVersion: (u.tokenVersion || 0) + 1 });
      }
      await store.put('users', u.id, doc); await audit(user, 'user.update', u.email);
      return json(res, 200, publicUser(doc));
    }
    if (m === 'DELETE') {
      if (u.id === user.id) return json(res, 400, { error: 'You cannot delete yourself' });
      await store.del('users', u.id); await audit(user, 'user.delete', u.email);
      return json(res, 200, { ok: true });
    }
  }

  // ----- Audit log -----
  if (m === 'GET' && action === 'audit') {
    if (!requireRole(res, user, 'superadmin')) return;
    return json(res, 200, { entries: store.all('audit').sort((a, z) => z.at - a.at).slice(0, 200).map((a) => ({ ...a, at: iso(a.at) })) });
  }

  return json(res, 404, { error: 'Not found' });
}

// ================================================================
(async () => {
  await store.init();
  await seed();
  http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) json(res, 500, { error: 'Server error' });
    });
  }).listen(PORT, () => {
    console.log(`Crazy Moment server v${APP_VERSION} running on port ${PORT}`);
    console.log(`Admin dashboard: /admin`);
  });
})().catch((e) => { console.error('Gagal mula:', e); process.exit(1); });
