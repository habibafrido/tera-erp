# Tera ERP

ERP distributor dengan buku besar stok append-only dan jurnal berpasangan.
Dibuat untuk dijalankan di komputer sendiri.

## Menjalankan

PostgreSQL tidak perlu dipasang sendiri. Binary-nya ikut terunduh lewat
`npm install`, dan clusternya dibuat di `.pgdata/` pada port 54329.

```bash
cp .env.example .env.local     # sekali saja
npm install
npm run db:migrate             # menyalakan Postgres + membuat skema
npm run db:seed                # data contoh: gudang, mitra, barang
npm run dev                    # http://localhost:3000
```

Perintah lain:

```bash
npm run db:verify              # menjalankan "Alur mencoba" di bawah + memeriksa hasilnya
npm run db:demo                # data contoh berisi transaksi (penerimaan, penjualan, batch)
npm run db:stop                # mematikan Postgres
npm run db:reset               # menghapus .pgdata, mulai dari nol

npm run test:search            # palet pencarian: penjaga hasil basi + kontrak route
npm run test:ai                # role baca-saja ditolak menulis + semua alat chat
npm run test:chat              # perilaku chat; butuh OPENROUTER_API_KEY dan server jalan
```

`db:verify` membuat database sementara sendiri, memigrasi dan men-seednya di
sana, lalu menghapusnya lagi di akhir — termasuk kalau ujinya gagal. Database
kerja tidak ikut tersentuh, jadi perintah ini aman dijalankan kapan saja.

Kalau ingin memakai PostgreSQL 15+ milik sendiri, isi `DATABASE_URL` di
`.env.local` dan set `PG_EMBEDDED=0`. Skrip tidak akan menyalakan apa pun.

## Alur mencoba

1. **Barang** dan **Mitra** sudah terisi kalau seed dijalankan.
2. **Penerimaan barang** — catat 100 pcs dengan harga 14.000. Stok bertambah,
   jurnal `Dr Persediaan / Cr Barang Diterima Belum Ditagih` muncul otomatis.
3. Catat penerimaan kedua untuk barang sama dengan harga 16.000. Lihat halaman
   **Saldo stok**: biaya rata-rata sekarang di antara kedua harga tersebut.
4. **Penjualan** — jual 50 pcs. Harga pokok memakai rata-rata bergerak, bukan
   harga beli terakhir. Cek margin di daftar penjualan dan jurnalnya.
5. Coba jual melebihi stok. Posting ditolak dan tidak ada apa pun yang tercatat.

## Pelunasan piutang dan faktur pembelian

Dua dokumen yang menutup lingkaran: tanpa keduanya, piutang hanya bisa
bertambah dan akun Barang Diterima Belum Ditagih menumpuk selamanya.

**Penerimaan pembayaran** (`/payments`) — `Dr Kas/Bank, Cr Piutang Usaha`.
Satu pembayaran boleh dibagi ke beberapa faktur, satu faktur boleh dicicil
beberapa kali. Kelebihan bayar masuk akun **Titipan Pelanggan** — kewajiban,
bukan pendapatan: uang yang belum punya tagihan sewaktu-waktu bisa diminta
kembali.

**Faktur pembelian** (`/purchases`) — `Dr Barang Diterima Belum Ditagih,
Cr Utang Usaha`. Inilah dokumen yang mengosongkan akun perantara itu.

Yang paling menentukan di keduanya: **tidak ada kolom saldo yang disimpan.**
Sisa tagihan dihitung lewat `v_invoice_outstanding`, dan sisa yang belum
difakturkan lewat `v_receipt_matching`. Alasannya sama persis dengan tidak
adanya kolom saldo stok di tabel `product` — salinan akan menyimpang.
Keduanya dihitung ulang **di dalam transaksi, setelah `pg_advisory_xact_lock`
diambil**, karena dua pembayaran bersamaan ke faktur yang sama akan
sama-sama membaca sisa yang sudah basi lalu sama-sama lolos.

