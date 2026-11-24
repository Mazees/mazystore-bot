# Mazy Store

Bot WhatsApp untuk reseller produk AI: Node.js 26 LTS, Express 5, Baileys, Cloudflare Worker + D1, dan SQLite lokal untuk sesi WA. Semua kode aplikasi menggunakan JavaScript ES Modules.

Alur buyer: **pilih produk → varian → kuantitas → bayar QR sesuai nominal → `/done` → kirim foto bukti → admin menyetujui → CLAIM langsung ke WA admin → barang diserahkan → admin menandai Selesai**.

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

Menu buyer/admin, detail order, pembayaran, CLAIM, dan caption foto mengikuti gaya Mazy Store: header dekoratif pendek, judul tebal, pemisah bagian, serta pilihan bernomor 01, 02, dan seterusnya. Pilihan produk memakai blok terbuka ┌ / │ / └; rincian dan petunjuk memakai teks regular. Tidak memakai monospace atau pemotongan lebar kolom. Input 1 maupun 01 memilih item yang sama. Harga, jumlah katalog dan label pilihan tetap berasal dari database. WhatsApp membungkus teks sesuai layar; ID dan link tetap utuh.

Semua pilihan memakai **1, 2, 3, ... sesuai urutan layar**, termasuk Kembali dan Beranda. Tidak ada nomor navigasi khusus 0, 00, 6/7, atau 8/9. Saat mengisi nama, harga, alasan, atau kuantitas, gunakan `/kembali`; angka adalah data, bukan navigasi. `/admin` membuka beranda admin dan `/menu` membuka katalog buyer (atau beranda jika pengirim adalah admin).

Jumlah varian hanya ditampilkan pada menu admin di samping kategori, misalnya `CHATGPT API KEY (0)`. Varian Ready dan Kosong termasuk hitungan tersebut. Buyer melihat harga varian Ready atau Belum tersedia, tanpa hitungan `(n)`. Kategori kosong pada admin menampilkan Tambah varian, Ubah nama katalog, Hapus katalog, Kembali, dan Beranda.

### Buyer dan CLAIM

| Perintah | Fungsi |
| --- | --- |
| `/menu` | Katalog produk; mengikuti kategori yang ditambahkan admin |
| `/pesanan` | Status order aktif; kirim ulang QR sebelum bayar atau link CLAIM saat Diproses |
| `/done` | Menyatakan sudah membayar; bot meminta foto bukti, belum lunas |
| `/batal` | Langsung batalkan selama pembayaran belum disetujui, termasuk setelah `/done`, saat verifikasi, atau setelah bukti ditolak; order Diproses tidak bisa dibatalkan dan harus melalui refund |
| `/chat` | Link WA pribadi admin; tidak mengaktifkan relay |
| `/kembali` | Kembali dari isian ke langkah sebelumnya |

Jumlah 1–100 per order (bisa diturunkan melalui `MAX_QUANTITY`). Satu buyer satu order aktif; tidak ada kedaluwarsa otomatis. Harga dan deskripsi disalin ke order. Setelah buyer mengisi kuantitas, order dan QR pembayaran langsung dibuat. Jika harga/deskripsi berubah dari yang terakhir ditampilkan, buyer mendapat rincian terbaru dan diminta mengisi ulang jumlah.

Setelah admin memeriksa uang masuk dan menyetujui pembayaran, status menjadi **Diproses** dan buyer menerima link pendek Worker pada bagian atas pesan. Saat diklik, Worker mengarahkan ke `wa.me` menuju `ADMIN_NUMBER` dengan pesan lengkap berikut:

```text
┏━━━━━━━━━━━━━━━━━━━┓
┃  *CLAIM PEMBELIAN*
┗━━━━━━━━━━━━━━━━━━━┛

ID: MZ-XXXXXXXXXXXXXXXX
Buyer: 628xxxxxxxxxx
Produk: GEMINI PLUS
Varian: 6 bulan
Jumlah: 1
Total: Rp35.000

────────────────────
```

Shortlink dibuat langsung di bot menggunakan HMAC-SHA256 dari API_SECRET, ID order, dan nomor admin. Tidak ada tabel shortlink, penyimpanan URL baru, layanan pemendek eksternal, atau migrasi D1. Route publik /c/... memverifikasi tanda tangan, membaca snapshot order yang sudah ada, lalu melakukan redirect 302; link hanya aktif selama status Diproses. Mengubah ID order atau nomor admin membuat tanda tangan tidak valid. Respons tidak di-cache dan tidak mengonsumsi link. Rotasi API_SECRET membatalkan link lama; /pesanan menghasilkan link baru. Deploy Worker sebelum memperbarui bot panel.

