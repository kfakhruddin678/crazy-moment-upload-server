# Crazy Moment — Scan & Upload Server

Menghubungkan **smartphone pelanggan** dengan **kiosk Crazy Moment**. Pelanggan imbas QR di kiosk, pilih gambar di telefon, dan gambar terus sampai ke kiosk.

Node.js tulen, tiada dependency. **Semua fail diletakkan terus di dalam repo, tanpa folder.**

## Fail dalam repo (6 fail)

| Fail | Fungsi |
|---|---|
| `server.js` | Server |
| `package.json` | Beritahu Render cara jalankan server |
| `upload.html` | Halaman telefon (dibuka selepas imbas QR) |
| `kiosk-test.html` | Halaman ujian kiosk: buka di laptop |
| `kiosk-client.js` | Penyambung untuk kiosk software |
| `index.html` | Halaman utama |

## Tetapan Render

| Medan | Nilai |
|---|---|
| Language | Node |
| Region | Singapore |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | Free (Starter untuk operasi sebenar) |

Environment Variables (pilihan):

| Key | Nilai |
|---|---|
| `KIOSK_API_KEY` | kata laluan rahsia (hanya kiosk boleh buka sesi) |
| `SESSION_MINUTES` | `10` |

Jika `KIOSK_API_KEY` diset, halaman `/kiosk-test` tak boleh cipta sesi. Jadi biarkan kosong semasa menguji.

## Uji

1. Laptop: `https://<nama-service>.onrender.com/kiosk-test`
2. Pilih produk → **Start new session**
3. Imbas QR dengan telefon → pilih gambar → **Upload**
4. Gambar muncul di laptop

## Sambung ke kiosk software

```html
<script src="kiosk-client.js"></script>
<script>
const upload = new CrazyMomentUpload({
  server: 'https://<nama-service>.onrender.com',
  kioskId: 'KIOSK-01', location: 'Bandar Hilir', apiKey: '',
  onStatus:   s => {},        // s.status, s.received, s.required, s.secondsLeft
  onPhoto:    p => {},        // p.index, p.objectUrl
  onComplete: photos => {},   // terus ke Edit & Preview
  onExpired:  () => {},
});
upload.wake();                                  // semasa kiosk dihidupkan
const s = await upload.start('photo-strip');    // photo-strip | duo-photo | single-photo | photo-grid-12
drawQR(s.uploadUrl);                            // encoder QR offline dalam kiosk
// await upload.extend();  await upload.finish();
</script>
```

Nota: pelan Free tidur selepas 15 minit tanpa trafik, dan ambil ~1 minit untuk bangun semula.