### Selisih harga pembelian

Kalau harga di faktur berbeda dari harga saat barang diterima, selisihnya
masuk akun **5-3100 Selisih Harga Pembelian**. Nilai persediaan dan
rata-rata bergerak **tidak diubah**.

Ini keputusan akuntansi, bukan teknis. Sebagian barang dari penerimaan itu
biasanya sudah terjual, dan harga pokoknya sudah masuk laba rugi memakai
rata-rata bergerak saat itu. Rata-rata bergerak sengaja tidak menyimpan
lapisan, jadi tidak ada cara mengetahui unit mana yang masih di gudang
berasal dari penerimaan yang mana — pembagian selisih antara persediaan dan
HPP hanya bisa ditaksir.

Harganya: persediaan dinilai pada harga penerimaan, bukan harga beli
sebenarnya, dan laba periode faktur menyerap seluruh selisih. Itu kesalahan
yang **terlihat** — satu akun yang bisa dibaca langsung di Laba Rugi — dan
kesalahan yang terlihat lebih berguna daripada angka yang lebih halus tapi
tidak bisa ditelusuri.

**Selisih kuantitas** diperlakukan berbeda: ia **menahan posting**. Ditagih
untuk barang yang tidak pernah diterima adalah sengketa, bukan pembulatan,
jadi ia butuh persetujuan yang tercatat siapa dan kapan — bukan peringatan
yang bisa diabaikan.

Nomor pembayaran, nomor faktur pembelian, dan nomor faktur pemasok ikut
terindeks palet pencarian (Ctrl/Cmd+K) lewat migrasi 007.

`npm run db:verify`, `test:pelunasan`, dan `test:pembelian` menguji bahwa
total alokasi per faktur tidak pernah melebihi nilainya, dan bahwa saldo
Barang Diterima Belum Ditagih **tepat** nol setelah semua penerimaan
difakturkan.

## Pembayaran ke pemasok dan prasyarat arus kas

### Pembayaran ke pemasok

`/supplier-payments` — `Dr Utang Usaha, Cr Kas/Bank`. Sisi yang melengkapi
utang usaha: sebelum ini Utang Usaha hanya bisa bertambah, dan laporan arus
kas hanya akan berisi kas **masuk** — perusahaan yang laporannya hanya
menampilkan penerimaan selalu terlihat sehat.

Pola dan jaminannya sama dengan penerimaan pembayaran pelanggan: tidak ada
kolom sisa utang tersimpan (`v_purchase_outstanding` menghitungnya),
`pg_advisory_xact_lock` per faktur dengan awalan ruang kunci `AP:`, dan
alokasi melebihi sisa ditolak di tingkat posting plus constraint trigger.

Satu perbedaan yang penting: kelebihan bayar masuk **Uang Muka Pembelian**
(`1-1500`), yang berjenis **ASET** — bukan cerminan langsung dari Titipan
Pelanggan yang berjenis liabilitas. Uang yang sudah keluar tapi belum punya
faktur adalah hak tagih kepada pemasok, bukan beban.

### PPN Masukan

Faktur pembelian dari pemasok PKP kini membawa PPN yang bisa dikreditkan:

```
Dr Barang Diterima Belum Ditagih   senilai penerimaan
Dr Selisih Harga Pembelian         nilai faktur − penerimaan
Dr PPN Masukan                     nilai faktur × tarif
Cr Utang Usaha                     nilai faktur × (1 + tarif)
```

Tarif ditentukan **di server** dari `partner.is_pkp` dan disimpan **di
dokumen** (`purchase_invoice.tax_rate`). Keduanya disengaja: kalau klien yang
menentukan, satu permintaan buatan tangan bisa mengkreditkan pajak atas
faktur dari pemasok yang tidak pernah memungutnya; dan kalau tarif dibaca
dari satu tempat terpusat, mencetak ulang faktur dua tahun lalu akan
menghasilkan angka yang berbeda dari yang pernah dikirim.