Link CLAIM tidak diberikan untuk order belum dibayar atau masih menunggu verifikasi. `/pesanan` dapat mengirim ulang link selama Diproses. Penyerahan barang, OTP, kredensial, dan bantuan dilakukan **langsung di chat pribadi buyer dengan admin**, bukan melalui bot. Setelah seluruh barang diserahkan, admin menandai pesanan Selesai di submenu order. Status Diproses tetap menahan pembelian baru sampai selesai atau refund ditutup.

`/chat` membuka pesan Hubungi Admin dengan bantuan produk & pembayaran, tautan ke ADMIN_NUMBER, dan teks otomatis "Halo admin Mazy Store, saya ingin bertanya tentang produk.". Pesan ini tersedia pada semua status order; link CLAIM tetap tersedia melalui notifikasi persetujuan dan `/pesanan`. Foto hanya diteruskan sebagai bukti pembayaran setelah `/done`; gambar bantuan dan pesan biasa tidak diteruskan. `/akhirichat` lama hanya memberi petunjuk kontak langsung. Mode chat dari sesi lama tidak mengaktifkan relay kembali.

### Admin

Ketik **`/admin` atau `/menu`** dari nomor `ADMIN_NUMBER`:

1. **Pesanan & pembayaran**: verifikasi, pesanan Diproses, pembatalan, refund, serta seluruh riwayat.
2. **Kelola katalog**: pilih Tambah katalog untuk membuat kategori produk baru, atau pilih katalog yang ada → varian → ubah nama/harga/deskripsi, Ready/Kosong, hapus permanen, atau tambah varian dengan kode otomatis.
3. **Status bot & pengiriman**: koneksi WA/D1, antrean, dan pengiriman meragukan yang dapat dikirim ulang setelah pemeriksaan.
4. **Broadcast pelanggan**: tulis pesan teks; setelah dikirim, pesan langsung masuk antrean tanpa konfirmasi tambahan. Penerima adalah pelanggan yang tercatat di D1; nomor admin dan bot dikecualikan. Tidak mengimpor riwayat chat WhatsApp lama.

5. **Autotesti saluran**: atur link saluran WhatsApp dan aktifkan/nonaktifkan posting gambar dan caption transaksi selesai.

Broadcast memakai antrean SQLite yang sama, dengan jeda minimal 5 detik antarpercobaan kirim selama bot berjalan. Pesan transaksi didahulukan. Menu broadcast menampilkan antrean, kiriman yang diterima WA (bukan dibaca), serta hasil meragukan. Sisa antrean dapat dihentikan langsung; kiriman yang sudah/sedang dikirim tidak ditarik. Antrean tersimpan saat restart. Pesan meragukan tidak otomatis dikirim ulang; periksa melalui Status bot & pengiriman. Broadcast mendukung teks maksimal 2000 karakter; gambar dan penjadwalan belum tersedia. Jeda pengiriman tidak menjamin akun bebas pembatasan WhatsApp.

### Autotesti saluran

Buka **/admin → Autotesti saluran → Atur saluran**, kirim link https://whatsapp.com/channel/..., lalu pilih **Aktifkan**. Bot menyelesaikan link menjadi ID saluran, lalu mengambil metadata akun bot melalui ID tersebut sebelum memeriksa viewer_metadata.role. Hasil metadata link tidak dipakai sebagai bukti izin karena bisa tidak menyertakan role. Nilai role dinormalisasi tanpa membedakan huruf besar/kecil; hanya ADMIN atau OWNER yang diterima. Link tidak valid, koneksi gagal, atau role tidak pasti ditolak tanpa menimpa pengaturan sebelumnya. Default Nonaktif. Pengaturan tersimpan terenkripsi pada SQLite lokal dan tetap ada setelah restart; tidak membutuhkan variabel .env atau migrasi D1 baru.

Saat order berhasil menjadi Selesai melalui shortcut /selesaikan maupun menu admin, bot langsung memposting ke saluran jika fitur Aktif. Setiap posting memakai gambar tetap assets/testimoni.png (gambar Testimoni Mazy Store) dengan rincian transaksi sebagai caption. File gambar harus ikut disertakan saat memperbarui bot panel. Caption berisi ID order, nomor buyer yang disensor, produk, varian, jumlah, total, status, dan waktu selesai WIB. Data menggunakan snapshot order, termasuk bila variannya sudah dihapus. Identitas lengkap, kredensial, OTP, deskripsi privat, dan gambar bukti tidak diposting.

