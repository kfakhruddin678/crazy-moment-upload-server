# Crazy Moment — Cloud Server (Fasa 1)

## Baharu dalam v1.2 — Editor susunan foto produk

- **Products** di dashboard kini buka editor penuh: nama, **jenis cetakan** (4×6 atau 2×6 ×2), **susunan petak foto** (seret untuk alih, tarik sudut untuk ubah saiz, tambah/buang petak, susun automatik), harga dan *Show on kiosk*.
- Kiosk ambil produk, bilangan foto & susunan baharu secara automatik dalam ≤ 30 saat (hanya bila tiada pelanggan).
- 2×6 ×2: reka satu strip sahaja — kiosk cetak dua salinan & printer potong di tengah (queue `CM-DNP-2inch`).
- **Orientasi landskap**: reka bentuk & semua skrin kiosk kekal landskap; kertas tetap 4R — kiosk putar 90° semasa cetak.
- **v1.4 Templates:** *Simple* = warna/gradient + pattern (siap atau upload sendiri) untuk semua produk; *Special* = artwork penuh media (upload, auto Fill/Stretch) untuk produk dipilih, disusun ikut produk. Template sentiasa di belakang foto.
- **v1.5 Stickers:** menu baharu *Stickers* di admin — upload PNG/WEBP lutsinar (banyak sekaligus), susun ikut kategori, kata carian, Popular, papar/sorok. Kiosk papar dulang sticker gaya Instagram (carian, Popular, Recent, kategori), seret ke 🗑 untuk buang. 20 sticker contoh dimasukkan automatik kali pertama (boleh dipadam). Data disimpan dalam `settings/stickers` — store.js tidak berubah.
- **v1.3:** garis potong putus-putus (dicetak), garis panduan hijau semasa seret, dan sehingga 6 logo setiap produk.
- **Logo setiap produk** (admin sahaja): papar/sorok, seret, ubah saiz, putar, gaya Full/Small, atau upload PNG sendiri. Teks Acara pelanggan muncul di atas logo.
- 4 produk asal (Photo Strip, Duo, Single, 12 Grid) kekal guna enjin cetak asal selagi susunannya tidak diubah.
- Perlu **kedua-dua**: `server.js` + `admin.html` (GitHub → Render) **dan** fail kiosk `crazy_moment_kiosk_software.html` v1.2. Kiosk lama tidak akan papar produk susunan baharu.


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

- **Bayaran masih simulasi** — order ditanda *Demo*. Fasa 2: DuitNow QR melalui HitPay dengan webhook (pembayaran kad tidak digunakan).
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
