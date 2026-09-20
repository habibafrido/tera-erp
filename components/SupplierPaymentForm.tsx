"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FormMessage } from "./FormMessage";
import { Empty } from "./ui";
import {
  fakturPembelianTerbuka,
  saveAndPostSupplierPayment,
} from "@/app/actions";
import type { ActionResult } from "@/app/actions";

type Option = { id: string; label: string };

type Faktur = {
  invoice_id: string;
  doc_no: string;
  supplier_ref: string | null;
  doc_date: string;
  total: string;
  dibayar: string;
  sisa: string;
  hari_sejak_faktur: string;
};

const rp = (v: unknown) =>
  "Rp " + new Intl.NumberFormat("id-ID").format(Math.round(Number(v) || 0));

/**
 * Formulir pembayaran ke pemasok.
 *
 * Cerminan dari PaymentForm, dengan satu perbedaan yang perlu terlihat
 * di layar: kelebihan bayar di sini menjadi Uang Muka Pembelian — ASET,
 * bukan kewajiban. Uang yang sudah keluar tapi belum punya faktur adalah
 * hak tagih kepada pemasok.
 *
 * Daftar faktur diambil ulang setiap kali pemasok berganti, bukan
 * dikirim seluruhnya sejak awal: sisa utang bisa berubah karena orang
 * lain memposting pembayaran sementara formulir ini terbuka.
 */