Di **Pesanan & pembayaran → Semua pesanan & riwayat → Selesai → pilih ID**, ketik **/post** tanpa parameter. Command hanya menggunakan order Selesai yang sedang dibuka dan sesi admin yang belum kedaluwarsa. Posting manual boleh diulang. Saat fitur Nonaktif, posting otomatis dan manual diblokir. Tidak ada posting susulan untuk order lama saat fitur diaktifkan.

Autotesti memakai pengiriman gambar dan caption secara langsung, tanpa antrean dan tanpa retry otomatis. Untuk kompatibilitas Baileys rc14, gambar saluran diunggah mentah ke endpoint newsletter/newsletter-image, memakai media handle dan metadata gambar pada stanza newsletter. Jalur ini khusus saluran; gambar bukti dan QRIS chat pribadi tetap memakai jalur Baileys biasa. Pesan sukses hanya diberikan setelah ACK server dengan ID posting saluran diterima. ID lokal sendMessage saja tidak dianggap sukses. Penolakan server atau upload gagal ditampilkan sebagai gagal; timeout/ACK tanpa ID server ditampilkan sebagai belum pasti. Posting yang dihapus boleh diposting ulang manual dengan ID pengiriman baru. Jika file gambar tidak dapat dibaca, posting dihentikan dengan petunjuk untuk memperbarui aset; tidak mengirim posting teks terpisah. Setiap posting memeriksa ulang role bot. Jika bot bukan lagi admin, fitur dinonaktifkan. Kegagalan koneksi/pemeriksaan role tidak mengubah pengaturan. Posting gagal tetap mempertahankan order Selesai dan memberi pemberitahuan kepada admin. Pengiriman yang timeout atau hasilnya tidak pasti harus diperiksa di saluran sebelum mencoba manual agar tidak menggandakan posting. Saluran yang baru disimpan mempertahankan status Aktif/Nonaktif sebelumnya.

Nomor pilihan mengikuti layar. Semua item katalog, varian, filter status, order, dan pengiriman bermasalah ditampilkan sekaligus tanpa pagination. Pesan panjang tetap dipecah otomatis menjadi beberapa pesan WA dengan nomor pilihan yang berlanjut; gunakan daftar dari menu terbaru. Pilihan dan draft kedaluwarsa setelah 30 menit. Tindakan langsung dijalankan setelah dipilih, tanpa layar konfirmasi. Penolakan bukti, pembatalan admin, dan awal refund tetap meminta alasan; setelah alasan dikirim, tindakan langsung dijalankan. Data yang berubah sejak menu ditampilkan harus diperiksa ulang.

Jika terjadi error, `ADMIN_INTERNAL` berarti kegagalan kode menu, `API_NETWORK` berarti koneksi/timeout Worker, `API_RESPONSE` berarti respons tidak sesuai (misalnya URL salah), dan `API_HTTP` menampilkan status penolakan/gangguan Worker. Console mencatat kode, jenis error, layar, dan lokasi source tanpa isi pesan atau secret. Periksa status order sebelum mengulangi tindakan. Request baca serta pembuatan/tindakan order dengan kunci idempotensi mencoba ulang satu kali saat gangguan koneksi/5xx; perubahan katalog tidak diulang otomatis.

Shortcut admin: **reply notifikasi order, pemberitahuan /done, foto bukti, atau hasil tindakan order** dengan perintah berikut. ID diambil dari referensi pesan, tidak dari teks/nomor menu. Shortcut tidak mengubah posisi submenu atau draft admin.

| Reply dengan | Tindakan |
|---|---|
| /setujui | Setujui pembayaran yang sedang diverifikasi; kirim CLAIM |
| /selesaikan | Selesaikan hanya ID tersebut setelah status Diproses |
| /tolakbukti alasan | Minta buyer mengirim bukti ulang |
| /batal [alasan] | Batalkan order yang belum disetujui; tanpa alasan memakai catatan Dibatalkan admin. |
| /batalkan alasan | Alias pembatalan dengan alasan wajib |
| /refund alasan | Tawarkan refund untuk order Diproses, menunggu persetujuan buyer |
| /selesai | Selesaikan pesanan Diproses, atau tutup refund setelah buyer setuju dan uang dikembalikan |
| /lanjutkan | Tutup permintaan pembatalan sesuai kesepakatan |

