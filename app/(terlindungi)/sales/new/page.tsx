import Link from "next/link";
import { query } from "@/lib/db";
import { saveAndPostInvoice } from "@/app/actions";
import { DocumentForm } from "@/components/DocumentForm";
import { Empty, PageHeader, Panel } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function NewSalePage() {
  const [customers, warehouses, products, [tanggalDb]] = await Promise.all([
    query(`SELECT id, code, name FROM partner WHERE is_customer ORDER BY name`),
    query(`SELECT id, code, name FROM warehouse WHERE is_active ORDER BY code`),
    query(`SELECT id, sku, name, is_batch_tracked FROM product WHERE is_active ORDER BY sku`),
    // Tanggal bawaan formulir berasal dari database, BUKAN dari jam
    // server: keduanya bisa berbeda zona waktu, dan tanggal dokumen
    // yang meleset masuk ke buku besar append-only.
    query<{ hari_ini: string }>(
      `SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS hari_ini`
    ),
  ]);

  const siap = warehouses.length > 0 && customers.length > 0 && products.length > 0;

  return (
    <>
      <PageHeader
        title="Buat faktur"
        desc="Stok keluar pada biaya rata-rata bergerak dengan alokasi FEFO, lalu pendapatan dan harga pokok dijurnal sekaligus."
        action={
          <Link href="/sales" className="btn-ghost">
            Kembali ke daftar
          </Link>
        }
      />

      {siap ? (
        <DocumentForm
          mode="sales"
          today={tanggalDb.hari_ini}
          onSubmit={saveAndPostInvoice}
          partners={customers.map((p) => ({ id: p.id, label: p.code + " · " + p.name }))}
          warehouses={warehouses.map((w) => ({ id: w.id, label: w.code + " · " + w.name }))}
          products={products.map((p) => ({
            id: p.id,
            label: p.sku + " · " + p.name,
            batch: p.is_batch_tracked,
          }))}
        />
      ) : (
        <Panel>
          <Empty
            text="Lengkapi dulu data induk: minimal satu gudang, satu pelanggan, dan satu barang. Jalankan npm run db:seed untuk data contoh."
            action={
              <Link href="/partners" className="btn-ghost">
                Buka data mitra
              </Link>
            }
          />
        </Panel>
      )}
    </>
  );
}