Dasar pengenaannya nilai **faktur**, bukan nilai GRNI yang dilepas — pemasok
menagih PPN atas apa yang ia tagihkan.

### Prasyarat laporan arus kas

Laporannya sendiri **belum dibangun**; ini fondasinya.

**Akun kas dikenali dari kolom** `account.is_cash_equivalent`, tidak pernah
dari namanya. Pencocokan nama bekerja hari ini dan gagal besok begitu ada
"BCA Operasional" dan "Mandiri Payroll" — dan gagalnya diam.

**Klasifikasi ada di akun lawan**, lewat `account.kategori_arus_kas`
(`OPERASI | INVESTASI | PENDANAAN`). Golongan tidak melekat pada akun kas:
kas untuk beli mesin dan kas untuk bayar pemasok keluar dari akun yang sama;
yang membedakan adalah apa yang dipertukarkan dengannya. Karena setiap mutasi
kas berpasangan dalam satu jurnal, golongannya dibaca dari baris lawan —
lihat view `v_mutasi_kas`.

Dua constraint menjaganya: akun postable non-kas **wajib** punya kategori
(tanpa ini akun baru diam-diam hilang dari laporan), dan akun kas **tidak
boleh** punya kategori (ia akan terbaca sebagai lawan dari dirinya sendiri).

INVESTASI masih kosong: akun aset tetap belum ada di bagan akun. Kolomnya
sudah siap.

## Pembatalan dokumen dan tutup buku

### Pembatalan lewat jurnal pembalik

`stock_ledger` append-only dan jurnal terposting tidak bisa disunting, jadi
pembatalan bukan penghapusan melainkan **penambahan**: satu jurnal baru
dengan debit dan kredit ditukar, satu set baris ledger dengan kuantitas
dinegasikan, dan status dokumen menjadi `CANCELLED`. Dokumen aslinya tetap
ada — laporan yang pernah dicetak tetap bisa dijelaskan.

**Tanggal pembalik adalah parameter, bukan tanggal dokumen aslinya.** Itu
inti dari seluruh mekanisme: koreksi atas dokumen di periode tertutup
dicatat di periode yang masih terbuka.

Yang ditolak: pembatalan ganda, alasan di bawah lima huruf, tanggal pembalik
yang mendahului dokumennya, dan pembalikan yang akan membuat stok negatif.

### Tutup buku

Periode `DITUTUP` menolak posting bertanggal di dalamnya — **ditegakkan
trigger**, pada `journal_entry` (INSERT dan perubahan `entry_date`) dan pada
`stock_ledger`. Pemeriksaan di aplikasi hanya untuk pesan yang ramah;
pemeriksaan di lapisan itu bisa dilewati skrip, psql, dan jalur kode kedua
yang lupa memanggilnya.

Ledger memakai **tanggal jurnalnya**, bukan `posted_at`. Dokumen bertanggal
mundur punya `posted_at` hari ini; kalau periode dinilai dari situ, stok dan
jurnal dari dokumen yang sama bisa jatuh di dua periode berbeda.

Lima syarat sebelum menutup, masing-masing dengan daftar masalah **dan
tindakan**, bukan sekadar penolakan:

| Syarat | Kenapa |
|---|---|
| Periode sebelumnya sudah ditutup | Selama Februari terbuka, saldo awal Maret masih bisa berubah |
| Rekonsiliasi persediaan seimbang | Buku besar stok versus saldo akun 1-1300 per akhir periode |
| Tidak ada jurnal timpang | Seharusnya mustahil; kemunculannya berarti ada tulisan di luar aplikasi |
| Neraca seimbang di akhir periode | Menutup dengan neraca timpang membekukan selisihnya |
| Tidak ada dokumen draf | Draf yang tertinggal tidak akan pernah bisa diposting pada tanggalnya |

