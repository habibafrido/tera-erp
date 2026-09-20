-- ============================================================
-- Tera ERP - Core Schema (Fase 1)
-- PostgreSQL 15+
--
-- Prinsip:
--   1. Stock ledger append-only (tidak pernah UPDATE/DELETE)
--   2. Setiap pergerakan stok menghasilkan jurnal di transaksi yang sama
--   3. Double-entry dipaksakan lewat constraint, bukan kode aplikasi
--   4. Costing: moving average
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- 1. MASTER DATA
-- ============================================================

-- Satuan dasar. Untuk distributor FMCG ini sumber bug nomor satu:
-- barang dibeli per karton, dijual per pcs.
CREATE TABLE uom (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code        text NOT NULL UNIQUE,          -- PCS, BOX, CTN, KG
    name        text NOT NULL
);

CREATE TABLE product (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sku             text NOT NULL UNIQUE,
    name            text NOT NULL,
    base_uom_id     uuid NOT NULL REFERENCES uom(id),
    -- Semua qty di stock_ledger SELALU disimpan dalam base_uom.
    -- Konversi hanya terjadi di lapisan presentasi/input.
    is_batch_tracked boolean NOT NULL DEFAULT false,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Konversi satuan: 1 CTN = 24 PCS
CREATE TABLE product_uom_conversion (
    product_id  uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    uom_id      uuid NOT NULL REFERENCES uom(id),
    factor      numeric(18,6) NOT NULL CHECK (factor > 0),
    PRIMARY KEY (product_id, uom_id)
);

CREATE TABLE warehouse (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code        text NOT NULL UNIQUE,
    name        text NOT NULL,
    is_active   boolean NOT NULL DEFAULT true
);

-- Batch + expiry. Wajib untuk FMCG (FEFO).
CREATE TABLE batch (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id  uuid NOT NULL REFERENCES product(id),
    batch_no    text NOT NULL,
    expiry_date date,
    UNIQUE (product_id, batch_no)
);

-- Satu tabel untuk customer & supplier. Satu perusahaan bisa jadi keduanya.
CREATE TABLE partner (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code         text NOT NULL UNIQUE,
    name         text NOT NULL,
    is_customer  boolean NOT NULL DEFAULT false,
    is_supplier  boolean NOT NULL DEFAULT false,
    npwp         text,
    payment_term_days int NOT NULL DEFAULT 0,
    credit_limit numeric(18,2),
    created_at   timestamptz NOT NULL DEFAULT now(),
    CHECK (is_customer OR is_supplier)
);

-- ============================================================
-- 2. CHART OF ACCOUNTS & JURNAL (double-entry)
-- ============================================================

CREATE TYPE account_type AS ENUM ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE');

CREATE TABLE account (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code        text NOT NULL UNIQUE,          -- 1-1300
    name        text NOT NULL,                 -- Persediaan Barang Dagang
    type        account_type NOT NULL,
    parent_id   uuid REFERENCES account(id),
    is_postable boolean NOT NULL DEFAULT true  -- akun header tidak bisa dijurnal
);

CREATE TABLE journal_entry (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_no     text NOT NULL UNIQUE,
    entry_date   date NOT NULL,
    description  text,
    -- Dokumen sumber. Setiap jurnal harus bisa ditelusuri asalnya.
    source_type  text,                          -- GOODS_RECEIPT, DELIVERY, INVOICE
    source_id    uuid,
    is_posted    boolean NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE journal_line (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_id    uuid NOT NULL REFERENCES journal_entry(id) ON DELETE CASCADE,
    account_id  uuid NOT NULL REFERENCES account(id),
    partner_id  uuid REFERENCES partner(id),   -- untuk buku besar pembantu AR/AP
    debit       numeric(18,2) NOT NULL DEFAULT 0 CHECK (debit  >= 0),
    credit      numeric(18,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
    -- Satu baris hanya boleh debit ATAU kredit, tidak keduanya
    CHECK ( (debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0) )
);

CREATE INDEX idx_journal_line_entry   ON journal_line(entry_id);
CREATE INDEX idx_journal_line_account ON journal_line(account_id);

-- Constraint paling penting di seluruh sistem:
-- jurnal tidak boleh di-post kalau debit != kredit.
CREATE OR REPLACE FUNCTION assert_journal_balanced()
RETURNS trigger AS $$
DECLARE
    v_entry uuid;
    v_diff  numeric(18,2);
BEGIN
    v_entry := COALESCE(NEW.entry_id, OLD.entry_id);

    SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0)
      INTO v_diff
      FROM journal_line WHERE entry_id = v_entry;

    IF v_diff <> 0 THEN
        RAISE EXCEPTION 'Jurnal % tidak seimbang. Selisih: %', v_entry, v_diff;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- DEFERRED: dicek saat COMMIT, supaya baris bisa disisipkan satu per satu.
CREATE CONSTRAINT TRIGGER trg_journal_balanced
    AFTER INSERT OR UPDATE OR DELETE ON journal_line
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

-- Jurnal yang sudah di-post tidak boleh diubah. Koreksi = jurnal pembalik.
CREATE OR REPLACE FUNCTION block_posted_journal()
RETURNS trigger AS $$
BEGIN
    IF (SELECT is_posted FROM journal_entry
         WHERE id = COALESCE(NEW.entry_id, OLD.entry_id)) THEN
        RAISE EXCEPTION 'Jurnal sudah di-post dan tidak dapat diubah.';
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_block_posted_journal
    BEFORE INSERT OR UPDATE OR DELETE ON journal_line
    FOR EACH ROW EXECUTE FUNCTION block_posted_journal();

-- ============================================================
-- 3. STOCK LEDGER (append-only)
-- ============================================================

CREATE TYPE movement_type AS ENUM (
    'OPENING',          -- saldo awal saat migrasi
    'PURCHASE_RECEIPT',
    'SALES_ISSUE',
    'TRANSFER_IN',
    'TRANSFER_OUT',
    'ADJUSTMENT',       -- hasil stock opname
    'RETURN_IN',
    'RETURN_OUT'
);

CREATE TABLE stock_ledger (
    id              bigserial PRIMARY KEY,
    product_id      uuid NOT NULL REFERENCES product(id),
    warehouse_id    uuid NOT NULL REFERENCES warehouse(id),
    batch_id        uuid REFERENCES batch(id),

    movement_type   movement_type NOT NULL,
    -- qty positif = masuk, negatif = keluar. SELALU dalam base_uom.
    qty             numeric(18,6) NOT NULL CHECK (qty <> 0),

    -- Biaya per unit saat transaksi ini terjadi.
    unit_cost       numeric(18,6) NOT NULL CHECK (unit_cost >= 0),

    -- Snapshot moving average SETELAH pergerakan ini.
    -- Disimpan supaya nilai persediaan historis bisa direkonstruksi
    -- tanpa menghitung ulang seluruh ledger.
    running_qty     numeric(18,6) NOT NULL,
    running_value   numeric(18,2) NOT NULL,

    posted_at       timestamptz NOT NULL,
    source_type     text NOT NULL,
    source_id       uuid NOT NULL,
    journal_entry_id uuid REFERENCES journal_entry(id),
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ledger_product_wh  ON stock_ledger(product_id, warehouse_id, posted_at);
CREATE INDEX idx_ledger_batch       ON stock_ledger(batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX idx_ledger_source      ON stock_ledger(source_type, source_id);

-- Ledger tidak boleh diubah atau dihapus. Titik.
CREATE OR REPLACE FUNCTION block_ledger_mutation()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'stock_ledger bersifat append-only. Gunakan entri pembalik.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_block_ledger_mutation
    BEFORE UPDATE OR DELETE ON stock_ledger
    FOR EACH ROW EXECUTE FUNCTION block_ledger_mutation();

-- ============================================================
-- 4. SALDO STOK
-- ============================================================

-- Nilai persediaan diambil dari baris TERAKHIR buku besar per barang+gudang,
-- karena di situlah rata-rata bergerak dihitung. Menjumlahkan nilai per batch
-- akan salah: biaya dihitung pada level barang+gudang, bukan level batch.
CREATE VIEW v_stock_balance AS
SELECT * FROM (
    SELECT DISTINCT ON (product_id, warehouse_id)
           product_id,
           warehouse_id,
           running_qty   AS qty_on_hand,
           running_value AS stock_value
      FROM stock_ledger
     ORDER BY product_id, warehouse_id, id DESC
) t
WHERE qty_on_hand <> 0;

-- Kuantitas per batch. Sengaja TANPA nilai rupiah: batch dilacak untuk
-- kebutuhan fisik dan kedaluwarsa, penilaian tetap satu angka per gudang.
CREATE VIEW v_stock_batch AS
SELECT product_id,
       warehouse_id,
       batch_id,
       SUM(qty) AS qty_on_hand
  FROM stock_ledger
 GROUP BY product_id, warehouse_id, batch_id
HAVING SUM(qty) <> 0;

-- Untuk FEFO: batch yang paling dekat kedaluwarsa keluar duluan.
CREATE VIEW v_stock_fefo AS
SELECT
    b.product_id,
    sb.warehouse_id,
    b.id AS batch_id,
    b.batch_no,
    b.expiry_date,
    sb.qty_on_hand,
    (b.expiry_date - CURRENT_DATE) AS days_to_expiry
FROM v_stock_batch sb
JOIN batch b ON b.id = sb.batch_id
WHERE sb.qty_on_hand > 0;

-- ============================================================
-- 5. SEED: Chart of Accounts minimal
-- ============================================================

INSERT INTO account (code, name, type) VALUES
    ('1-1100', 'Kas & Bank',                 'ASSET'),
    ('1-1200', 'Piutang Usaha',              'ASSET'),
    ('1-1300', 'Persediaan Barang Dagang',   'ASSET'),
    ('1-1400', 'PPN Masukan',                'ASSET'),
    ('2-1100', 'Utang Usaha',                'LIABILITY'),
    ('2-1200', 'PPN Keluaran',               'LIABILITY'),
    ('2-1300', 'Barang Diterima Belum Ditagih', 'LIABILITY'),
    ('3-1100', 'Modal',                      'EQUITY'),
    ('4-1100', 'Penjualan',                  'REVENUE'),
    ('5-1100', 'Harga Pokok Penjualan',      'EXPENSE'),
    ('5-2100', 'Kerugian Penyusutan Stok',   'EXPENSE');

INSERT INTO uom (code, name) VALUES
    ('PCS', 'Pieces'),
    ('CTN', 'Carton'),
    ('BOX', 'Box'),
    ('KG',  'Kilogram');
