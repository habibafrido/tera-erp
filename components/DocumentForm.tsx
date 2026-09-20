"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FormMessage } from "./FormMessage";
import { Num, TableWrap } from "./ui";
import type { ActionResult } from "@/app/actions";

type Option = { id: string; label: string; batch?: boolean };
type Line = {
  product_id: string;
  qty: string;
  price: string;
  batch_no: string;
  expiry_date: string;
};

const emptyLine = (): Line => ({
  product_id: "", qty: "", price: "", batch_no: "", expiry_date: "",
});

export function DocumentForm({
  mode, partners, warehouses, products, onSubmit, today,
}: {
  mode: "receipt" | "sales";
  partners: Option[];
  warehouses: Option[];
  products: Option[];
  today: string;
  onSubmit: (p: any) => Promise<ActionResult>;
}) {
  const isReceipt = mode === "receipt";
  const router = useRouter();

  const [docDate, setDocDate] = useState(today);
  const [partner, setPartner] = useState("");
  const [warehouse, setWarehouse] = useState(warehouses[0]?.id ?? "");
  const [ref, setRef] = useState("");
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [res, setRes] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();

  const set = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));

  const subtotal = lines.reduce(
    (s, l) => s + (Number(l.qty) || 0) * (Number(l.price) || 0), 0
  );

  const submit = () =>
    start(async () => {
      const payload = {
        doc_date: docDate,
        warehouse_id: warehouse,
        ...(isReceipt
          ? { supplier_id: partner, supplier_ref: ref }
          : { customer_id: partner }),
        lines: lines.map((l) => ({
          product_id: l.product_id,
          qty: l.qty,
          ...(isReceipt
            ? { unit_cost: l.price, batch_no: l.batch_no, expiry_date: l.expiry_date }
            : { unit_price: l.price }),
        })),
      };
      const r = await onSubmit(payload);
      setRes(r);
      if (r.ok) {
        setLines([emptyLine()]);
        setPartner("");
        setRef("");
        router.refresh();
      }
    });

  const productOf = (id: string) => products.find((p) => p.id === id);

  return (
    <div className="space-y-5">
      <FormMessage res={res} />

      <div className="card grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Tanggal</span>
          <input type="date" className="field" value={docDate}
                 onChange={(e) => setDocDate(e.target.value)} />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs text-muted">
            {isReceipt ? "Pemasok" : "Pelanggan"}
          </span>
          <select className="field" value={partner}
                  onChange={(e) => setPartner(e.target.value)}>
            <option value="">Pilih…</option>
            {partners.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs text-muted">Gudang</span>
          <select className="field" value={warehouse}
                  onChange={(e) => setWarehouse(e.target.value)}>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>{w.label}</option>
            ))}
          </select>
        </label>

        {isReceipt && (
          <label className="block">
            <span className="mb-1 block text-xs text-muted">No. surat jalan pemasok</span>
            <input className="field" value={ref} placeholder="SJ-00123"
                   onChange={(e) => setRef(e.target.value)} />
          </label>
        )}
      </div>

      <div className="card">
        <TableWrap min={760}>
          <thead>
            <tr>
              <th className="th w-[34%]">Barang</th>
              <th className="th w-24 text-right">Jumlah</th>
              <th className="th w-36 text-right">
                {isReceipt ? "Harga beli" : "Harga jual"}
              </th>
              {isReceipt && <th className="th w-40">Batch / kedaluwarsa</th>}
              <th className="th w-36 text-right">Jumlah nilai</th>
              <th className="th w-10"></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const p = productOf(l.product_id);
              return (
                <tr key={i}>
                  <td className="td">
                    <select className="field" value={l.product_id}
                            onChange={(e) => set(i, { product_id: e.target.value })}>
                      <option value="">Pilih barang…</option>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>{p.label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="td">
                    <input type="number" step="any" className="field text-right tnum"
                           value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} />
                  </td>
                  <td className="td">
                    <input type="number" step="any" className="field text-right tnum"
                           value={l.price} onChange={(e) => set(i, { price: e.target.value })} />
                  </td>
                  {isReceipt && (
                    <td className="td">
                      {p?.batch ? (
                        <div className="space-y-1.5">
                          <input className="field" placeholder="No. batch" value={l.batch_no}
                                 onChange={(e) => set(i, { batch_no: e.target.value })} />
                          <input type="date" className="field" value={l.expiry_date}
                                 onChange={(e) => set(i, { expiry_date: e.target.value })} />
                        </div>
                      ) : (
                        <span className="text-xs text-muted">Tidak dilacak</span>
                      )}
                    </td>
                  )}
                  <Num>
                    {((Number(l.qty) || 0) * (Number(l.price) || 0)).toLocaleString("id-ID")}
                  </Num>
                  <td className="td text-right">
                    <button
                      type="button"
                      aria-label={"Hapus baris " + (i + 1)}
                      className="rounded px-2 py-1 text-muted hover:bg-paper hover:text-danger"
                      onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>

        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <button type="button" className="btn-ghost"
                  onClick={() => setLines((ls) => [...ls, emptyLine()])}>
            Tambah baris
          </button>
          <div className="text-sm">
            <span className="text-muted">Subtotal</span>{" "}
            <span className="tnum ml-2 text-base font-semibold">
              {subtotal.toLocaleString("id-ID", { style: "currency", currency: "IDR",
                                                  maximumFractionDigits: 0 })}
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button className="btn" onClick={submit} disabled={pending || !partner}>
          {pending ? "Memposting…" : "Simpan dan posting"}
        </button>
        <p className="text-xs text-muted">
          {isReceipt
            ? "Posting menambah stok dan menjurnal Dr Persediaan / Cr Barang Diterima Belum Ditagih."
            : "Posting mengeluarkan stok pada biaya rata-rata, lalu menjurnal pendapatan dan harga pokok."}
        </p>
      </div>
    </div>
  );
}
