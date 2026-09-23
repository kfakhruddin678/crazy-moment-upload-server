/**
 * Crazy Moment Photo Print Station — Upload Server (zero dependencies)
 * --------------------------------------------------------------------
 * Pure Node.js (built-in modules only) — nothing to npm install, fast Render builds.
 *
 * Flow:
 *   1. Kiosk  → POST   /api/sessions                 create session → { id, uploadUrl, ... }
 *              (kiosk turns uploadUrl into a QR code with its own offline QR encoder)
 *   2. Phone  → scans QR → GET /u/:id                mobile upload page
 *   3. Phone  → POST   /api/sessions/:id/photos      raw image body (one photo per request)
 *   4. Kiosk  → GET    /api/sessions/:id             polls status, then downloads each photo
 *   5. Kiosk  → DELETE /api/sessions/:id             after printing — photos wiped
 *
 * Photos live IN MEMORY only and are auto-deleted when a session expires.
 * Suits Render's free tier (no persistent disk) and protects customer privacy.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- Config (set as Environment Variables on Render) ----------
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');   // https://crazy-moment-upload-server.onrender.com
const KIOSK_API_KEY = process.env.KIOSK_API_KEY || '';                  // if set, kiosk must send header x-kiosk-key
const SESSION_MINUTES = Number(process.env.SESSION_MINUTES || 10);
const EXTEND_MINUTES = Number(process.env.EXTEND_MINUTES || 5);
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 15);
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 60);
const GRACE_MS = 5 * 60_000; // kiosk may still download for 5 min after phone-side expiry

// Products — must match the kiosk software
const PRODUCTS = {
  'photo-strip':   { name: 'Photo Strip',   required: 4,  size: '2 × 6"' },
  'duo-photo':     { name: 'Duo Photo',     required: 2,  size: '4 × 6"' },
  'single-photo':  { name: 'Single Photo',  required: 1,  size: '4 × 6"' },
  'photo-grid-12': { name: '12 Photo Grid', required: 12, size: '4 × 6"' },
};
const ALLOWED_MIME = /^image\/(jpeg|png|webp|heic|heif)$/i;

// ---------- In-memory session store ----------
const sessions = new Map();
const newId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url'); // unguessable, URL-safe

function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

function view(s, req) {
  const b = baseUrl(req);
  return {
    id: s.id,
    kioskId: s.kioskId,
    location: s.location,
    product: s.productKey,
    productName: s.product.name,
    required: s.required,
    received: s.photos.length,
    status: s.status,                 // waiting | connected | uploading | complete | expired
    phoneConnected: s.phoneConnected,
    createdAt: new Date(s.createdAt).toISOString(),
    expiresAt: new Date(s.expiresAt).toISOString(),
    secondsLeft: Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000)),
    uploadUrl: `${b}/u/${s.id}`,
    photos: s.photos.map((p, i) => ({
      id: p.id, index: i + 1, name: p.name, bytes: p.buffer.length, mime: p.mime,
      url: `${b}/api/sessions/${s.id}/photos/${p.id}`,
    })),
  };
}

function getSession(id) {
  const s = sessions.get(id);
  if (s && s.status !== 'complete' && Date.now() > s.expiresAt) s.status = 'expired';
  return s || null;
}

setInterval(() => {
  const cutoff = Date.now() - GRACE_MS;
  for (const [id, s] of sessions) if (s.expiresAt < cutoff) sessions.delete(id);
}, 30_000).unref();

// ---------- HTTP helpers ----------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Kiosk-Key,X-File-Name',
  'Access-Control-Max-Age': '86400',
};

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...CORS,
    'Content-Type': isBuf || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...headers,
  });
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
  const buf = await readBody(req, 100 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { return {}; }
}

const kioskOk = (req) => !KIOSK_API_KEY || req.headers['x-kiosk-key'] === KIOSK_API_KEY;

const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
// Only these files are ever served. They are looked for in public/ first, then next to server.js
// (so the app still works if the files were uploaded to the top of the GitHub repo by mistake).
const PUBLIC_FILES = new Set(['index.html', 'upload.html', 'kiosk-test.html', 'kiosk-client.js']);
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
// Log at startup which pages are available — visible in Render → Logs
for (const f of PUBLIC_FILES) {
  const where = SEARCH_DIRS.find((d) => fs.existsSync(path.join(d, f)));
  console.log(`${where ? '✓' : '✗ MISSING'} ${f}${where ? ' (' + path.relative(__dirname, where || '.') + '/' + ')' : ''}`);
}

// ---------- Routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;
  const seg = p.split('/').filter(Boolean); // e.g. ['api','sessions',id,'photos',pid]

  if (m === 'OPTIONS') return send(res, 204, '');

  // Health / wake-up — kiosk pings this on boot (Render free tier cold start ~1 min)
  if (p === '/health') return json(res, 200, { ok: true, service: 'crazy-moment-upload-server', sessions: sessions.size, time: new Date().toISOString() });

  if (m === 'GET' && p === '/') return serveFile(res, 'index.html');
  if (m === 'GET' && p === '/kiosk-test') return serveFile(res, 'kiosk-test.html');
  if (m === 'GET' && seg[0] === 'u' && seg.length === 2) return serveFile(res, 'upload.html');
  if (m === 'GET' && seg.length === 1 && /^[\w.-]+\.(js|css|svg|png|ico|html)$/.test(seg[0])) return serveFile(res, seg[0]);

  if (seg[0] !== 'api') return json(res, 404, { error: 'Not found' });

  if (m === 'GET' && p === '/api/products') return json(res, 200, PRODUCTS);

  // 1) Kiosk creates a session
  if (m === 'POST' && p === '/api/sessions') {
    if (!kioskOk(req)) return json(res, 401, { error: 'Invalid kiosk key' });
    const { product = 'photo-strip', kioskId = 'KIOSK-01', location = 'Bandar Hilir' } = await readJson(req);
    const prod = PRODUCTS[product];
    if (!prod) return json(res, 400, { error: `Unknown product "${product}"`, products: Object.keys(PRODUCTS) });
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) sessions.delete(oldest.id);
    }
    const now = Date.now();
    const s = {
      id: newId(), kioskId: String(kioskId).slice(0, 40), location: String(location).slice(0, 60),
      productKey: product, product: prod, required: prod.required, photos: [],
      status: 'waiting', phoneConnected: false, createdAt: now, expiresAt: now + SESSION_MINUTES * 60_000,
    };
    sessions.set(s.id, s);
    return json(res, 201, view(s, req));
  }

  if (seg[1] !== 'sessions' || !seg[2]) return json(res, 404, { error: 'Not found' });
  const id = seg[2];

  // 2) Status (kiosk polls; phone reads on load)
  if (m === 'GET' && seg.length === 3) {
    const s = getSession(id);
    return s ? json(res, 200, view(s, req)) : json(res, 404, { error: 'Session not found or already closed' });
  }

  // 5) Kiosk closes session after printing — photos wiped immediately
  if (m === 'DELETE' && seg.length === 3) {
    if (!kioskOk(req)) return json(res, 401, { error: 'Invalid kiosk key' });
    return json(res, 200, { ok: true, deleted: sessions.delete(id) });
  }

  // Phone opened the page → kiosk shows "Phone connected"
  if (m === 'POST' && seg[3] === 'connect') {
    const s = getSession(id);
    if (!s) return json(res, 404, { error: 'Session not found' });
    if (s.status === 'expired') return json(res, 410, { error: 'Session expired' });
    s.phoneConnected = true;
    if (s.status === 'waiting') s.status = 'connected';
    return json(res, 200, view(s, req));
  }

  // Kiosk "Extend Session"
  if (m === 'POST' && seg[3] === 'extend') {
    if (!kioskOk(req)) return json(res, 401, { error: 'Invalid kiosk key' });
    const s = sessions.get(id);
    if (!s) return json(res, 404, { error: 'Session not found' });
    s.expiresAt = Math.max(s.expiresAt, Date.now()) + EXTEND_MINUTES * 60_000;
    if (s.status === 'expired') s.status = s.photos.length ? 'uploading' : (s.phoneConnected ? 'connected' : 'waiting');
    return json(res, 200, view(s, req));
  }

  // 3) Phone uploads ONE photo (raw image body, Content-Type: image/jpeg, X-File-Name optional)
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
    // re-check after the (possibly slow) upload finished
    if (getSession(id) !== s || s.status === 'expired') return json(res, 410, { error: 'Session expired' });
    if (s.photos.length >= s.required) return json(res, 409, { error: 'This session already has all its photos.' });
    let name = 'photo.jpg';
    try { name = decodeURIComponent(req.headers['x-file-name'] || name).slice(0, 120); } catch {}
    s.photos.push({ id: newId(6), name, mime, buffer, at: Date.now() });
    s.phoneConnected = true;
    s.status = s.photos.length >= s.required ? 'complete' : 'uploading';
    return json(res, 200, view(s, req));
  }

  // 4) Kiosk downloads a photo (allowed during grace period after expiry)
  if (m === 'GET' && seg[3] === 'photos' && seg[4]) {
    const s = sessions.get(id);
    const ph = s && s.photos.find((x) => x.id === seg[4]);
    if (!ph) return json(res, 404, { error: 'Photo not found' });
    return send(res, 200, ph.buffer, { 'Content-Type': ph.mime, 'Cache-Control': 'private, no-store' });
  }

  // Phone removes a photo before the set is complete
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

http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Server error' });
  });
}).listen(PORT, () => {
  console.log(`Crazy Moment upload server running on port ${PORT}`);
  if (KIOSK_API_KEY) console.log('Kiosk API key protection: ON');
});
