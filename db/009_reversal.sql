-- ============================================================
-- 009 - Pembatalan dokumen lewat jurnal pembalik
--
-- Prasyarat untuk tutup buku. Mengunci periode tanpa mekanisme koreksi
-- berarti kesalahan di dalamnya tidak bisa diperbaiki sama sekali —
-- dan itu lebih buruk daripada tidak mengunci apa pun, karena satu
-- salah ketik akan menjadi permanen.
--
-- PRINSIPNYA: tidak ada yang dihapus, tidak ada yang diubah.
--
-- stock_ledger append-only, jurnal terposting tidak bisa disunting.
-- Pembatalan karena itu bukan penghapusan melainkan PENAMBAHAN: satu
-- jurnal yang debit-kreditnya ditukar, dan satu set baris ledger yang
-- kuantitasnya dinegasikan. Keduanya bertanggal SENDIRI, bukan
-- bertanggal dokumen aslinya — itulah yang membuat koreksi atas periode
-- tertutup tetap mungkin tanpa membuka periodenya.
--
-- Dokumen aslinya tetap ada, statusnya menjadi CANCELLED. Laporan yang
-- pernah dicetak tetap bisa dijelaskan: angkanya memang pernah begitu.
-- ============================================================

-- ------------------------------------------------------------
-- Tautan pembalikan
-- ------------------------------------------------------------
--
-- Kolom ditaruh di journal_entry, bukan di tiap tabel dokumen: setiap
-- pembatalan SELALU menghasilkan jurnal, sedangkan tidak semua dokumen
-- menyentuh stok. Satu tempat untuk seluruh jejaknya.
ALTER TABLE journal_entry
    ADD COLUMN reverses_entry_id uuid REFERENCES journal_entry(id),
    ADD COLUMN reversal_reason   text;

CREATE INDEX idx_je_reverses ON journal_entry(reverses_entry_id)
    WHERE reverses_entry_id IS NOT NULL;

-- Satu jurnal hanya boleh dibalik SEKALI. Tanpa ini, dua pembatalan
-- bersamaan atas dokumen yang sama menghasilkan dua jurnal pembalik dan
-- saldonya berbalik terlalu jauh.
CREATE UNIQUE INDEX idx_je_reverses_once ON journal_entry(reverses_entry_id)
    WHERE reverses_entry_id IS NOT NULL;

-- Alasan wajib ada kalau ini memang jurnal pembalik. Pembatalan tanpa
-- keterangan tidak bisa dijelaskan kepada siapa pun enam bulan kemudian.
ALTER TABLE journal_entry ADD CONSTRAINT chk_reversal_reason
    CHECK (reverses_entry_id IS NULL OR
           (reversal_reason IS NOT NULL AND length(btrim(reversal_reason)) >= 5));

-- ------------------------------------------------------------
-- Status pembatalan pada dokumen
-- ------------------------------------------------------------
ALTER TABLE goods_receipt    ADD COLUMN cancelled_at timestamptz,
                             ADD COLUMN cancelled_by uuid REFERENCES app_user(id);
ALTER TABLE sales_invoice    ADD COLUMN cancelled_at timestamptz,
                             ADD COLUMN cancelled_by uuid REFERENCES app_user(id);
ALTER TABLE payment_receipt  ADD COLUMN cancelled_at timestamptz,
                             ADD COLUMN cancelled_by uuid REFERENCES app_user(id);
ALTER TABLE purchase_invoice ADD COLUMN cancelled_at timestamptz,
                             ADD COLUMN cancelled_by uuid REFERENCES app_user(id);

-- ------------------------------------------------------------
-- Pergerakan stok pembalik
-- ------------------------------------------------------------
--
-- movement_type dapat dua nilai baru supaya baris pembalik bisa
-- dibedakan dari pergerakan sungguhan di kartu stok. Tanpa itu, sebuah
-- pembatalan akan terbaca sebagai penjualan dan pembelian biasa, dan
-- laporan pergerakan barang menjadi dua kali lipat dari kenyataan.
--
-- ALTER TYPE ... ADD VALUE tidak bisa dipakai di dalam transaksi yang
-- sama dengan pemakaiannya, jadi keduanya ditambahkan di sini dan baru
-- dipakai oleh migrasi maupun kode sesudahnya.
ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'REVERSAL_IN';
ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'REVERSAL_OUT';

-- ------------------------------------------------------------
-- Dokumen yang sudah dibatalkan tidak bisa dibatalkan lagi
-- ------------------------------------------------------------
--
-- Lapisan kedua di bawah lib/posting.ts. Pembatalan ganda akan
-- membalikkan jurnal dua kali dan membuat saldo bergerak ke arah yang
-- salah sejauh nilai dokumennya.
CREATE OR REPLACE FUNCTION block_double_cancel()
RETURNS trigger AS $$
BEGIN
    IF OLD.status = 'CANCELLED' AND NEW.status = 'CANCELLED' THEN
        RAISE EXCEPTION 'Dokumen % sudah dibatalkan sebelumnya.',
            COALESCE(OLD.doc_no, OLD.id::text);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_no_double_cancel_gr  BEFORE UPDATE OF status ON goods_receipt
    FOR EACH ROW EXECUTE FUNCTION block_double_cancel();
CREATE TRIGGER trg_no_double_cancel_si  BEFORE UPDATE OF status ON sales_invoice
    FOR EACH ROW EXECUTE FUNCTION block_double_cancel();
CREATE TRIGGER trg_no_double_cancel_pay BEFORE UPDATE OF status ON payment_receipt
    FOR EACH ROW EXECUTE FUNCTION block_double_cancel();
CREATE TRIGGER trg_no_double_cancel_pi  BEFORE UPDATE OF status ON purchase_invoice
    FOR EACH ROW EXECUTE FUNCTION block_double_cancel();

-- ------------------------------------------------------------
-- Pandangan: dokumen yang dibatalkan beserta pembaliknya
-- ------------------------------------------------------------
CREATE VIEW v_pembatalan AS
SELECT b.id                       AS jurnal_pembalik_id,
       b.entry_no                 AS jurnal_pembalik,
       b.entry_date               AS tanggal_pembalik,
       b.reversal_reason          AS alasan,
       b.created_by               AS dibatalkan_oleh,
       a.id                       AS jurnal_asal_id,
       a.entry_no                 AS jurnal_asal,
       a.entry_date               AS tanggal_asal,
       a.source_type              AS jenis_dokumen,
       a.source_id                AS dokumen_id,
       -- Selisih hari antara kejadian dan koreksinya. Angka besar di
       -- kolom ini adalah hal pertama yang dicari auditor.
       (b.entry_date - a.entry_date) AS jarak_hari
  FROM journal_entry b
  JOIN journal_entry a ON a.id = b.reverses_entry_id;
