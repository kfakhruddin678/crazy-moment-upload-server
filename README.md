# Crazy Moment — Cloud Server (Fasa 1)

Satu server untuk **tiga pihak**:

| Pihak | Alamat | Fungsi |
|---|---|---|
| Telefon pelanggan | `/u/<id>` | Scan QR & upload gambar (sama seperti dulu) |
| Kiosk | `/api/kiosk/...` | Tarik produk/harga/templat/tetapan, heartbeat 30 saat, lapor order |
| **Admin Dashboard** | **`/admin`** | Urus produk, templat, kiosk, order, tetapan & pengguna |

## Fail dalam repo (7 fail, semua di atas sekali — tanpa folder)

| Fail | Fungsi |
|---|---|
| `server.js` | Server (API telefon + kiosk + admin) |
| `store.js` | **Baharu** — simpan data ke PostgreSQL (atau fail sementara) |
| `admin.html` | **Baharu** — Admin Dashboard |
| `package.json` | Kini ada pakej `pg` (untuk PostgreSQL) |
| `upload.html`, `kiosk-test.html`, `kiosk-client.js`, `index.html` | Tidak berubah |

## Langkah deploy ke Render

1. **GitHub** → repo `crazy-moment-upload-server` → *Add file → Upload files* → seret `server.js`, `store.js`, `admin.html`, `package.json`, `README.md` → *Commit*.
2. **Render → New → PostgreSQL** → Region **Singapore** → cipta. Salin **Internal Database URL**.
   *Nota: pangkalan data Free di Render tamat tempoh selepas 30 hari — pilih pelan berbayar (Basic) untuk operasi sebenar.*
3. **Render → crazy-moment-upload-server → Environment** → tambah:

   | Key | Nilai |
   |---|---|
   | `DATABASE_URL` | Internal Database URL dari langkah 2 |
   | `ADMIN_EMAIL` | emel anda (untuk log masuk) |
   | `ADMIN_PASSWORD` | kata laluan kuat (min 8 aksara) |

   Render akan deploy semula secara automatik.
4. Buka `https://crazy-moment-upload-server.onrender.com/admin` → log masuk.
   Jika `ADMIN_PASSWORD` tidak diset: emel `admin@crazymoment.my`, kata laluan `crazymoment123` — sistem akan paksa tukar semasa log masuk pertama.

> Tanpa `DATABASE_URL`, data disimpan dalam fail sementara dan **hilang setiap kali Render restart/deploy**. Dashboard akan papar amaran merah.

## Sambung kiosk

1. Guna fail kiosk baharu `crazy_moment_kiosk_software.html` (sudah dikemas kini).
2. Dashboard → **Kiosks** → pilih kiosk → **Generate key** → **Copy setup link**.
3. Pada komputer kiosk, buka fail kiosk **sekali** dengan hujung alamat `?kiosk=KIOSK-01&key=ck_xxxx`. Kiosk simpan ID & kunci sendiri.
4. Dalam 30 saat kiosk muncul **Online** di dashboard.

Kiosk tanpa kunci masih diterima (untuk ujian), tetapi dashboard tandakan **No key**. Selepas kunci dijana, hanya kiosk dengan kunci yang betul diterima.

## Apa yang berlaku secara automatik

- Tukar harga / produk / templat / tetapan di dashboard → kiosk ambil perubahan dalam ≤ 30 saat, **hanya bila tiada pelanggan** (skrin pilih produk).
- Harga order sentiasa dikira oleh server (kiosk tak boleh tetapkan harga sendiri).
- Kiosk simpan config terakhir & order yang belum dihantar — jika internet putus, order dihantar semula bila internet kembali.
- Gambar pelanggan kekal dalam memori server sahaja dan dipadam selepas cetak (tidak pernah dipaparkan di dashboard).
- Semua perubahan oleh admin direkod dalam **Audit Log**.

## Had Fasa 1 (akan datang)

- **Bayaran masih simulasi** — order ditanda *Demo*. Fasa 2: payment gateway DuitNow QR + terminal kad dengan webhook.
- **Status printer** belum dilaporkan — Fasa 3: agen printer DNP, Restart / Test Print dari dashboard.
- Tetapan *Language*, *Idle Screen* dan *Printer* disimpan & dihantar ke kiosk, tetapi kiosk belum menggunakannya.

## API ringkas

```
Kiosk (header x-kiosk-id, x-kiosk-key)
  GET  /api/kiosk/config?kioskId=KIOSK-01
  POST /api/kiosk/heartbeat          {kioskId, state, step, configVersion, printer, session}
  POST /api/kiosk/orders             {clientRef, productId, qty, payMethod, paymentStatus, status, templateId}
  PATCH /api/kiosk/orders/:clientRef {status:'completed'}

Admin (header Authorization: Bearer <token>)
  POST /api/admin/login · GET /api/admin/overview?date=&range=
  /api/admin/products · /templates · /assets · /kiosks · /orders · /orders.csv · /settings · /users · /audit
```