Reply /batal diperlakukan sebagai shortcut pembatalan. /batal tanpa reply tetap kembali pada navigasi/form admin. Buyer dapat membatalkan sendiri pada status Menunggu bayar, Menunggu bukti, dan Verifikasi pembayaran; flag permintaan pembatalan lama ikut dibersihkan. Petunjuk /batal ditampilkan pada status pesanan buyer, setelah /done, setelah foto diteruskan, saat bukti ditolak, serta pada notifikasi order/foto ke admin. Pengiriman bukti ulang dan penolakan bukti membersihkan flag pembatalan lama agar pembayaran yang valid dapat disetujui. Request pembatalan dari bot versi lama pada status belum disetujui langsung membatalkan order; tidak membuat flag menunggu lagi. Order yang sudah berstatus Dibatalkan tidak dapat dihidupkan kembali dengan mengirim bukti. Order yang telah disetujui tidak bisa dibatalkan langsung dan harus melalui penanganan admin/refund.

Alur refund: admin reply `/refund alasan` → buyer menerima nominal dan alasan → buyer mengetik `/setujui` di chat bot → admin menerima notifikasi persetujuan → admin mengembalikan uang melalui chat pribadi → admin reply `/selesai` atau memilih tindakan di detail order. Sebelum buyer setuju, API dan menu menolak penyelesaian refund. Persetujuan buyer belum berarti uang dikembalikan; order tetap aktif sampai admin menutup refund. `/setujui` dari nomor admin tetap untuk verifikasi pembayaran; dari buyer hanya menyetujui penawaran refund aktif. Migrasi `0006_refund_consent.sql` menyimpan persetujuan; refund lama yang belum selesai juga menunggu persetujuan buyer lewat `/pesanan`. Setelah pembayaran disetujui, `/batal` dan request pembatalan dari bot lama ditolak tanpa mengubah order.

Periksa uang masuk sebelum /setujui. Pesan tanpa referensi order, reply ke menu, dan tindakan yang tidak sesuai status ditolak. /selesai juga tersedia sebagai alias /selesaikan. Lima order dapat diproses dengan reply ke masing-masing pesannya; tidak ada penyelesaian massal. Petunjuk /setujui dan /tolakbukti ada di bukti pembayaran. Petunjuk /selesaikan ada di pesan ADMIN | PESANAN setelah persetujuan; reply pesan hasil tersebut untuk menyelesaikan ID yang sama. Referensi lokal dapat dipakai saat pencatatan pesan ke D1 masih mengantre.

Bukti pembayaran ada pada gambar notifikasi WA, bukan arsip database. Pilihan **Hubungi buyer** menampilkan link chat langsung. Balasan teks/gambar ke notifikasi, kartu tujuan lama, atau bukti pembayaran **tidak diteruskan**; bot menampilkan kontak langsung. Submenu Percakapan buyer dihapus. Perintah pengelolaan lama seperti `/harga` memberi petunjuk menuju submenu.

Status varian adalah **Ready / Kosong**. Varian baru selalu Kosong. Lengkapi Deskripsi sebelum menandainya Ready. Hapus varian permanen langsung menghapus baris varian dari database tanpa arsip/pemulihan. Order lama menyimpan ID, nama, harga, dan deskripsi saat pembelian sehingga tetap dapat diproses sampai selesai. Field internal terms tetap digunakan untuk kompatibilitas data lama; label tampilan memakai Deskripsi.

**Menambah produk/katalog utama:** `/admin` → Kelola katalog → Tambah katalog → ketik nama. Nama maksimal 80 karakter; spasi dirapikan dan huruf disimpan kapital. Nama yang sudah ada ditolak. Setelah disimpan, kamu langsung masuk ke katalog baru dengan pilihan Tambah varian. Katalog baru otomatis muncul pada buyer sebagai Belum tersedia sampai ada varian yang dibuka. Katalog tidak lagi terbatas pada tujuh kategori awal; penambahan katalog tidak membuat atau membuka varian otomatis. `/kembali` membatalkan langkah isian tanpa menambah data.

**Ubah/hapus katalog:** pilih katalog pada Kelola katalog → Ubah nama katalog (ketik nama baru) atau Hapus katalog (langsung dihapus). Hapus menghilangkan katalog dan seluruh variannya dari admin/buyer serta menolak pembelian baru. Tidak ada menu arsip/pulihkan katalog. Pesanan yang sudah dibuat mempertahankan nama dan rincian saat pembelian serta tetap dapat diselesaikan. Nama katalog yang sudah dihapus boleh dipakai untuk katalog baru.

