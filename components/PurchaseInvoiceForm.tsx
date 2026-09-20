"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FormMessage } from "./FormMessage";
import { Empty } from "./ui";
import {
  penerimaanBelumDifakturkan,
  saveAndPostPurchaseInvoice,
} from "@/app/actions";
import type { ActionResult } from "@/app/actions";

type Option = { id: string; label: string };

type Baris = {
  receipt_line_id: string;
  receipt_no: string;
  receipt_date: string;
  sku: string;
  product: string;
  qty_diterima: string;
  qty_difakturkan: string;
  qty_sisa: string;
  biaya_terima: string;
  grni_sisa: string;
};

const rp = (v: unknown) =>
  "Rp " + new Intl.NumberFormat("id-ID").format(Math.round(Number(v) || 0));

const angka = (v: unknown) =>
  new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 }).format(
    Number(v) || 0
  );

/**
 * Formulir faktur pembelian dengan pencocokan tiga arah.
 *
 * Kolom qty dan harga sudah terisi dari PENERIMAAN, bukan kosong. Yang
 * diketik orang hanya bedanya — dan justru beda itulah yang dilihat
 * sistem. Formulir yang dimulai kosong membuat orang mengetik ulang
 * angka faktur apa adanya dan pencocokannya tidak pernah benar-benar
 * terjadi.
 *
 * Semua validasi di sini untuk kenyamanan. Penolakan yang sebenarnya ada
 * di lib/posting.ts, di dalam transaksi dan di bawah kunci per baris
 * penerimaan.
 */
