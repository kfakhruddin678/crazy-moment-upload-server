/**
 * Crazy Moment — storan data
 * --------------------------------------------------------------------
 * Semua rekod (produk, templat, kiosk, order, tetapan, pengguna) disimpan
 * sebagai dokumen JSON dalam "koleksi". Semua data dibaca ke memori semasa
 * server hidup (cepat), dan setiap perubahan ditulis terus ke storan kekal.
 *
 *   DATABASE_URL diset  → PostgreSQL (Render Postgres). DISYORKAN untuk operasi.
 *   DATABASE_URL kosong → fail JSON dalam DATA_DIR (lalai ./data).
 *                         Pada Render, fail ini HILANG bila server restart/deploy —
 *                         sesuai untuk ujian sahaja.
 *
 * Gambar templat (assets) TIDAK disimpan dalam memori — dibaca dari storan bila diminta.
 */
const fs = require('fs');
const path = require('path');

const COLLECTIONS = ['products', 'templates', 'kiosks', 'orders', 'users', 'settings', 'audit', 'counters'];

class Store {
  constructor() {
    this.mem = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()]));
    this.kind = process.env.DATABASE_URL ? 'postgres' : 'file';
    this.dir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
    this.pool = null;
    this.assetCache = new Map(); // LRU kecil untuk gambar
  }

  async init() {
    if (this.kind === 'postgres') {
      let pg;
      try { pg = require('pg'); } catch (e) {
        throw new Error('DATABASE_URL diset tetapi pakej "pg" tiada. Pastikan package.json ada "pg" dan Render jalankan npm install.');
      }
      const ssl = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) || process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false };
      this.pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 5 });
      await this.pool.query(`CREATE TABLE IF NOT EXISTS cm_docs (
        coll text NOT NULL, id text NOT NULL, data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (coll, id))`);
      await this.pool.query(`CREATE TABLE IF NOT EXISTS cm_assets (
        id text PRIMARY KEY, mime text NOT NULL, data bytea NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now())`);
      const { rows } = await this.pool.query('SELECT coll, id, data FROM cm_docs');
      for (const r of rows) if (this.mem[r.coll]) this.mem[r.coll].set(r.id, r.data);
      console.log(`Storan: PostgreSQL (${rows.length} rekod dimuatkan)`);
    } else {
      fs.mkdirSync(path.join(this.dir, 'assets'), { recursive: true });
      const file = path.join(this.dir, 'store.json');
      if (fs.existsSync(file)) {
        try {
          const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
          for (const c of COLLECTIONS) for (const [id, d] of Object.entries(raw[c] || {})) this.mem[c].set(id, d);
        } catch (e) { console.error('store.json rosak — mula kosong', e.message); }
      }
      console.log(`Storan: fail JSON di ${file} (SEMENTARA — set DATABASE_URL untuk operasi sebenar)`);
    }
  }

  all(coll) { return [...this.mem[coll].values()]; }
  get(coll, id) { return this.mem[coll].get(id) || null; }
  count(coll) { return this.mem[coll].size; }

  async put(coll, id, data) {
    this.mem[coll].set(id, data);
    if (this.kind === 'postgres') {
      await this.pool.query(
        `INSERT INTO cm_docs (coll, id, data, updated_at) VALUES ($1,$2,$3,now())
         ON CONFLICT (coll, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [coll, id, data]);
    } else this._flushSoon();
    return data;
  }

  async del(coll, id) {
    const had = this.mem[coll].delete(id);
    if (this.kind === 'postgres') await this.pool.query('DELETE FROM cm_docs WHERE coll=$1 AND id=$2', [coll, id]);
    else this._flushSoon();
    return had;
  }

  // Nombor berturutan (cth. nombor order harian) — atomik dalam satu proses server
  async nextSeq(key) {
    const cur = this.get('counters', key) || { n: 0 };
    const next = { n: cur.n + 1 };
    await this.put('counters', key, next);
    return next.n;
  }

  _flushSoon() {
    if (this._t) return;
    this._t = setTimeout(() => {
      this._t = null;
      const out = {};
      for (const c of COLLECTIONS) out[c] = Object.fromEntries(this.mem[c]);
      const file = path.join(this.dir, 'store.json');
      fs.writeFile(file + '.tmp', JSON.stringify(out), (err) => {
        if (err) return console.error('Gagal simpan store.json', err.message);
        fs.rename(file + '.tmp', file, () => {});
      });
    }, 300);
  }

  // ---------- Gambar (templat, logo) ----------
  async putAsset(id, mime, buffer) {
    if (this.kind === 'postgres') {
      await this.pool.query('INSERT INTO cm_assets (id, mime, data) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET mime=EXCLUDED.mime, data=EXCLUDED.data', [id, mime, buffer]);
    } else {
      fs.writeFileSync(path.join(this.dir, 'assets', id), buffer);
      fs.writeFileSync(path.join(this.dir, 'assets', id + '.mime'), mime);
    }
    this._cacheAsset(id, { mime, buffer });
  }

  async getAsset(id) {
    if (!/^[\w-]{6,40}$/.test(id)) return null;
    if (this.assetCache.has(id)) return this.assetCache.get(id);
    let a = null;
    if (this.kind === 'postgres') {
      const { rows } = await this.pool.query('SELECT mime, data FROM cm_assets WHERE id=$1', [id]);
      if (rows[0]) a = { mime: rows[0].mime, buffer: rows[0].data };
    } else {
      const f = path.join(this.dir, 'assets', id);
      if (fs.existsSync(f)) a = { mime: fs.readFileSync(f + '.mime', 'utf8'), buffer: fs.readFileSync(f) };
    }
    if (a) this._cacheAsset(id, a);
    return a;
  }

  async delAsset(id) {
    if (!id || !/^[\w-]{6,40}$/.test(id)) return;
    this.assetCache.delete(id);
    if (this.kind === 'postgres') await this.pool.query('DELETE FROM cm_assets WHERE id=$1', [id]);
    else for (const f of [id, id + '.mime']) fs.rm(path.join(this.dir, 'assets', f), { force: true }, () => {});
  }

  _cacheAsset(id, a) {
    this.assetCache.set(id, a);
    let total = 0;
    for (const v of this.assetCache.values()) total += v.buffer.length;
    // simpan maksimum ~40 MB gambar dalam memori
    for (const k of this.assetCache.keys()) {
      if (total <= 40 * 1024 * 1024) break;
      total -= this.assetCache.get(k).buffer.length;
      this.assetCache.delete(k);
    }
  }
}

module.exports = { Store };