Rekonsiliasi memakai `SUM(qty * unit_cost)`, **bukan** `running_value`.
Snapshot `running_value` berurutan penyisipan (`id`), sedangkan filter
periode memakai tanggal akuntansi — dan jurnal pembalik bertanggal hari ini
atas dokumen bulan lalu membuat keduanya berpisah.

### Koreksi setelah penutupan

Bukan dengan membuka kembali. Tombol **Batalkan** pada dokumennya, dengan
tanggal pembalik di bulan yang masih terbuka. Laporan periode lama tetap
persis seperti saat dicetak, dan koreksinya muncul di bulan tempat ia
benar-benar diketahui.

**Membuka kembali** hanya untuk pengawas, wajib beralasan minimal sepuluh
huruf, tercatat di `audit_log` dan di `accounting_period_log` yang
append-only. Periode yang pernah dibuka kembali ditandai **permanen** lewat
`jumlah_dibuka_kembali`, yang tidak pernah turun meski periodenya ditutup
lagi — dan itu justru yang dicari auditor.

## Autentikasi, hak akses, dan jejak audit

Buku besar bisa memberi tahu APA yang terjadi. Tanpa autentikasi ia tidak
bisa memberi tahu SIAPA — lubang yang aneh untuk sistem yang seluruh
rancangannya berdiri di atas catatan yang tidak boleh dibantah.

Masuk lewat `/masuk`. Seed membuat tiga akun contoh, satu per peran,
dengan kata sandi `tera12345` (ubah lewat `TERA_SEED_PASSWORD`):

| Email | Peran | Boleh |
|---|---|---|
| `gudang@tera.local` | Operator gudang | penerimaan barang, data gudang |
| `keuangan@tera.local` | Staf keuangan | faktur, pembayaran, barang, mitra |
| `pengawas@tera.local` | Pengawas | semuanya, plus menyetujui selisih kuantitas |

Kata sandi di-hash **argon2id**, bukan SHA: SHA dirancang untuk cepat, dan
cepat adalah sifat yang salah untuk kata sandi. Token sesi justru di-hash
SHA-256 — 256 bit dari CSPRNG tidak punya apa pun untuk ditebak, dan ia
diperiksa pada setiap permintaan. Yang disimpan di database adalah sidik
tokennya, bukan tokennya.

### Penegakan di tiga lapis

| Lapis | Yang bisa diperiksanya |
|---|---|
| `middleware.ts` | ADA atau TIDAKNYA cookie. Tidak lebih — runtime Edge tidak bisa menyentuh Postgres |
| `app/(terlindungi)/layout.tsx` | sesi sungguhan ke database, sebelum halaman apa pun dirender |
| `denganPeran()` di setiap server action | sesi DAN peran, di baris pertama setiap aksi |

Lapis ketiga yang paling penting, dan alasannya sering disalahpahami:
**server action adalah endpoint HTTP tersendiri.** Klien memanggilnya lewat
POST dengan header `Next-Action`, tanpa pernah menavigasi ke halaman mana
pun — jadi middleware yang memeriksa "halaman apa yang dibuka" bisa
dilewati sepenuhnya oleh cookie palsu. `npm run test:auth` membuktikannya
dengan memanggil server action langsung, bukan lewat halaman.

### Jejak audit

`audit_log` append-only, dijaga trigger yang menolak UPDATE, DELETE, dan
TRUNCATE — sama seperti `stock_ledger`. Setiap baris mencatat siapa, kapan,
aksi apa, dokumen apa, dari alamat IP mana.

**Upaya yang DITOLAK ikut dicatat.** Seratus penolakan berturut-turut dari
satu akun adalah satu-satunya hal yang membedakan orang yang salah klik dari
orang yang sedang mencoba-coba, dan log yang hanya memuat keberhasilan tidak
pernah bisa menunjukkan itu.

