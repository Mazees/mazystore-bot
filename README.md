# Mazy Store

Bot WhatsApp untuk reseller produk AI: Node.js 26 LTS, Express 5, Baileys, Cloudflare Worker + D1, dan SQLite lokal untuk sesi WA. Semua kode aplikasi menggunakan JavaScript ES Modules.

Alur buyer: **pilih produk → varian → kuantitas → konfirmasi → bayar QR sesuai nominal → `/done` → kirim foto bukti → verifikasi admin → proses → selesai**.

## Pembagian aplikasi

- `src/`: bot dan Express di hosting panel. Express menyediakan `GET /healthz` dan `GET /readyz`; tidak mengekspos file, QR pairing, atau kontrol admin melalui HTTP.
- `worker/`: API terautentikasi untuk D1. Bot mengaksesnya melalui HTTPS menggunakan secret bersama.
- `config/qris.txt`: payload QRIS dasar dari gambar merchant yang diberikan, sudah diperiksa checksum dan identitasnya. Bukan QRIS merchant dari kode contoh SmartPOS.
- `data/`: SQLite terenkripsi per nilai untuk auth, antrean teks sementara, dan retry. Folder ini harus persisten dan tidak boleh dibagikan.

Tidak ada arsip bukti pembayaran. Gambar diproses sementara dan diteruskan ke WhatsApp; library pengiriman dapat memakai file sementara yang dibersihkan. Bukti yang belum terkirim saat restart perlu dikirim ulang. Gambar dikirim sebagai **foto**, bukan dokumen; maksimal 5 MB. Pembayaran tetap diperiksa manual di aplikasi merchant.

## 1. Konfigurasi bot

Jalankan dari folder project dengan Node.js 26:

```sh
npm ci
npm run setup
```

Edit `.env`:

```dotenv
ADMIN_NUMBER=6281234567890
WORKER_URL=https://mazy-store-api.SUBDOMAIN.workers.dev
PORT=8906
```

`ADMIN_NUMBER` adalah nomor WA pribadi admin, **berbeda dari nomor bot**, tanpa `+` atau spasi. `PORT` harus mengikuti allocation panel hosting. `API_SECRET` dan `DATA_KEY` dibuat acak oleh setup; jangan dibagikan atau diganti tanpa merencanakan pemulihan sesi. `.env` tidak ditimpa jika sudah ada. Nomor contoh wajib diganti.

`QRIS_PAYLOAD_FILE=./config/qris.txt` sudah menunjuk QRIS toko. Untuk QRIS lain:

```sh
npm run qris:import -- gambar-qris.jpg config/qris-baru.txt
```

Ubah lokasi payload di `.env`. `QRIS_PAYLOAD`, jika diisi, lebih diprioritaskan daripada file. `EXPECTED_MERCHANT` harus cocok dengan nama merchant. Bot menolak QR rusak, merchant tidak sesuai, serta payload dengan biaya/tip tambahan. Simpan konfigurasi QRIS yang sama selama masih ada order menunggu pembayaran; pengiriman ulang order dengan versi QRIS berbeda ditolak.

## 2. Buat D1 dan deploy Worker

Lakukan dari komputer pengembangan yang mempunyai browser untuk login Cloudflare. Tidak memerlukan R2 atau kartu kredit untuk konfigurasi ini.

```sh
npx wrangler login
npx wrangler d1 create mazy-store
```

Salin `database_id` ke `worker/wrangler.local.jsonc`, lalu:

```sh
npm run db:remote
npm run worker:deploy
npm run worker:secret
```

Perintah terakhir mengirim `API_SECRET` dari `.env` ke secret Worker tanpa mencetaknya. Isi `WORKER_URL` dengan URL hasil deploy. Worker akan menolak request sampai secret diatur. Semua request bisnis memakai `Authorization: Bearer <API_SECRET>`. Jangan menaruh secret ini di pesan buyer atau kode publik.

Endpoint Worker berada di `/v1`: katalog, pengelolaan varian, customer/session, order/action, referensi pesan, serta percakapan. Tidak ada endpoint SQL bebas. Nominal dihitung di Worker; buyer tidak menentukan harga. Perubahan status dan log tindakan dilakukan dalam batch atomik. Satu order aktif per buyer ditegakkan dengan unique index.

Untuk development lokal, ganti `database_id` terlebih dahulu, jalankan `npm run db:local`, isi secret di `worker/.dev.vars`, kemudian `npm run worker:dev`. Arahkan `WORKER_URL` bot ke alamat lokal Wrangler. Jangan gunakan URL localhost pada hosting produksi.

## 3. Jalankan di panel

Upload source, `package.json`, lockfile, `config/`, dan `.env`. Jangan upload `node_modules` Windows; install dependensi di server Linux:

```sh
npm ci --omit=dev
npm start
```