### Mencoba checkout melalui chat nomor bot sendiri

Buka WhatsApp akun bot → chat ke nomornya sendiri → `/menu`. Pilihan produk, kuantitas, `/done`, dan foto bukti mengikuti alur buyer biasa tanpa prefix/flag khusus. Pesan otomatis bot dikecualikan agar tidak terjadi loop; pesan `fromMe` ke orang lain tidak menjadi input buyer. Akses admin tetap dari nomor admin terpisah.

Order dan QRIS tersebut **asli**, bukan sandbox. Tidak perlu mentransfer uang untuk mencoba navigasi; persetujuan pembayaran tetap manual dan CLAIM baru dikirim setelah disetujui.

### Memperbarui instalasi yang sudah berjalan

Untuk pengelolaan katalog, terapkan migrasi sampai `0005_permanent_variant_delete.sql` lalu deploy Worker **sebelum** memperbarui bot panel. Jalankan dari laptop yang sudah login Cloudflare:

```sh
npm run db:remote
npm run worker:deploy
```

Migrasi mempertahankan katalog, varian, ID, dan transaksi lama; tidak menjalankan ulang seed katalog. Jangan mengganti secret, menjalankan setup ulang, atau menghapus sesi WA. Pembuatan katalog memakai kunci permintaan agar percobaan ulang tidak menambahkan katalog ganda.

Setelah perubahan source di-commit/push, ambil kode di panel dengan `git pull`, hentikan proses bot lama, lalu jalankan ulang memakai **Node.js 26**. Periksa `/admin` dari WA admin dan `/menu` dari sisi buyer. Kode bot panel tidak diperbarui otomatis oleh deploy Worker.

Saat startup pertama versi ini, antrean relay lama dinonaktifkan dan cache retry pesan lama dibersihkan. Auth WA, order, serta referensi pesan dipertahankan. Konfigurasi `worker/wrangler.local.jsonc` tetap lokal/diabaikan Git; `worker/wrangler.jsonc` tetap template tanpa ID database.

## 5. Pemulihan dan backup

- Teks transaksi/notifikasi keluar disimpan terenkripsi maksimal 24 jam untuk antrean/retry. Tidak ada relay chat atau OTP. Konten tidak ditulis ke log. Referensi transaksi/pesan tanpa isi tersimpan di D1.
- Pengiriman WA dan penyimpanan referensi D1 diproses terpisah memakai antrean SQLite yang sama. Jika pemetaan D1 macet/gagal, pesan berikutnya tetap dikirim. Referensi dicoba lagi tanpa mengirim ulang pesan yang sudah terkirim; gambar yang sudah dikirim hanya menyisakan metadata di antrean, bukan salinan file.
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

### Gudang stok dan Auto Delivery

Semua varian dan order lama tetap **Manual**. Buka `/admin → Kelola katalog → kategori → varian → Ubah ke Otomatis` untuk mengaktifkan gudang varian tersebut. Mode Manual memakai Ready/Kosong dan CLAIM ke admin; mode Otomatis memakai jumlah stok tersedia. Mengubah mode hanya berlaku untuk order baru.

Pada varian Otomatis, gunakan **Tambah stok satuan**, **Tambah stok batch**, atau **Lihat stok tersedia**. Batch dapat dikirim sebagai pesan atau file `.txt` UTF-8 maksimal 256 KiB. Pisahkan unit dengan baris `---`; maksimal 100 unit per batch dan 2.000 karakter per unit. Contoh:

```text
Email: akun1@example.com
Password: password1
---
Kode aktivasi: ABCD-1234
Petunjuk: redeem di halaman aktivasi.
```

Satu blok adalah satu paket barang. Batch diperiksa dan disimpan seluruhnya atau ditolak seluruhnya. Event WA yang sama tidak menggandakan impor; pesan/file baru dianggap batch baru. Stok **Tersedia** dapat diedit atau dihapus permanen; stok yang sudah **Dipesan/Terjual** tidak dapat diubah. Edit yang bersamaan dengan checkout ditolak. Tidak ada konfirmasi tambahan; `/kembali` membatalkan form.

Checkout mengunci stok secara atomik sesuai kuantitas sebelum QRIS dikirim. Pembatalan sebelum pembayaran disetujui melepaskan stok; penolakan bukti mempertahankan stok selama order aktif. Tidak ada kedaluwarsa order otomatis. Katalog/varian dengan order otomatis aktif belum bisa dihapus.