Email dan peran **disalin** ke setiap baris, tidak sekadar ditunjuk lewat
`user_id`: jejak enam bulan lalu harus menampilkan peran yang dipakai orang
itu SAAT ITU, bukan peran yang ia miliki hari ini.

Setiap dokumen punya `created_by` NOT NULL. Jurnal mewarisi atribusi dari
dokumen sumbernya lewat trigger, sehingga `lib/posting.ts` tidak perlu tahu
apa pun tentang pengguna.

### Jalur skrip

Skrip memanggil server action di luar permintaan HTTP, dan jalurnya menuntut
dua syarat yang tidak bisa dipenuhi bersamaan oleh sebuah request: tidak ada
konteks permintaan sama sekali, DAN penanda `TERA_SKRIP` yang hanya disetel
berkas skrip itu sendiri. Rangkaian tes yang memakai HTTP (`test:export`,
`test:search`, `test:chat`, `test:auth`) justru **benar-benar masuk** lewat
kata sandi, bukan melewati pemeriksaan.

Role database `tera_readonly` untuk asisten tidak berubah, dan sekarang
secara eksplisit **dicabut** aksesnya ke `app_user` dan `user_session`.

## Laporan keuangan

**Neraca** (`/laporan/neraca`), **Laba Rugi** (`/laporan/laba-rugi`), dan
**Arus Kas** (`/laporan/arus-kas`) dibangun langsung dari `journal_entry` dan
`journal_line`, tanpa tabel saldo perantara. Ketiganya bisa diunduh sebagai
Excel; subtotalnya berupa formula, bukan angka mati.

### Arus Kas — metode langsung

Golongan setiap mutasi kas dibaca dari akun **lawan** di jurnal yang sama,
bukan dari akun kasnya: kas untuk membeli mesin dan kas untuk membayar
pemasok keluar dari akun yang sama, dan yang membedakan adalah apa yang
dipertukarkan dengannya.

Pembagian jurnal multi-lawan memakai **nilai baris bertanda**, bukan taksiran
proporsional. Karena setiap jurnal seimbang:

```
Σ semua (debit − credit) = 0
Σ kas (debit − credit) + Σ lawan (debit − credit) = 0
Σ lawan −(debit − credit) = Σ kas (debit − credit)
```

Jumlah kontribusi seluruh baris lawan **selalu** sama persis dengan
pergerakan kas jurnal itu, sehingga tidak ada nilai yang bisa hilang dan
tidak ada sisa pembulatan yang perlu dilemparkan ke golongan "lain-lain".

**Transfer antar rekening kas tersaring dengan sendirinya.** Jurnalnya tidak
punya baris lawan non-kas sama sekali, jadi ia tidak menyumbang ke golongan
mana pun — bukan lewat aturan pengecualian tambahan yang bisa lupa
diterapkan. Transfer yang membawa biaya administrasi tetap muncul, sebesar
biayanya saja, karena hanya itu yang benar-benar meninggalkan kas.

Asersi mengikat di `db:verify`, **tepat nol tanpa toleransi**:

```
saldo kas awal + seluruh golongan = saldo kas akhir
```

Saldo awal dan akhir diambil dari `journal_line` pada akun
ber-`is_cash_equivalent` **langsung**, bukan dari penjumlahan laporannya
sendiri — kalau keduanya dari sumber yang sama, asersinya hanya membuktikan
bahwa penjumlahan bekerja. Diuji pada lima rentang, termasuk periode yang
sama sekali tidak punya mutasi kas.


**Neraca** (`/laporan/neraca`) dan **Laba Rugi** (`/laporan/laba-rugi`) dibangun
langsung dari `journal_entry` dan `journal_line`, tanpa tabel saldo perantara.
Keduanya bisa diunduh sebagai Excel; subtotalnya berupa formula, bukan angka mati.

Tiga hal yang membedakannya dari laporan ala kadarnya:

