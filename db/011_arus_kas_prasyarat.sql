-- ============================================================
-- 011 - Prasyarat laporan arus kas
--
-- Laporan arus kasnya sendiri BELUM dibangun. Yang dikerjakan di sini
-- adalah tiga hal yang tanpanya laporan itu hanya bisa ditebak-tebak:
-- penanda akun kas, klasifikasi arus kas, dan PPN Masukan yang selama
-- ini tidak pernah terisi.
--
-- ------------------------------------------------------------
-- KENAPA KLASIFIKASI ADA DI AKUN LAWAN, BUKAN DI AKUN KAS
-- ------------------------------------------------------------
-- Golongan arus kas tidak melekat pada akun kasnya. Kas yang keluar
-- untuk membeli mesin dan kas yang keluar untuk membayar pemasok
-- keluar dari akun yang SAMA; yang membedakan keduanya adalah apa yang
-- dipertukarkan dengan kas itu.
--
-- Karena setiap mutasi kas selalu berpasangan dalam satu jurnal,
-- golongannya bisa dibaca dari baris LAWAN di jurnal yang sama. Itu
-- sebabnya kategori_arus_kas diisi untuk akun NON-kas, dan dibiarkan
-- NULL pada akun kas itu sendiri.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Penanda akun kas
-- ------------------------------------------------------------
--
-- Kolom, bukan pencocokan nama. "Kas & Bank" bisa dikenali dari
-- namanya hari ini dan gagal besok begitu ada "BCA Operasional" dan
-- "Mandiri Payroll" — dan kegagalannya diam: rekening kedua hilang dari
-- laporan arus kas tanpa satu pun tanda.
ALTER TABLE account ADD COLUMN is_cash_equivalent boolean NOT NULL DEFAULT false;

UPDATE account SET is_cash_equivalent = true WHERE code = '1-1100';

CREATE INDEX idx_account_cash ON account(is_cash_equivalent)
    WHERE is_cash_equivalent;

-- ------------------------------------------------------------
-- 2. Klasifikasi arus kas
-- ------------------------------------------------------------
CREATE TYPE cash_flow_category AS ENUM ('OPERASI', 'INVESTASI', 'PENDANAAN');

ALTER TABLE account ADD COLUMN kategori_arus_kas cash_flow_category;

UPDATE account SET kategori_arus_kas = 'OPERASI' WHERE code IN (
    '1-1200',  -- Piutang Usaha
    '1-1300',  -- Persediaan Barang Dagang
    '1-1400',  -- PPN Masukan
    '2-1100',  -- Utang Usaha
    '2-1200',  -- PPN Keluaran
    '2-1300',  -- Barang Diterima Belum Ditagih
    '2-1400',  -- Titipan Pelanggan
    '4-1100',  -- Penjualan
    '5-1100',  -- Harga Pokok Penjualan
    '5-2100',  -- Kerugian Penyusutan Stok
    '5-3100'   -- Selisih Harga Pembelian
);

UPDATE account SET kategori_arus_kas = 'PENDANAAN' WHERE code = '3-1100';  -- Modal

-- INVESTASI belum punya akun sama sekali: aset tetap belum ada di bagan
-- akun ini. Kolomnya sudah siap, nilainya menunggu akunnya dibuat.

-- ------------------------------------------------------------
-- 3. Akun baru tidak boleh diam-diam hilang dari laporan
-- ------------------------------------------------------------
--
-- Tanpa constraint ini, seseorang yang menambah akun beban tahun depan
-- akan membuat akun itu lenyap dari laporan arus kas tanpa tanda apa
-- pun. Kegagalan yang diam seperti itu justru yang paling mahal:
-- laporannya tetap tercetak, tetap terlihat masuk akal, dan tetap salah.
--
-- Akun HEADER dikecualikan karena tidak pernah dijurnal, dan akun KAS
-- dikecualikan karena golongannya memang bukan miliknya.
ALTER TABLE account ADD CONSTRAINT chk_kategori_arus_kas
    CHECK (
        NOT is_postable
        OR is_cash_equivalent
        OR kategori_arus_kas IS NOT NULL
    );

