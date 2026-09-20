-- ============================================================
-- 002 - Dokumen transaksi + penomoran
-- ============================================================

-- Penomoran dokumen. Pakai tabel counter, bukan sequence,
-- supaya nomor bisa di-reset per bulan dan punya prefix.
CREATE TABLE doc_counter (
    doc_type    text NOT NULL,
    period      text NOT NULL,          -- '2026-09'
    last_no     int  NOT NULL DEFAULT 0,
    PRIMARY KEY (doc_type, period)
);

CREATE OR REPLACE FUNCTION next_doc_no(p_type text, p_date date)
RETURNS text AS $$
DECLARE
    v_period text := to_char(p_date, 'YYYY-MM');
    v_no     int;
BEGIN
    INSERT INTO doc_counter (doc_type, period, last_no)
    VALUES (p_type, v_period, 1)
    ON CONFLICT (doc_type, period)
    DO UPDATE SET last_no = doc_counter.last_no + 1
    RETURNING last_no INTO v_no;

    RETURN p_type || '/' || to_char(p_date,'YYYY') || '/' ||
           to_char(p_date,'MM') || '/' || lpad(v_no::text, 4, '0');
END;
$$ LANGUAGE plpgsql;

CREATE TYPE doc_status AS ENUM ('DRAFT','POSTED','CANCELLED');

-- ------------------------------------------------------------
-- Penerimaan barang
-- ------------------------------------------------------------
CREATE TABLE goods_receipt (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_no        text UNIQUE,
    doc_date      date NOT NULL,
    supplier_id   uuid NOT NULL REFERENCES partner(id),
    warehouse_id  uuid NOT NULL REFERENCES warehouse(id),
    supplier_ref  text,
    note          text,
    status        doc_status NOT NULL DEFAULT 'DRAFT',
    total_value   numeric(18,2) NOT NULL DEFAULT 0,
    posted_at     timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE goods_receipt_line (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_id   uuid NOT NULL REFERENCES goods_receipt(id) ON DELETE CASCADE,
    line_no      int  NOT NULL,
    product_id   uuid NOT NULL REFERENCES product(id),
    batch_no     text,
    expiry_date  date,
    qty          numeric(18,6) NOT NULL CHECK (qty > 0),
    unit_cost    numeric(18,6) NOT NULL CHECK (unit_cost >= 0),
    UNIQUE (receipt_id, line_no)
);

-- ------------------------------------------------------------
-- Faktur penjualan (sekaligus pengeluaran stok)
-- ------------------------------------------------------------
CREATE TABLE sales_invoice (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_no        text UNIQUE,
    doc_date      date NOT NULL,
    due_date      date,
    customer_id   uuid NOT NULL REFERENCES partner(id),
    warehouse_id  uuid NOT NULL REFERENCES warehouse(id),
    note          text,
    status        doc_status NOT NULL DEFAULT 'DRAFT',
    subtotal      numeric(18,2) NOT NULL DEFAULT 0,
    tax_amount    numeric(18,2) NOT NULL DEFAULT 0,
    total         numeric(18,2) NOT NULL DEFAULT 0,
    cogs_amount   numeric(18,2) NOT NULL DEFAULT 0,
    posted_at     timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sales_invoice_line (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id   uuid NOT NULL REFERENCES sales_invoice(id) ON DELETE CASCADE,
    line_no      int  NOT NULL,
    product_id   uuid NOT NULL REFERENCES product(id),
    qty          numeric(18,6) NOT NULL CHECK (qty > 0),
    unit_price   numeric(18,2) NOT NULL CHECK (unit_price >= 0),
    UNIQUE (invoice_id, line_no)
);

-- ------------------------------------------------------------
-- Pemetaan akun, supaya logika posting tidak hardcode kode akun
-- ------------------------------------------------------------
CREATE TABLE account_mapping (
    key         text PRIMARY KEY,
    account_id  uuid NOT NULL REFERENCES account(id)
);

INSERT INTO account_mapping (key, account_id)
SELECT m.k, a.id FROM (VALUES
    ('INVENTORY',    '1-1300'),
    ('AR',           '1-1200'),
    ('GRNI',         '2-1300'),
    ('VAT_OUT',      '2-1200'),
    ('SALES',        '4-1100'),
    ('COGS',         '5-1100'),
    ('STOCK_ADJUST', '5-2100')
) AS m(k, code)
JOIN account a ON a.code = m.code;

CREATE INDEX idx_gr_date ON goods_receipt(doc_date DESC);
CREATE INDEX idx_si_date ON sales_invoice(doc_date DESC);