- **Hierarki sedalam apa pun.** Rollup akun memakai recursive CTE atas
  `account.parent_id`, jadi akun header menampilkan subtotal seluruh
  turunannya — anak, cucu, cicit. Bagan akun bawaan masih datar, tapi
  laporannya sudah siap begitu kolom `parent_id` mulai dipakai.
- **Saldo berlawanan ditandai, bukan disembunyikan.** Akun aset yang bersaldo
  kredit tampil negatif dengan penanda, karena itu gejala yang perlu dilihat,
  bukan angka yang perlu dirapikan dengan nilai mutlak.
- **Laba masuk ke ekuitas sebagai barisnya sendiri.** Laba periode berjalan
  (sejak awal tahun buku) dan laba ditahan (periode sebelumnya, selama belum
  ada jurnal penutup) masing-masing punya baris. Tanpa keduanya neraca tidak
  akan pernah seimbang.

`npm run db:verify` dan `npm run test:laporan` menguji identitas
`Aset − (Liabilitas + Ekuitas + Laba ditahan + Laba berjalan) = 0` pada beberapa
tanggal, dan hasilnya harus **tepat** nol — dibandingkan sebagai numeric
Postgres, bukan dengan toleransi.

**Arus Kas belum ada, dan sengaja tidak ditebak.** Bagan akun belum punya
klasifikasi operasi/investasi/pendanaan, belum punya penanda akun kas, dan belum
ada dokumen pembayaran sama sekali. Alasannya diuraikan di bagian bawah halaman
Laba Rugi.

## Aturan yang dijaga basis data

| Aturan | Cara dijaga |
|---|---|
| Debit harus sama dengan kredit | Constraint trigger `DEFERRABLE` saat COMMIT |
| Jurnal terposting tidak bisa diubah | Trigger `block_posted_journal` |
| Buku besar stok tidak bisa diubah | Trigger `block_ledger_mutation` |
| Stok dan jurnal harus jadi bersamaan | Satu transaksi di `lib/posting.ts` |
| Rata-rata bergerak tidak balapan | `pg_advisory_xact_lock` per barang + gudang |
| Dua pembayaran tidak saling menimpa | `pg_advisory_xact_lock` per faktur |
| Dua faktur beli tidak melepas GRNI dua kali | `pg_advisory_xact_lock` per baris penerimaan |
| Alokasi tidak melebihi nilai faktur | Constraint trigger `DEFERRABLE` + penolakan di posting |
| Jejak audit tidak bisa diubah | Trigger `block_audit_mutation` (UPDATE, DELETE, TRUNCATE) |
| Setiap dokumen punya pembuat | `created_by` NOT NULL + trigger pengisi |
| Posting ke periode tertutup ditolak | Trigger pada `journal_entry` dan `stock_ledger` |
| Riwayat periode tidak bisa diubah | Trigger `block_period_log_mutation` |
| Satu jurnal hanya bisa dibalik sekali | Unique index parsial pada `reverses_entry_id` |
| Pembayaran tidak melebihi nilai faktur beli | Constraint trigger + penolakan di posting |
| Akun non-kas wajib punya golongan arus kas | `CHECK chk_kategori_arus_kas` |
| Akun kas tidak boleh punya golongan sendiri | `CHECK chk_kas_tanpa_kategori` |
| Faktur beli tidak melebihi yang diterima | Constraint trigger + penahanan posting sampai disetujui |

## Struktur

```
db/001_core.sql        master data, jurnal, buku besar stok
db/002_documents.sql   dokumen transaksi + penomoran
lib/posting.ts         mesin posting (bagian terpenting)
lib/db.ts              koneksi dan pembungkus transaksi
lib/auth/              sesi, peran, penjaga server action, jejak audit
lib/tutup-buku.ts      syarat penutupan, riwayat periode
lib/laporan-keuangan.ts  Neraca dan Laba Rugi (konvensi tanda + rollup)
lib/arus-kas.ts        Arus Kas metode langsung
lib/export/reports.ts  registry laporan yang bisa diunduh sebagai Excel
db/005_payments.sql    pelunasan piutang (+ view sisa tagihan)
db/006_purchase_invoice.sql  faktur pembelian + pencocokan tiga arah
app/                   halaman Next.js (server components + server actions)
```

