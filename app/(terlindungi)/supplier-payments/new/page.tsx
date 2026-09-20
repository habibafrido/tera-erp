import { query } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import { SupplierPaymentForm } from "@/components/SupplierPaymentForm";

export const dynamic = "force-dynamic";

export default async function NewSupplierPaymentPage() {
  const [suppliers, hari] = await Promise.all([
    query<{ id: string; code: string; name: string; is_pkp: boolean }>(
      `SELECT id, code, name, is_pkp FROM partner WHERE is_supplier ORDER BY name`
    ),
    // Tanggal bawaan dari DATABASE, bukan dari jam browser atau jam Node.
    query<{ d: string }>(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`),
  ]);

  return (
    <>
      <PageHeader
        title="Catat pembayaran ke pemasok"
        desc="Satu pembayaran boleh dibagi ke beberapa faktur. Kelebihan bayar dicatat sebagai Uang Muka Pembelian — aset, bukan beban."
      />

      <SupplierPaymentForm
        today={hari[0].d}
        suppliers={suppliers.map((s) => ({
          id: s.id,
          label: `${s.name} (${s.code})${s.is_pkp ? " · PKP" : ""}`,
        }))}
      />
    </>
  );
}
