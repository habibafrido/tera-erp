-- ============================================================
-- 007 - Dokumen baru ikut terindeks palet pencarian
--
-- Migrasi 003 memasang index trigram untuk nomor penerimaan dan nomor
-- faktur penjualan. Sejak 005 dan 006 ada dua jenis dokumen lagi, dan
-- tanpa berkas ini palet pencarian akan diam saja untuk "PAY/2026" atau
-- "PI/2026" — diam yang lebih buruk daripada pesan "tidak ditemukan",
-- karena orang akan mengira dokumennya yang tidak ada.
--
-- Nomor faktur PEMASOK ikut diindeks: itulah nomor yang tercetak di
-- kertas yang dipegang orang, dan itulah yang mereka ketik lebih dulu.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_trgm_pay_doc_no
    ON payment_receipt USING gin (doc_no gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_trgm_pi_doc_no
    ON purchase_invoice USING gin (doc_no gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_trgm_pi_supplier_ref
    ON purchase_invoice USING gin (supplier_ref gin_trgm_ops);