## Deploy ke Vercel

Aplikasinya sendiri tidak menyentuh Postgres tertanam sama sekali —
`embedded-postgres` hanya dipakai oleh `scripts/`, dan seluruh kode di
`app/`, `lib/`, serta `components/` cukup diberi `DATABASE_URL`. Yang
diperlukan karena itu bukan perombakan kode, melainkan satu database
terkelola.

### 1. Database

Buat proyek Postgres (panduan ini memakai Supabase, region Singapura).
Dua hal yang perlu diperhatikan:

**Jangan pakai connection string "Direct".** Host `db.<ref>.supabase.co`
hanya punya record AAAA — IPv6 saja. Dari jaringan rumah atau kantor yang
IPv4-only, ia tidak bisa dihubungi sama sekali (`ENOTFOUND`), dan add-on
IPv4 milik Supabase berbayar. Tidak perlu dibeli: kedua pooler melayani
IPv4.

| Keperluan | Endpoint | Port |
|---|---|---|
| Migrasi dan seed | Session pooler | 5432 |
| Aplikasi di Vercel | Transaction pooler | 6543 |

Username-nya **berbeda** dari yang Direct: `postgres.<project-ref>`, bukan
`postgres`.

**Sertifikat TLS.** Supabase memakai CA sendiri (Supabase Root 2021 CA)
yang tidak ada di daftar tepercaya Node, sehingga `sslmode=require` —
yang di `pg` 8.x berarti verifikasi penuh — gagal dengan
`SELF_SIGNED_CERT_IN_CHAIN`. Root CA-nya disertakan di repositori ini
(`certs/supabase-root-2021.crt`, sertifikat publik), jadi verifikasi
penuh tetap bisa dipakai alih-alih dimatikan:

```
?sslmode=verify-full&sslrootcert=certs/supabase-root-2021.crt
```

`next.config.ts` memaksa berkas itu ikut ke bundel serverless lewat
`outputFileTracingIncludes` — Next tidak bisa menebaknya sendiri karena
namanya hanya muncul di dalam sebuah connection string, bukan di `import`
mana pun.

**Zona waktu.** Seluruh tanggal di aplikasi berasal dari `CURRENT_DATE`
milik database, bukan dari jam server — itu disengaja dan diuji
`npm run audit:tanggal`. Supabase memakai UTC, yang berarti "hari ini"
berganti pukul 07.00 WIB: setiap dokumen yang dibuat antara tengah malam
dan jam tujuh pagi akan bertanggal kemarin.

```sql
ALTER DATABASE postgres SET timezone = 'Asia/Jakarta';
```

Setelan ini hanya berlaku pada koneksi backend yang BARU. Pooler menyimpan
backend lama, jadi setelah menjalankannya periksa dulu — bukan anggap
beres:

```sql
SELECT current_setting('TimeZone'), CURRENT_DATE;
```

Kalau masih UTC, tunggu backend lamanya didaur, atau paksa dengan
`SET TIME ZONE 'Asia/Jakarta'` di sesi itu.

### 2. Skema dan data awal

Dijalankan dari komputer Anda, menunjuk ke database terkelola:

```bash
# PowerShell — pakai SESSION pooler (5432)
$env:DATABASE_URL='postgresql://postgres.<ref>:<sandi>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=verify-full&sslrootcert=certs/supabase-root-2021.crt'
$env:PG_EMBEDDED='0'
npm run db:migrate

$env:TERA_SEED_PASSWORD='<kata sandi pilihan Anda>'
npm run db:seed

npm run db:amankan    # mengacak sandi role baca-saja, mencetak URL-nya
```