Sesudah admin `/setujui` pembayaran, bot mengirim satu pesan barang per unit stok kepada buyer. ID pesan dan isi terenkripsi disimpan sebelum pengiriman. Order otomatis menjadi **Selesai** setelah semua unit berhasil dikirim melalui Baileys dan masing-masing tercatat `sent` pada D1, tanpa menunggu delivery/read receipt perangkat buyer. Kiriman yang gagal atau hasilnya meragukan tetap Diproses. Selanjutnya status menjadi **Selesai**, stok Terjual, dan autotesti berjalan sekali jika aktif. Order Otomatis tidak mengirim CLAIM. Isi stok tidak masuk autotesti atau log.

Restart tidak mengalokasikan ulang atau mengulang kiriman yang mungkin sudah sampai. Hasil kiriman meragukan diberitahukan ke admin dan tidak dapat diulang dari menu antrean umum. Periksa chat buyer; admin dapat `/selesai` sesudah memastikan penyerahan. Refund tetap membutuhkan persetujuan buyer dan menghentikan bagian yang belum mulai dikirim. Setelah refund selesai, stok kembali tersedia hanya jika seluruh pengiriman belum pernah dimulai; barang yang mungkin terkirim tidak dijual ulang otomatis.

Migrasi `0007_inventory.sql` menambah stok, alokasi, mode snapshot order, dan catatan pengiriman. Isi stok dienkripsi oleh bot menggunakan **DATA_KEY yang sama** sebelum disimpan di D1. Cadangkan DATA_KEY secara terpisah bersama backup D1; kehilangan/mengganti kunci membuat stok lama tidak dapat dibaca. Tidak ada `.env`, dependency, atau layanan tambahan. Deploy: `npm run db:remote`, `npm run worker:deploy`, lalu perbarui/restart bot panel. Uji dengan stok dummy terlebih dahulu untuk memastikan barang terkirim, status otomatis Selesai, dan autotesti berjalan.

```sh
npm run check
npm test
```

Tes mencakup Worker nyata dalam simulator D1, checkout kuantitas, idempotensi, persaingan satu order aktif, snapshot harga, pembayaran, refund/pembatalan, CLAIM, pencegahan relay, penomoran dinamis, format bold/regular dan Unicode, QRIS encode/decode, auth SQLite, retry, TTL, batas media, serta Express.

Sebelum membuka toko: scan QR hasil dengan dua aplikasi pembayaran dan pastikan merchant/nominal benar, lakukan pilot dua buyer bersamaan, verifikasi bukti di WA admin, uji link CLAIM dan chat langsung ke admin, restart panel, dan pastikan sesi tetap ada. Pairing WA, uji pembayaran nyata, serta kapasitas hosting memerlukan lingkungan/akun milik toko dan belum digantikan tes lokal.

## Uji navigasi memakai polling

Dari nomor admin, kirim `/tespoll` untuk polling dua opsi dengan `selectableCount: 1` (satu jawaban). `/tespoll 255`, `/tespoll 256`, atau `/tespoll 300` menguji panjang pertanyaan; batas percobaan 1.000 karakter. Baileys terpasang tidak memvalidasi batas 255 pada judul, tetapi penerimaan dan tampilan WhatsApp harus diuji langsung. Ini bukan jaminan judul panjang didukung.

Setelah satu opsi dipilih, bot mendekripsi vote langsung, memeriksa pemilik polling, memproses sekali, meminta penghapusan pesan polling untuk semua pihak, lalu mengirim hasil pilihan. Tidak menghapus seluruh percakapan dan tidak mengubah order atau menu toko. Polling uji kedaluwarsa 24 jam. Kunci polling disimpan terenkripsi secara lokal agar vote tetap dapat diproses setelah restart; jangan mengandalkan event `pollUpdates` otomatis karena jalurnya dinonaktifkan pada versi Baileys ini. Tidak memerlukan migrasi D1, deploy Worker, atau dependency baru.

`/tespoll` sekarang membuka katalog utama buyer (termasuk jika dijalankan admin), lalu mengirim polling pilihan kategori/Pesanan saya/Hubungi admin. Vote membuka submenu melalui handler buyer yang sama seperti input angka. Pilihan menu yang sudah berubah ditolak dan diminta membuka polling baru. Pemeriksaan PN/LID dan event vote tipe append turut didukung. `/tespoll 255` dan variasi panjang tetap hanya menguji judul dengan dua opsi dummy.