Startup panel harus menjalankan `npm start` dari folder project dan memakai Node.js 26. Jika memakai nvm, startup harus memuat nvm terlebih dahulu, misalnya pada panel yang mengizinkan command Bash:

```sh
bash -lc 'export NVM_DIR=/home/container/.nvm; source "$NVM_DIR/nvm.sh"; nvm use 26; exec npm start'
```

QR pairing ditampilkan di console. Scan melalui WhatsApp nomor bot → Perangkat tertaut. Alternatif: isi `PAIRING_NUMBER` dengan nomor bot format internasional agar console menampilkan kode pairing. Console dan kode pairing hanya untuk pemilik hosting.

Pastikan `/home/container`/folder project tetap tersimpan setelah restart. Panel harus menghidupkan ulang proses yang berhenti. Jalankan **satu instance** untuk satu sesi WA; jangan menambahkan cluster PM2. Aplikasi reconnect dengan backoff, tetapi sesi logout/bad session/tergantikan memerlukan pemeriksaan manual. Jangan menghapus database sesi untuk mengatasi gangguan jaringan biasa.

## 4. Operasional WhatsApp

### Buyer

| Perintah | Fungsi |
| --- | --- |
| `/menu` | Katalog tujuh kategori AI; keluar dari mode chat |
| `/pesanan` | Order aktif; kirim ulang QR jika belum `/done` |
| `/done` | Sudah membayar; bot meminta foto bukti, belum lunas |
| `/batal` | Batalkan sebelum `/done`; setelahnya minta pemeriksaan admin |
| `/chat` | Chat dengan admin, termasuk sebelum membeli/setelah selesai |
| `/akhirichat` | Keluar dari mode chat |

Jumlah 1–100 per order (bisa diturunkan melalui `MAX_QUANTITY`). Satu buyer satu order aktif. Tidak ada waktu kedaluwarsa otomatis. Harga dan ketentuan disalin ke order. Bila berubah sebelum konfirmasi, buyer diminta memeriksa ringkasan baru. Menutup varian tidak membatalkan order lama.

Dalam mode chat, angka termasuk OTP diteruskan sebagai teks. Balasan admin otomatis membuka mode chat buyer. Setelah pembayaran disetujui, mode chat juga aktif. Untuk kirim gambar bantuan sebelum bayar, buyer membuka `/chat`; bukti pembayaran resmi tetap melalui `/done`.

### Admin

Dari nomor `ADMIN_NUMBER`, ketik **`/admin` atau `/menu`**. Pengelolaan memakai submenu angka, bukan daftar perintah panjang:

1. **Pesanan & pembayaran**: antrean verifikasi, pesanan diproses, pembatalan, refund, dan riwayat semua status.
2. **Kelola katalog**: pilih kategori → varian → ubah nama/harga/ketentuan, buka/tutup, atau arsipkan. Tambah varian lewat pilihan 6 pada daftar kategori; kode dibuat otomatis. Varian baru dan varian yang dipulihkan selalu tutup.
3. **Percakapan buyer**: pilih buyer → Balas buyer → balas kartu tujuan dengan teks/gambar. Daftar menunjukkan aktivitas, bukan status dibaca.
4. **Status bot & pengiriman**: koneksi WA/D1, jumlah antrean, serta pengiriman meragukan yang dapat dipilih untuk pemeriksaan dan konfirmasi kirim ulang.

Navigasi konsisten: **0 = kembali, 00 = beranda, 8/9 = halaman sebelumnya/berikutnya** jika tersedia. Maksimal lima item data per halaman. Pilihan dan draft kedaluwarsa setelah 30 menit tanpa aktivitas. `/batal` membatalkan isian saat ini dengan kembali satu langkah. Perintah pengelolaan lama seperti `/harga` dan `/setujui` tidak lagi mengeksekusi perubahan; bot menunjukkan jalur submenu penggantinya.

Admin memilih order dari daftar, bukan mengetik ID. Persetujuan pembayaran, pembatalan, penyelesaian, serta refund melewati konfirmasi. Penolakan bukti, pembatalan, dan awal refund meminta alasan. Jika data berubah sejak menu ditampilkan, detail diperbarui dan tindakan harus dipilih ulang.

Untuk teks/gambar biasa, **balas notifikasi buyer atau kartu tujuan**. Balasan termasuk angka/OTP diteruskan sebagai chat; angka yang membalas pesan menu tetap menjadi navigasi. Pesan admin tanpa tujuan tidak diteruskan. Referensi tidak dikenali diarahkan ke Percakapan buyer. Bukti bayar berada di gambar notifikasi WA; menu tidak mengambil ulang gambar dari database.

Semua varian awalnya **TUTUP**. Lengkapi durasi/ketentuan sebelum membuka penjualan. Arsip menyembunyikan varian dari katalog buyer dan menutup pembelian baru, sementara data order lama tetap utuh. API key belum punya paket awal; gunakan Tambah varian pada kategorinya.