Migrasi memakai **session pooler** (5432), bukan transaction pooler
(6543): mode transaksi tidak cocok untuk sebagian perintah DDL.

Kalau kata sandi database Anda memuat karakter khusus, persen-encode di
dalam URL — `*` menjadi `%2A`, `@` menjadi `%40`, dan seterusnya.

`db:seed` akan **menolak** berjalan kalau `TERA_SEED_PASSWORD` tidak
disetel dan databasenya bukan localhost. Kata sandi bawaannya tertulis
di repositori ini, jadi memakainya pada pemasangan yang bisa dijangkau
internet sama dengan tidak memasang kata sandi sama sekali.

### 3. Variabel lingkungan di Vercel

| Variabel | Isi |
|---|---|
| `DATABASE_URL` | **transaction pooler**, port 6543, dengan `sslmode=verify-full&sslrootcert=certs/supabase-root-2021.crt` |
| `READONLY_DATABASE_URL` | keluaran `npm run db:amankan`, port 6543 juga |
| `OPENROUTER_API_KEY` | kunci OpenRouter |
| `OPENROUTER_MODEL` | mis. `deepseek/deepseek-v4-flash-0731` |
| `OPENROUTER_FALLBACK_MODELS` | opsional |
| `OPENROUTER_SITE_URL` | URL produksi, untuk header ke OpenRouter |

`PG_EMBEDDED` dan `PG_PORT` tidak perlu disetel.

### 4. Yang sudah aman dengan sendirinya

- Cookie sesi memakai `Secure` otomatis karena `NODE_ENV=production`.
- `/api/masuk-uji` menolak berjalan di produksi, di baris pertamanya.
- `@node-rs/argon2` punya biner `linux-x64-gnu` di lockfile, jadi
  hashing kata sandi bekerja di Vercel tanpa penyesuaian.

### 5. Yang perlu diingat

Perintah `npm run dev` dan `npm run start` memanggil `scripts/pg.ts start`
untuk menyalakan Postgres tertanam. Vercel tidak memakai keduanya — ia
menjalankan `npm run build`, yang isinya hanya `next build`. Kalau suatu
saat Anda menjalankan `npm start` di server sendiri dengan database
terkelola, setel `PG_EMBEDDED=0` supaya bagian itu dilewati.

Rangkaian tes yang memakai HTTP (`test:auth`, `test:export`,
`test:search`, `test:chat`) menunjuk `http://localhost:3000`. Untuk
menjalankannya terhadap pemasangan Vercel, setel `TEST_BASE_URL` —
tetapi ingat bahwa `test:auth` dan `db:verify` **menulis** ke database.
Jangan diarahkan ke database produksi.

## Yang sengaja belum ada

- Akun aset tetap, sehingga golongan INVESTASI di Arus Kas masih kosong
- Arus kas metode tidak langsung (rekonsiliasi dari laba bersih)
- Pelunasan uang muka pembelian ke faktur berikutnya
- Jurnal penutup akhir tahun — sampai ada, laba tahun lalu tampil sebagai
  baris "laba ditahan" di neraca alih-alih pindah ke akun ekuitas
- Halaman kelola pengguna (akun dibuat lewat seed atau SQL)
- Pemulihan kata sandi dan wajib ganti kata sandi pertama kali
- Pembatasan laju percobaan masuk (rate limiting)
- Halaman pembaca jejak audit (datanya ada, tampilannya belum)
- Pembatalan sebagian (saat ini pembatalan selalu seluruh dokumen)
- Jurnal penyesuaian manual — koreksi hanya bisa lewat pembatalan dokumen
- Stock opname dan penyesuaian
- Konversi satuan saat input (tabel konversi sudah ada, UI belum)
- e-Faktur dan pelaporan pajak

Semuanya mengikuti pola yang sama dengan `postGoodsReceipt`: buka transaksi,
tulis ke buku besar, buat jurnal, tutup transaksi.