export function PurchaseInvoiceForm({
  suppliers,
  today,
}: {
  suppliers: Option[];
  today: string;
}) {
  const router = useRouter();

  const [docDate, setDocDate] = useState(today);
  const [supplier, setSupplier] = useState("");
  const [ref, setRef] = useState("");
  const [note, setNote] = useState("");
  const [baris, setBaris] = useState<Baris[]>([]);
  const [pilih, setPilih] = useState<Record<string, { qty: string; harga: string }>>({});
  const [setujuQty, setSetujuQty] = useState(false);
  const [penyetuju, setPenyetuju] = useState("");
  const [memuat, setMemuat] = useState(false);
  const [res, setRes] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let batal = false;
    if (!supplier) {
      setBaris([]);
      setPilih({});
      return;
    }
    setMemuat(true);
    penerimaanBelumDifakturkan(supplier)
      .then((b) => {
        if (batal) return;
        // Penolakan dari denganPeran() bukan array. Dibedakan di sini,
        // bukan dipaksa dengan cast.
        if (!Array.isArray(b)) {
          setBaris([]);
          setPilih({});
          setRes(b);
          return;
        }
        setBaris(b);
        // Terisi di muka dari penerimaan: qty sisa dan harga saat terima.
        setPilih(
          Object.fromEntries(
            b.map((x) => [
              x.receipt_line_id,
              { qty: x.qty_sisa, harga: x.biaya_terima },
            ])
          )
        );
      })
      .finally(() => {
        if (!batal) setMemuat(false);
      });
    return () => {
      batal = true;
    };
  }, [supplier]);

  const terpilih = baris.filter((b) => Number(pilih[b.receipt_line_id]?.qty) > 0);

  const hitung = (b: Baris) => {
    const p = pilih[b.receipt_line_id] ?? { qty: "0", harga: "0" };
    const qty = Number(p.qty) || 0;
    const harga = Number(p.harga) || 0;
    const sisa = Number(b.qty_sisa);
    const biaya = Number(b.biaya_terima);
    const qtyCocok = Math.min(qty, sisa);
    return {
      qty,
      harga,
      nilai: qty * harga,
      grni: qtyCocok * biaya,
      selisihHarga: qtyCocok * (harga - biaya),
      selisihQty: Math.max(qty - sisa, 0) * harga,
    };
  };

  const total = terpilih.reduce(
    (a, b) => {
      const h = hitung(b);
      return {
        nilai: a.nilai + h.nilai,
        grni: a.grni + h.grni,
        selisihHarga: a.selisihHarga + h.selisihHarga,
        selisihQty: a.selisihQty + h.selisihQty,
      };
    },
    { nilai: 0, grni: 0, selisihHarga: 0, selisihQty: 0 }
  );

  const adaSelisihQty = total.selisihQty !== 0;
  const tertahan = adaSelisihQty && !setujuQty;
  const bolehKirim =
    !pending && supplier !== "" && terpilih.length > 0 && !tertahan;

  const set = (id: string, patch: Partial<{ qty: string; harga: string }>) =>
    setPilih((p) => ({ ...p, [id]: { ...p[id], ...patch } }));

  const submit = () =>
    start(async () => {
      const r = await saveAndPostPurchaseInvoice({
        doc_date: docDate,
        supplier_id: supplier,
        supplier_ref: ref,
        note,
        approve_qty_variance: setujuQty,
        approved_by: penyetuju,
        lines: terpilih.map((b) => ({
          receipt_line_id: b.receipt_line_id,
          qty: pilih[b.receipt_line_id].qty,
          unit_cost: pilih[b.receipt_line_id].harga,
        })),
      });
      setRes(r);
      if (r.ok) {
        setRef("");
        setNote("");
        setSetujuQty(false);
        setPenyetuju("");
        const b = await penerimaanBelumDifakturkan(supplier);
        if (Array.isArray(b)) {
          setBaris(b);
          setPilih(
            Object.fromEntries(
              b.map((x) => [
                x.receipt_line_id,
                { qty: x.qty_sisa, harga: x.biaya_terima },
              ])
            )
          );
        }
        router.refresh();
      }
    });

  return (
    <div className="space-y-6">
      <div className="card p-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs text-muted">Tanggal faktur</span>
            <input
              className="field"
              type="date"
              value={docDate}
              onChange={(e) => setDocDate(e.target.value)}
            />
          </label>

          <label className="block lg:col-span-2">
            <span className="mb-1 block text-xs text-muted">Pemasok</span>
            <select
              className="field"
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
            >
              <option value="">— pilih —</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs text-muted">Nomor faktur pemasok</span>
            <input
              className="field"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder="mis. INV-2026-0912"
            />
          </label>
        </div>

        <label className="mt-4 block">
          <span className="mb-1 block text-xs text-muted">
            Catatan <span className="text-muted">(opsional)</span>
          </span>
          <input
            className="field"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      </div>

      <div className="card p-4">
        <h2 className="mb-3 text-sm font-semibold">
          Penerimaan yang belum difakturkan
        </h2>

        {!supplier ? (
          <Empty text="Pilih pemasok untuk melihat penerimaan yang belum difakturkan." />
        ) : memuat ? (
          <p className="py-6 text-center text-sm text-muted">Memuat penerimaan…</p>
        ) : baris.length === 0 ? (
          <Empty text="Tidak ada penerimaan dari pemasok ini yang belum difakturkan. Akun Barang Diterima Belum Ditagih untuk pemasok ini sudah bersih." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-sm">
              <thead>
                <tr>
                  <th className="th">Penerimaan</th>
                  <th className="th">Barang</th>
                  <th className="th text-right">Belum difakturkan</th>
                  <th className="th text-right">Harga saat terima</th>
                  <th className="th text-right">Qty ditagih</th>
                  <th className="th text-right">Harga faktur</th>
                  <th className="th text-right">Selisih</th>
                </tr>
              </thead>
              <tbody>
                {baris.map((b) => {
                  const h = hitung(b);
                  const bedaHarga = h.selisihHarga !== 0;
                  const bedaQty = h.selisihQty !== 0;
                  return (
                    <tr key={b.receipt_line_id}>
                      <td className="td">
                        <span className="font-medium">{b.receipt_no}</span>
                        <span className="block text-xs text-muted">
                          {b.receipt_date}
                        </span>
                      </td>
                      <td className="td">
                        <span className="font-medium">{b.sku}</span>
                        <span className="block text-xs text-muted">{b.product}</span>
                      </td>
                      <td className="td td-num tnum">
                        {angka(b.qty_sisa)}
                        {Number(b.qty_difakturkan) > 0 && (
                          <span className="block text-xs text-muted">
                            dari {angka(b.qty_diterima)}
                          </span>
                        )}
                      </td>
                      <td className="td td-num tnum text-muted">
                        {rp(b.biaya_terima)}
                      </td>
                      <td className="td td-num">
                        <input
                          className="field tnum w-28 text-right"
                          type="number"
                          min="0"
                          step="0.000001"
                          aria-label={"Kuantitas ditagih untuk " + b.sku}
                          value={pilih[b.receipt_line_id]?.qty ?? ""}
                          onChange={(e) =>
                            set(b.receipt_line_id, { qty: e.target.value })
                          }
                        />
                      </td>
                      <td className="td td-num">
                        <input
                          className="field tnum w-32 text-right"
                          type="number"
                          min="0"
                          step="0.01"
                          aria-label={"Harga faktur untuk " + b.sku}
                          value={pilih[b.receipt_line_id]?.harga ?? ""}
                          onChange={(e) =>
                            set(b.receipt_line_id, { harga: e.target.value })
                          }
                        />
                      </td>
                      <td className="td td-num tnum">
                        {!bedaHarga && !bedaQty ? (
                          <span className="text-muted">cocok</span>
                        ) : (
                          <>
                            {bedaHarga && (
                              <span className="block text-xs">
                                harga {rp(h.selisihHarga)}
                              </span>
                            )}
                            {bedaQty && (
                              <span className="block text-xs text-danger">
                                kuantitas {rp(h.selisihQty)}
                              </span>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {adaSelisihQty && (
          <div
            role="alert"
            className="mt-4 rounded-md border border-danger/50 p-3 text-sm"
          >
            <p className="font-medium text-danger">
              Faktur menagih lebih banyak dari yang pernah diterima.
            </p>
            <p className="mt-1 text-muted">
              Selisih kuantitas {rp(total.selisihQty)} tidak punya penyeimbang di
              akun Barang Diterima Belum Ditagih — artinya Anda ditagih untuk
              barang yang tidak tercatat masuk gudang. Posting ditahan sampai
              seseorang menyetujuinya.
            </p>
            <label className="mt-3 flex flex-wrap items-center gap-2">
              <input
                type="checkbox"
                checked={setujuQty}
                onChange={(e) => setSetujuQty(e.target.checked)}
              />
              <span>Saya sudah meninjau dan menyetujui selisih ini.</span>
            </label>
            {setujuQty && (
              <label className="mt-2 block max-w-xs">
                <span className="mb-1 block text-xs text-muted">
                  Nama penyetuju (tercatat di dokumen)
                </span>
                <input
                  className="field"
                  value={penyetuju}
                  onChange={(e) => setPenyetuju(e.target.value)}
                />
              </label>
            )}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-end justify-between gap-4 border-t border-line pt-4">
          <dl className="grid gap-x-8 gap-y-1 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted">Nilai faktur</dt>
              <dd className="tnum font-medium">{rp(total.nilai)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">GRNI dilepas</dt>
              <dd className="tnum font-medium">{rp(total.grni)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Selisih harga</dt>
              <dd className="tnum font-medium">{rp(total.selisihHarga)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Selisih kuantitas</dt>
              <dd
                className={
                  "tnum font-medium " + (adaSelisihQty ? "text-danger" : "")
                }
              >
                {rp(total.selisihQty)}
              </dd>
            </div>
          </dl>

          <button
            type="button"
            className="btn"
            onClick={submit}
            disabled={!bolehKirim}
            aria-busy={pending}
          >
            {pending
              ? "Memposting…"
              : tertahan
                ? "Ditahan — setujui dulu"
                : "Simpan & posting"}
          </button>
        </div>

        {(total.selisihHarga !== 0 || total.selisihQty !== 0) && (
          <p className="mt-3 text-xs text-muted">
            Selisih masuk akun 5-3100 Selisih Harga Pembelian lewat jurnal
            tersendiri. Nilai persediaan dan rata-rata bergerak tidak diubah —
            sebagian barang ini mungkin sudah terjual dan harga pokoknya sudah
            masuk laba rugi.
          </p>
        )}
      </div>

      {res && <FormMessage res={res} />}
    </div>
  );
}
