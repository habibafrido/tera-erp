import { query } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import { PurchaseInvoiceForm } from "@/components/PurchaseInvoiceForm";

export const dynamic = "force-dynamic";

export default async function NewPurchaseInvoicePage() {
  const [suppliers, hari] = await Promise.all([
    query<{ id: string; code: string; name: string }>(
      `SELECT id, code, name FROM partner WHERE is_supplier ORDER BY name`
    ),
    // Tanggal bawaan dari DATABASE, bukan dari jam browser atau jam Node.
    query<{ d: string }>(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`),
  ]);

  return (
    <>
      <PageHeader
        title="Catat faktur pembelian"
        desc="Kuantitas dan harga terisi dari penerimaan. Ubah hanya yang berbeda di faktur pemasok — perbedaannya itulah yang dicocokkan."
      />

      <PurchaseInvoiceForm
        today={hari[0].d}
        suppliers={suppliers.map((s) => ({
          id: s.id,
          label: `${s.name} (${s.code})`,
        }))}
      />
    </>
  );
}
