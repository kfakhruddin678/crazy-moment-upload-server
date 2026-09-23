/**
 * Crazy Moment — Kiosk Upload Client
 * ----------------------------------
 * Drop this into the kiosk software (Step 2: Upload Photos).
 *
 *   <script src="https://crazy-moment-upload-server.onrender.com/kiosk-client.js"></script>
 *   (or copy the file next to the kiosk HTML so it also works offline-first)
 *
 * Usage:
 *   const up = new CrazyMomentUpload({
 *     server:   'https://crazy-moment-upload-server.onrender.com',
 *     kioskId:  'KIOSK-01',
 *     location: 'Bandar Hilir',
 *     apiKey:   '',                               // only if KIOSK_API_KEY is set on Render
 *     onStatus: (s) => { ... },                    // every poll: s.status, s.received, s.required, s.secondsLeft
 *     onPhoto:  (photo) => { ... },                // each new photo: { id, index, blob, objectUrl }
 *     onComplete: (photos) => { ... },             // all required photos received
 *     onExpired: () => { ... },
 *     onError:  (err) => { ... },
 *   });
 *   await up.wake();                                // call when the kiosk boots (Render free tier cold start)
 *   const s = await up.start('photo-strip');        // 'photo-strip' | 'duo-photo' | 'single-photo' | 'photo-grid-12'
 *   drawQR(s.uploadUrl);                            // encode with the kiosk's existing offline QR encoder
 *   ...
 *   await up.extend();                              // "Extend Session" button
 *   await up.finish();                              // after printing — deletes photos on the server
 */
(function (global) {
  class CrazyMomentUpload {
    constructor(opts = {}) {
      this.server = (opts.server || '').replace(/\/$/, '');
      this.kioskId = opts.kioskId || 'KIOSK-01';
      this.location = opts.location || 'Bandar Hilir';
      this.apiKey = opts.apiKey || '';
      this.pollMs = opts.pollMs || 2000;
      this.cb = opts;
      this.session = null;
      this.photos = new Map(); // id -> { id, index, blob, objectUrl }
      this._timer = null;
      this._completeFired = false;
    }

    _headers(json) {
      const h = {};
      if (json) h['Content-Type'] = 'application/json';
      if (this.apiKey) h['x-kiosk-key'] = this.apiKey;
      return h;
    }

    async _json(path, opts = {}) {
      const r = await fetch(this.server + path, opts);
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(body.error || `HTTP ${r.status}`), { status: r.status });
      return body;
    }

    /** Ping /health until the server answers (free tier can take ~1 min to wake). */
    async wake(maxWaitMs = 90000) {
      const t0 = Date.now();
      while (Date.now() - t0 < maxWaitMs) {
        try { await this._json('/health'); return true; } catch (e) { await new Promise(r => setTimeout(r, 3000)); }
      }
      return false;
    }

    async start(product = 'photo-strip') {
      this.stop();
      this._revokeAll();
      this._completeFired = false;
      this.session = await this._json('/api/sessions', {
        method: 'POST', headers: this._headers(true),
        body: JSON.stringify({ product, kioskId: this.kioskId, location: this.location }),
      });
      this._timer = setInterval(() => this._poll(), this.pollMs);
      this._poll();
      return this.session;
    }

    /** The link to put in the QR code (encode it with the kiosk's offline QR encoder). */
    uploadUrl() {
      return this.session ? this.session.uploadUrl : '';
    }

    async _poll() {
      if (!this.session || this._busy) return;   // don't stack polls on slow networks
      this._busy = true;
      try {
        const s = await this._json(`/api/sessions/${this.session.id}`);
        this.session = s;
        this.cb.onStatus && this.cb.onStatus(s);

        for (const p of s.photos) {
          if (this.photos.has(p.id)) continue;
          this.photos.set(p.id, null); // reserve so we don't double-download
          const r = await fetch(p.url);
          if (!r.ok) { this.photos.delete(p.id); continue; }
          const blob = await r.blob();
          const photo = { id: p.id, index: p.index, blob, objectUrl: URL.createObjectURL(blob) };
          this.photos.set(p.id, photo);
          this.cb.onPhoto && this.cb.onPhoto(photo);
        }
        // photos removed on the phone
        for (const id of [...this.photos.keys()]) {
          if (!s.photos.find(p => p.id === id)) { const ph = this.photos.get(id); ph && URL.revokeObjectURL(ph.objectUrl); this.photos.delete(id); }
        }

        const ready = [...this.photos.values()].filter(Boolean);
        if (s.status === 'complete' && ready.length >= s.required && !this._completeFired) {
          this._completeFired = true;
          this.stop();
          this.cb.onComplete && this.cb.onComplete(ready.sort((a, b) => a.index - b.index));
        }
        if (s.status === 'expired') { this.stop(); this.cb.onExpired && this.cb.onExpired(); }
      } catch (e) {
        if (e.status === 404) { this.stop(); this.cb.onExpired && this.cb.onExpired(); }
        else this.cb.onError && this.cb.onError(e);
      } finally {
        this._busy = false;
      }
    }

    async extend() {
      if (!this.session) return null;
      this.session = await this._json(`/api/sessions/${this.session.id}/extend`, { method: 'POST', headers: this._headers(false) });
      if (!this._timer && this.session.status !== 'complete') this._timer = setInterval(() => this._poll(), this.pollMs);
      return this.session;
    }

    stop() { clearInterval(this._timer); this._timer = null; }

    /** Call after printing (or when the customer cancels). Wipes photos on the server. */
    async finish() {
      this.stop();
      if (this.session) {
        try { await this._json(`/api/sessions/${this.session.id}`, { method: 'DELETE', headers: this._headers(false) }); } catch (e) {}
      }
      this.session = null;
      this._revokeAll();
    }

    _revokeAll() {
      for (const p of this.photos.values()) p && URL.revokeObjectURL(p.objectUrl);
      this.photos.clear();
    }
  }
  global.CrazyMomentUpload = CrazyMomentUpload;
})(typeof window !== 'undefined' ? window : globalThis);