### Mencoba checkout melalui chat nomor bot sendiri

Buka WhatsApp akun bot, chat ke **nomornya sendiri**, lalu ketik `/menu`. Pesan yang kamu ketik sendiri diterima sebagai input buyer: pilih produk, varian, kuantitas, konfirmasi, `/done`, dan kirim bukti. Tidak ada prefix, flag `.env`, atau perintah mode test tambahan. Akses admin tetap dari nomor admin terpisah.

Pesan otomatis bot diberi ID sebelum pengiriman dan dikecualikan dari pemrosesan agar tidak terjadi loop. Pesan `fromMe` ke orang lain tidak diperlakukan sebagai input buyer. Order dari chat sendiri menggunakan data dan QRIS **asli**, bukan sandbox pembayaran. Tidak perlu mentransfer uang untuk menguji navigasi; verifikasi admin tetap manual.

### Memperbarui instalasi yang sudah berjalan

Jangan ubah `0001_init.sql` atau menghapus database/sesi. Dengan `database_id` dan secret yang sudah terkonfigurasi di laptop:

```sh
npm run db:remote
npm run worker:deploy
```

Ini menerapkan **0002_admin_ux.sql** dan menambahkan API admin. Deploy Worker sebelum memperbarui bot panel. `API_SECRET`, `DATA_KEY`, QRIS, serta nomor admin tetap memakai konfigurasi sebelumnya; tidak perlu menjalankan setup atau pairing ulang untuk update ini.

Setelah perubahan source sudah di-commit/push, perbarui kode di panel dengan `git pull`, hentikan proses bot lama, lalu jalankan bot menggunakan Node.js 26. Ketik `/admin` dari WA admin untuk membuka menu baru. Konfigurasi lokal `worker/wrangler.local.jsonc` diabaikan Git. `worker/wrangler.jsonc` adalah template publik tanpa ID database; jangan mengisi ID di template tersebut.

## 5. Pemulihan dan backup

- Teks keluar disimpan terenkripsi maksimal 24 jam untuk antrean/retry. Konten tidak ditulis ke log. Referensi transaksi/pesan tanpa isi tersimpan di D1.
- Jika send sudah terjadi tetapi pemetaan D1 gagal, bot mencoba menyimpan pemetaan lagi tanpa mengirim ulang teks.
- Jika hasil send tidak pasti atau proses berhenti di tengah send, bot menampilkannya melalui Admin → Status bot & pengiriman. Periksa chat tujuan sebelum mengonfirmasi kirim ulang; tidak ada jaminan kirim tepat sekali.
- Media langsung tidak masuk antrean persisten. Jika gagal, buyer diminta mengirim ulang. Gambar dalam WA mengikuti ketersediaan riwayat WA, bukan backup bot.
- Order tidak boleh dianggap berhasil sebelum tercatat di D1. Periksa `/pesanan` setelah gangguan koneksi sebelum mengulangi.
- Pantau `/readyz`, penggunaan RAM/disk, serta console lifecycle. Atur retensi console/log melalui panel karena stdout dikelola panel.

Backup sesi:

```sh
npm run backup
```

Unduh file `.backup` ke perangkat lain dan hapus salinan hosting. Isinya auth/antrean yang terenkripsi; `DATA_KEY` harus dicadangkan terpisah. Untuk restore, hentikan bot, cadangkan folder lama, lalu gunakan file backup sebagai `data/bot.sqlite` di folder data bersih dengan `DATA_KEY` semula.

Ekspor D1 dari komputer pengembangan:

```sh
npx wrangler d1 export mazy-store --remote --output=mazy-store-backup.sql --config worker/wrangler.local.jsonc
```

Lakukan backup di luar hosting setiap hari saat toko aktif. Backup lama mungkin masih berisi data sementara pada waktu backup; hapus backup sesi lama setelah 7 hari dan simpan kunci secara privat. Restore D1 hanya saat bot dihentikan agar data transaksi tidak bersilangan.

## Pengujian

```sh
npm run check
npm test
```

Tes mencakup Worker nyata dalam simulator D1, checkout kuantitas, idempotensi, persaingan satu order aktif, snapshot harga, pembayaran, refund/pembatalan, relay OTP, QRIS encode/decode, auth SQLite, retry, TTL, batas media, serta Express.

Sebelum membuka toko: scan QR hasil dengan dua aplikasi pembayaran dan pastikan merchant/nominal benar, lakukan pilot dua buyer bersamaan, verifikasi bukti di WA admin, uji OTP dua arah, restart panel, dan pastikan sesi tetap ada. Pairing WA, uji pembayaran nyata, serta kapasitas hosting memerlukan lingkungan/akun milik toko dan belum digantikan tes lokal.