export function SupplierPaymentForm({
  suppliers,
  today,
}: {
  suppliers: Option[];
  today: string;
}) {
  const router = useRouter();

  const [docDate, setDocDate] = useState(today);
  const [supplier, setSupplier] = useState("");
  const [method, setMethod] = useState("TRANSFER");
  const [reference, setReference] = useState("");
  const [amount, setAmount] = useState("");
  const [faktur, setFaktur] = useState<Faktur[]>([]);
  const [alokasi, setAlokasi] = useState<Record<string, string>>({});
  const [memuat, setMemuat] = useState(false);
  const [res, setRes] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let batal = false;
    if (!supplier) {
      setFaktur([]);
      setAlokasi({});
      return;
    }
    setMemuat(true);
    fakturPembelianTerbuka(supplier)
      .then((f) => {
        if (batal) return;
        // Penolakan dari denganPeran() bukan array.
        if (!Array.isArray(f)) {
          setFaktur([]);
          setRes(f);
          return;
        }
        setFaktur(f);
        setAlokasi({});
      })
      .finally(() => {
        if (!batal) setMemuat(false);
      });
    return () => {
      batal = true;
    };
  }, [supplier]);

  const totalAlokasi = Object.values(alokasi).reduce(
    (s, v) => s + (Number(v) || 0),
    0
  );
  const uang = Number(amount) || 0;
  const uangMuka = uang - totalAlokasi;

  const isiOtomatis = () => {
    let sisaUang = uang;
    const baru: Record<string, string> = {};
    for (const f of faktur) {
      if (sisaUang <= 0) break;
      const ambil = Math.min(sisaUang, Number(f.sisa));
      if (ambil > 0) {
        baru[f.invoice_id] = String(ambil);
        sisaUang -= ambil;
      }
    }
    setAlokasi(baru);
  };

  const submit = () =>
    start(async () => {
      const r = await saveAndPostSupplierPayment({
        doc_date: docDate,
        supplier_id: supplier,
        method,
        reference,
        amount,
        allocations: Object.entries(alokasi).map(([invoice_id, amount]) => ({
          invoice_id,
          amount,
        })),
      });
      setRes(r);
      if (r.ok) {
        setAmount("");
        setReference("");
        setAlokasi({});
        const f = await fakturPembelianTerbuka(supplier);
        if (Array.isArray(f)) setFaktur(f);
        router.refresh();
      }
    });

  const lebihDariSisa = faktur.some(
    (f) => (Number(alokasi[f.invoice_id]) || 0) > Number(f.sisa)
  );
  const bolehKirim =
    !pending && supplier !== "" && uang > 0 && uangMuka >= 0 && !lebihDariSisa;

  return (
    <div className="space-y-6">
      <div className="card p-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <label className="block">
            <span className="mb-1 block text-xs text-muted">Tanggal</span>
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
            <span className="mb-1 block text-xs text-muted">Cara bayar</span>
            <select
              className="field"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              <option value="TRANSFER">Transfer</option>
              <option value="CASH">Tunai</option>
              <option value="GIRO">Giro</option>
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs text-muted">Jumlah dibayar</span>
            <input
              className="field tnum"
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
        </div>

        <label className="mt-4 block">
          <span className="mb-1 block text-xs text-muted">
            Referensi bank <span className="text-muted">(opsional)</span>
          </span>
          <input
            className="field"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Nomor transfer, nomor giro, atau catatan penelusuran"
          />
        </label>
      </div>

      <div className="card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Alokasi ke faktur pembelian</h2>
          <button
            type="button"
            className="btn-ghost"
            onClick={isiOtomatis}
            disabled={faktur.length === 0 || uang <= 0}
          >
            Isi dari yang terlama
          </button>
        </div>

        {!supplier ? (
          <Empty text="Pilih pemasok untuk melihat faktur yang belum lunas." />
        ) : memuat ? (
          <p className="py-6 text-center text-sm text-muted">Memuat faktur…</p>
        ) : faktur.length === 0 ? (
          <Empty
            text={
              "Pemasok ini tidak punya faktur yang belum lunas. Pembayaran " +
              "tetap bisa diposting dan seluruhnya akan dicatat sebagai Uang " +
              "Muka Pembelian."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] border-collapse text-sm">
              <thead>
                <tr>
                  <th className="th">Faktur</th>
                  <th className="th">Tanggal</th>
                  <th className="th text-right">Nilai</th>
                  <th className="th text-right">Sudah dibayar</th>
                  <th className="th text-right">Sisa</th>
                  <th className="th text-right">Alokasi</th>
                </tr>
              </thead>
              <tbody>
                {faktur.map((f) => {
                  const nilai = Number(alokasi[f.invoice_id]) || 0;
                  const lebih = nilai > Number(f.sisa);
                  return (
                    <tr key={f.invoice_id}>
                      <td className="td">
                        <span className="block font-medium">{f.doc_no}</span>
                        {f.supplier_ref && (
                          <span className="block text-xs text-muted">
                            ref {f.supplier_ref}
                          </span>
                        )}
                      </td>
                      <td className="td text-muted">
                        {f.doc_date}
                        {Number(f.hari_sejak_faktur) > 0 && (
                          <span className="ml-2 text-xs">
                            {f.hari_sejak_faktur} hari lalu
                          </span>
                        )}
                      </td>
                      <td className="td td-num tnum">{rp(f.total)}</td>
                      <td className="td td-num tnum text-muted">{rp(f.dibayar)}</td>
                      <td className="td td-num tnum">{rp(f.sisa)}</td>
                      <td className="td td-num">
                        <input
                          className="field tnum w-36 text-right"
                          type="number"
                          min="0"
                          max={f.sisa}
                          step="0.01"
                          aria-label={"Alokasi untuk faktur " + f.doc_no}
                          aria-invalid={lebih || undefined}
                          value={alokasi[f.invoice_id] ?? ""}
                          onChange={(e) =>
                            setAlokasi((a) => ({
                              ...a,
                              [f.invoice_id]: e.target.value,
                            }))
                          }
                        />
                        {lebih && (
                          <p role="alert" className="mt-1 text-xs text-danger">
                            melebihi sisa
                          </p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-end justify-between gap-4 border-t border-line pt-4">
          <dl className="grid gap-x-8 gap-y-1 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted">Uang dibayarkan</dt>
              <dd className="tnum font-medium">{rp(uang)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Dialokasikan</dt>
              <dd className="tnum font-medium">{rp(totalAlokasi)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">
                {uangMuka < 0 ? "Kurang" : "Uang muka pembelian"}
              </dt>
              <dd
                className={
                  "tnum font-medium " + (uangMuka < 0 ? "text-danger" : "")
                }
              >
                {rp(Math.abs(uangMuka))}
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
            {pending ? "Memposting…" : "Simpan & posting"}
          </button>
        </div>

        {uangMuka < 0 && (
          <p role="alert" className="mt-3 text-sm text-danger">
            Alokasi melebihi uang yang dibayarkan sebesar {rp(-uangMuka)}.
          </p>
        )}
        {uangMuka > 0 && totalAlokasi > 0 && (
          <p className="mt-3 text-xs text-muted">
            Sisa {rp(uangMuka)} dicatat sebagai Uang Muka Pembelian — aset, bukan
            beban. Uang yang sudah keluar tapi belum punya faktur adalah hak
            tagih kepada pemasok.
          </p>
        )}
      </div>

      {res && <FormMessage res={res} />}
    </div>
  );
}
