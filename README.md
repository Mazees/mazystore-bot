# Mazy Store

Bot WhatsApp untuk reseller produk AI: Node.js 26 LTS, Express 5, Baileys, Cloudflare Worker + D1, dan SQLite lokal untuk sesi WA. Semua kode aplikasi menggunakan JavaScript ES Modules.

Alur buyer: **pilih produk → varian → kuantitas → konfirmasi → bayar QR sesuai nominal → `/done` → kirim foto bukti → admin menyetujui → CLAIM langsung ke WA admin → barang diserahkan → admin menandai Selesai**.

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

### Tampilan bersama buyer dan admin

Menu buyer/admin, detail order, konfirmasi, pembayaran, dan CLAIM memakai frame monospace dengan garis kiri, atas, pemisah, dan bawah saja. Tidak ada garis kanan atau spasi pengisi di ujung baris. Teks panjang tetap dibungkus otomatis, termasuk Unicode. Link WhatsApp berada di luar frame supaya mudah diklik. Pesan panjang dipecah menjadi beberapa frame.

Semua pilihan memakai **1, 2, 3, ... sesuai urutan layar**, termasuk Kembali, Beranda, dan pindah halaman. Tidak ada nomor navigasi khusus 0, 00, 6/7, atau 8/9. Saat mengisi nama, harga, alasan, atau kuantitas, gunakan `/kembali`; angka adalah data, bukan navigasi. `/admin` membuka beranda admin dan `/menu` membuka katalog buyer (atau beranda jika pengirim adalah admin).

Jumlah varian nonarsip ditampilkan di samping kategori, misalnya `CHATGPT API KEY (0)`. Varian tutup tetap termasuk hitungan tersebut; status Buka/Tutup ditampilkan pada varian masing-masing. Kategori kosong menampilkan pilihan berurutan: Tambah varian, Lihat arsip, Kembali, Beranda.

### Buyer dan CLAIM

| Perintah | Fungsi |
| --- | --- |
| `/menu` | Katalog tujuh kategori AI |
| `/pesanan` | Status order aktif; kirim ulang QR sebelum bayar atau link CLAIM saat Diproses |
| `/done` | Menyatakan sudah membayar; bot meminta foto bukti, belum lunas |
| `/batal` | Batalkan sebelum `/done`; setelahnya minta pemeriksaan admin |
| `/chat` | Link WA pribadi admin; tidak mengaktifkan relay |
| `/kembali` | Kembali dari isian ke langkah sebelumnya |

Jumlah 1–100 per order (bisa diturunkan melalui `MAX_QUANTITY`). Satu buyer satu order aktif; tidak ada kedaluwarsa otomatis. Harga dan ketentuan disalin ke order. Perubahan harga/ketentuan sebelum konfirmasi meminta buyer memeriksa ringkasan baru.

Setelah admin memeriksa uang masuk dan menyetujui pembayaran, status menjadi **Diproses** dan buyer menerima link `wa.me` menuju `ADMIN_NUMBER` dengan pesan:

```text
CLAIM
ID Pesanan: MZ-XXXXXXXXXXXXXXXX
```

Link CLAIM tidak diberikan untuk order belum dibayar atau masih menunggu verifikasi. `/pesanan` dapat mengirim ulang link selama Diproses. Penyerahan barang, OTP, kredensial, dan bantuan dilakukan **langsung di chat pribadi buyer dengan admin**, bukan melalui bot. Setelah seluruh barang diserahkan, admin menandai pesanan Selesai di submenu order. Status Diproses tetap menahan pembelian baru sampai selesai atau refund ditutup.

Untuk pertanyaan sebelum membayar, `/chat` membuka WA admin dengan pesan pertanyaan umum/order tanpa header CLAIM. Foto hanya diteruskan sebagai bukti pembayaran setelah `/done`; gambar bantuan dan pesan biasa tidak diteruskan. `/akhirichat` lama hanya memberi petunjuk kontak langsung. Mode chat dari sesi lama tidak mengaktifkan relay kembali.

### Admin

Ketik **`/admin` atau `/menu`** dari nomor `ADMIN_NUMBER`:

1. **Pesanan & pembayaran**: verifikasi, pesanan Diproses, pembatalan, refund, serta seluruh riwayat.
2. **Kelola katalog**: pilih kategori → varian → ubah nama/harga/ketentuan, buka/tutup, arsip/pulihkan, atau tambah varian dengan kode otomatis.
3. **Status bot & pengiriman**: koneksi WA/D1, antrean, dan pengiriman meragukan yang dapat dikirim ulang setelah pemeriksaan.

Nomor pilihan mengikuti layar. Maksimal lima item data per halaman; menu tetap menampilkan tindakan serta navigasi setelah daftar. Pilihan dan draft kedaluwarsa setelah 30 menit. Tindakan kritis menampilkan konfirmasi, sedangkan penolakan bukti, pembatalan admin, dan awal refund meminta alasan. Data yang berubah sejak menu ditampilkan harus diperiksa ulang.

Bukti pembayaran ada pada gambar notifikasi WA, bukan arsip database. Pilihan **Hubungi buyer** menampilkan link chat langsung. Balasan teks/gambar ke notifikasi, kartu tujuan lama, atau bukti pembayaran **tidak diteruskan**; bot menampilkan kontak langsung. Submenu Percakapan buyer dihapus. Perintah pengelolaan lama seperti `/harga` dan `/setujui` hanya memberi petunjuk menuju submenu.

Varian baru dan varian hasil pemulihan arsip selalu tutup. Lengkapi ketentuan sebelum membuka penjualan. Arsip menyembunyikan varian dari buyer tanpa mengubah snapshot order lama.

### Mencoba checkout melalui chat nomor bot sendiri

Buka WhatsApp akun bot → chat ke nomornya sendiri → `/menu`. Pilihan produk, kuantitas, `/done`, dan foto bukti mengikuti alur buyer biasa tanpa prefix/flag khusus. Pesan otomatis bot dikecualikan agar tidak terjadi loop; pesan `fromMe` ke orang lain tidak menjadi input buyer. Akses admin tetap dari nomor admin terpisah.

Order dan QRIS tersebut **asli**, bukan sandbox. Tidak perlu mentransfer uang untuk mencoba navigasi; persetujuan pembayaran tetap manual dan CLAIM baru dikirim setelah disetujui.

### Memperbarui instalasi yang sudah berjalan

Jika submenu admin versi sebelumnya sudah berjalan, perubahan CLAIM/tampilan ini **tidak memerlukan migrasi D1 atau deploy Worker baru**. Struktur database dan API tidak berubah. Jangan mengganti secret, menjalankan setup ulang, atau menghapus sesi WA.

Setelah perubahan source di-commit/push, ambil kode di panel dengan `git pull`, hentikan proses bot lama, lalu jalankan ulang memakai **Node.js 26**. Periksa `/admin` dari WA admin dan `/menu` dari sisi buyer. Kode bot panel tidak diperbarui otomatis oleh deploy Worker.

Saat startup pertama versi ini, antrean relay lama dinonaktifkan dan cache retry pesan lama dibersihkan. Auth WA, order, serta referensi pesan dipertahankan. Konfigurasi `worker/wrangler.local.jsonc` tetap lokal/diabaikan Git; `worker/wrangler.jsonc` tetap template tanpa ID database.

## 5. Pemulihan dan backup

- Teks transaksi/notifikasi keluar disimpan terenkripsi maksimal 24 jam untuk antrean/retry. Tidak ada relay chat atau OTP. Konten tidak ditulis ke log. Referensi transaksi/pesan tanpa isi tersimpan di D1.
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

Tes mencakup Worker nyata dalam simulator D1, checkout kuantitas, idempotensi, persaingan satu order aktif, snapshot harga, pembayaran, refund/pembatalan, CLAIM, pencegahan relay, penomoran dinamis, grid Unicode, QRIS encode/decode, auth SQLite, retry, TTL, batas media, serta Express.

Sebelum membuka toko: scan QR hasil dengan dua aplikasi pembayaran dan pastikan merchant/nominal benar, lakukan pilot dua buyer bersamaan, verifikasi bukti di WA admin, uji link CLAIM dan chat langsung ke admin, restart panel, dan pastikan sesi tetap ada. Pairing WA, uji pembayaran nyata, serta kapasitas hosting memerlukan lingkungan/akun milik toko dan belum digantikan tes lokal.