-- Akun kas tidak boleh punya kategori: kalau terisi, ia akan terbaca
-- sebagai lawan dari dirinya sendiri.
ALTER TABLE account ADD CONSTRAINT chk_kas_tanpa_kategori
    CHECK (NOT is_cash_equivalent OR kategori_arus_kas IS NULL);

-- ------------------------------------------------------------
-- 4. PPN Masukan
-- ------------------------------------------------------------
INSERT INTO account_mapping (key, account_id)
SELECT 'VAT_IN', id FROM account WHERE code = '1-1400';

-- Pemasok Pengusaha Kena Pajak menerbitkan faktur ber-PPN yang bisa
-- dikreditkan. Yang bukan PKP tidak.
ALTER TABLE partner ADD COLUMN is_pkp boolean NOT NULL DEFAULT false;

/*
 * Tarif disimpan PER DOKUMEN, bukan diambil dari konfigurasi saat
 * laporan dibuat.
 *
 * Tarif PPN berubah (10% menjadi 11% pada 2022, dan akan berubah lagi).
 * Faktur lama harus tetap menampilkan tarif yang berlaku saat itu —
 * kalau tarifnya dibaca dari satu tempat terpusat, mencetak ulang
 * faktur dua tahun lalu akan menghasilkan angka yang berbeda dari yang
 * pernah dikirim ke pemasok.
 *
 * Bawaannya nol supaya dokumen yang dibuat langsung lewat SQL — migrasi
 * dan rangkaian tes — berperilaku persis seperti sebelum berkas ini ada.
 */
ALTER TABLE purchase_invoice
    ADD COLUMN tax_rate   numeric(6,4) NOT NULL DEFAULT 0
        CHECK (tax_rate >= 0 AND tax_rate <= 1),
    ADD COLUMN tax_amount numeric(18,2) NOT NULL DEFAULT 0
        CHECK (tax_amount >= 0),
    ADD COLUMN total      numeric(18,2) NOT NULL DEFAULT 0;

-- Dokumen yang sudah ada dibuat sebelum PPN dikenal: totalnya sama
-- dengan subtotalnya.
UPDATE purchase_invoice SET total = subtotal WHERE total = 0 AND subtotal <> 0;

-- ------------------------------------------------------------
-- 5. Pandangan pendukung
-- ------------------------------------------------------------
--
-- Setiap baris jurnal yang menyentuh kas, beserta golongan yang dibaca
-- dari baris LAWAN di jurnal yang sama. Laporan arus kas nanti dibangun
-- di atas ini; disiapkan sekarang supaya klasifikasinya bisa diuji
-- sebelum laporannya ada.
CREATE VIEW v_mutasi_kas AS
WITH kas AS (
    SELECT l.entry_id, l.id AS line_id,
           (l.debit - l.credit) AS arus        -- positif = kas masuk
      FROM journal_line l
      JOIN account a ON a.id = l.account_id
     WHERE a.is_cash_equivalent
),
lawan AS (
    SELECT l.entry_id,
           a.kategori_arus_kas,
           SUM(ABS(l.debit - l.credit)) AS bobot
      FROM journal_line l
      JOIN account a ON a.id = l.account_id
     WHERE NOT a.is_cash_equivalent
     GROUP BY l.entry_id, a.kategori_arus_kas
)
SELECT e.id            AS entry_id,
       e.entry_no,
       e.entry_date,
       e.source_type,
       e.source_id,
       k.arus,
       lw.kategori_arus_kas,
       lw.bobot
  FROM kas k
  JOIN journal_entry e ON e.id = k.entry_id AND e.is_posted
  LEFT JOIN lawan lw ON lw.entry_id = k.entry_id;

GRANT SELECT ON v_mutasi_kas TO tera_readonly;
