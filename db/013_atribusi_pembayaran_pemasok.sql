-- ============================================================
-- 013 - Atribusi jurnal untuk pembayaran ke pemasok
--
-- Trigger isi_created_by_jurnal di migrasi 008 mencari pembuat jurnal
-- lewat dokumen sumbernya, dengan daftar source_type yang saat itu
-- lengkap. supplier_payment lahir setelahnya, jadi jurnalnya jatuh ke
-- cabang terakhir dan diatribusikan ke akun sistem — seolah-olah dibuat
-- skrip, padahal diposting orang.
--
-- Kegagalan seperti ini tidak menghasilkan galat apa pun: jurnalnya
-- tetap tercatat, hanya pelakunya yang salah. Justru itu yang membuatnya
-- perlu diperbaiki secara eksplisit.
-- ============================================================

CREATE OR REPLACE FUNCTION isi_created_by_jurnal()
RETURNS trigger AS $$
BEGIN
    IF NEW.created_by IS NULL AND NEW.source_id IS NOT NULL THEN
        NEW.created_by := CASE NEW.source_type
            WHEN 'GOODS_RECEIPT'    THEN (SELECT created_by FROM goods_receipt    WHERE id = NEW.source_id)
            WHEN 'SALES_INVOICE'    THEN (SELECT created_by FROM sales_invoice    WHERE id = NEW.source_id)
            WHEN 'PAYMENT_RECEIPT'  THEN (SELECT created_by FROM payment_receipt  WHERE id = NEW.source_id)
            WHEN 'PURCHASE_INVOICE' THEN (SELECT created_by FROM purchase_invoice WHERE id = NEW.source_id)
            WHEN 'SUPPLIER_PAYMENT' THEN (SELECT created_by FROM supplier_payment WHERE id = NEW.source_id)
        END;
    END IF;
    IF NEW.created_by IS NULL THEN
        NEW.created_by := (SELECT id FROM app_user WHERE email = 'sistem@tera.local');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
