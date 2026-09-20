-- ============================================================
-- Tera ERP - Pencarian trigram (Fase 3)
--
-- Palet pencarian tidak memakai model bahasa. Kecocokan dihitung
-- Postgres lewat pg_trgm, sehingga hasilnya instan, gratis, dan
-- selalu sama untuk masukan yang sama.
--
-- Index GIN trigram dipilih (bukan tsvector) karena yang dicari di
-- sini adalah potongan kode dan nomor dokumen — "SKU-10", "INV/2026"
-- bukan kata dalam kalimat. Pencarian teks penuh memecah per kata dan
-- akan melewatkan pencocokan di tengah token seperti itu.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Barang: dicari lewat nama maupun SKU.
CREATE INDEX IF NOT EXISTS idx_trgm_product_name
    ON product USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_trgm_product_sku
    ON product USING gin (sku gin_trgm_ops);

-- Mitra: nama perusahaan maupun kode internal.
CREATE INDEX IF NOT EXISTS idx_trgm_partner_name
    ON partner USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_trgm_partner_code
    ON partner USING gin (code gin_trgm_ops);

-- Dokumen: nomor penerimaan dan nomor faktur.
CREATE INDEX IF NOT EXISTS idx_trgm_gr_doc_no
    ON goods_receipt USING gin (doc_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_trgm_si_doc_no
    ON sales_invoice USING gin (doc_no gin_trgm_ops);
