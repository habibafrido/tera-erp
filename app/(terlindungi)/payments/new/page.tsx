import { query } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import { PaymentForm } from "@/components/PaymentForm";

export const dynamic = "force-dynamic";

export default async function NewPaymentPage() {
  const [customers, hari] = await Promise.all([
    query<{ id: string; code: string; name: string }>(
      `SELECT id, code, name FROM partner
        WHERE is_customer ORDER BY name`
    ),
    // Tanggal bawaan diambil dari DATABASE, bukan dari jam browser atau
    // jam Node. Kedua jam itu bisa berada di tanggal yang berbeda dari
    // tanggal pembukuan, dan tanggal yang salah di sini masuk ke jurnal.
    query<{ d: string }>(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`),
  ]);

  return (
    <>
      <PageHeader
        title="Catat penerimaan pembayaran"
        desc="Satu pembayaran boleh dibagi ke beberapa faktur. Kelebihan bayar dicatat sebagai Titipan Pelanggan — kewajiban, bukan pendapatan."
      />

      <PaymentForm
        today={hari[0].d}
        customers={customers.map((c) => ({
          id: c.id,
          label: `${c.name} (${c.code})`,
        }))}
      />
    </>
  );
}
