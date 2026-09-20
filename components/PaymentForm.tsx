"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FormMessage } from "./FormMessage";
import { Empty } from "./ui";
import { fakturTerbuka, saveAndPostPayment } from "@/app/actions";
import type { ActionResult } from "@/app/actions";

type Option = { id: string; label: string };

type Faktur = {
  invoice_id: string;
  doc_no: string;
  doc_date: string;
  due_date: string | null;
  total: string;
  dibayar: string;
  sisa: string;
  hari_lewat: string;
};

const rp = (v: unknown) =>
  "Rp " + new Intl.NumberFormat("id-ID").format(Math.round(Number(v) || 0));

/**
 * Formulir penerimaan pembayaran.
 *
 * Daftar faktur diambil ulang dari server setiap kali pelanggan berganti,
 * BUKAN dikirim seluruhnya sejak awal: sisa tagihan bisa berubah karena
 * orang lain memposting pembayaran sementara formulir ini terbuka.
 *
 * Yang divalidasi di sini hanya untuk kenyamanan. Penolakan yang
 * sebenarnya terjadi di lib/posting.ts, di dalam transaksi dan di bawah
 * kunci per faktur — satu-satunya tempat di mana "sisa tagihan" masih
 * bisa dipercaya saat dipakai.
 */
export function PaymentForm({
  customers,
  today,
}: {
  customers: Option[];
  today: string;
}) {
  const router = useRouter();

  const [docDate, setDocDate] = useState(today);
  const [customer, setCustomer] = useState("");
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
    if (!customer) {
      setFaktur([]);
      setAlokasi({});
      return;
    }
    setMemuat(true);
    fakturTerbuka(customer)
      .then((f) => {
        if (batal) return;
        // Pembungkus denganPeran() bisa mengembalikan penolakan alih-alih
        // data. Bentuknya dibedakan di sini, bukan dipaksa dengan cast:
        // sesi yang berakhir di tengah pekerjaan adalah keadaan normal,
        // dan pengguna berhak tahu alasannya.
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
  }, [customer]);

  const totalAlokasi = Object.values(alokasi).reduce(
    (s, v) => s + (Number(v) || 0),
    0
  );
  const uang = Number(amount) || 0;
  const titipan = uang - totalAlokasi;

  /** Mengisi alokasi otomatis dari faktur terlama sampai uangnya habis. */
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
      const r = await saveAndPostPayment({
        doc_date: docDate,
        customer_id: customer,
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
        const f = await fakturTerbuka(customer);
        if (Array.isArray(f)) setFaktur(f);
        router.refresh();
      }
    });

  const lebihDariSisa = faktur.some(
    (f) => (Number(alokasi[f.invoice_id]) || 0) > Number(f.sisa)
  );
  const bolehKirim =
    !pending && customer !== "" && uang > 0 && titipan >= 0 && !lebihDariSisa;

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
            <span className="mb-1 block text-xs text-muted">Pelanggan</span>
            <select
              className="field"
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
            >
              <option value="">— pilih —</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
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
            <span className="mb-1 block text-xs text-muted">Jumlah diterima</span>
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
            placeholder="Nomor mutasi, nomor giro, atau catatan penelusuran"
          />
        </label>
      </div>

      <div className="card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Alokasi ke faktur</h2>
          <button
            type="button"
            className="btn-ghost"
            onClick={isiOtomatis}
            disabled={faktur.length === 0 || uang <= 0}
          >
            Isi dari yang terlama
          </button>
        </div>

        {!customer ? (
          <Empty text="Pilih pelanggan untuk melihat faktur yang masih terbuka." />
        ) : memuat ? (
          <p className="py-6 text-center text-sm text-muted">Memuat faktur…</p>
        ) : faktur.length === 0 ? (
          <Empty
            text={
              "Pelanggan ini tidak punya faktur yang belum lunas. " +
              "Pembayaran tetap bisa diposting dan seluruhnya akan masuk " +
              "Titipan Pelanggan."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr>
                  <th className="th">Faktur</th>
                  <th className="th">Jatuh tempo</th>
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
                      <td className="td font-medium">{f.doc_no}</td>
                      <td className="td text-muted">
                        {f.due_date ?? f.doc_date}
                        {Number(f.hari_lewat) > 0 && (
                          <span className="ml-2 text-xs text-warning">
                            lewat {f.hari_lewat} hari
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
              <dt className="text-xs text-muted">Uang diterima</dt>
              <dd className="tnum font-medium">{rp(uang)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Dialokasikan</dt>
              <dd className="tnum font-medium">{rp(totalAlokasi)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">
                {titipan < 0 ? "Kurang" : "Titipan pelanggan"}
              </dt>
              <dd
                className={
                  "tnum font-medium " + (titipan < 0 ? "text-danger" : "")
                }
              >
                {rp(Math.abs(titipan))}
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

        {titipan < 0 && (
          <p role="alert" className="mt-3 text-sm text-danger">
            Alokasi melebihi uang yang diterima sebesar {rp(-titipan)}.
          </p>
        )}
        {titipan > 0 && totalAlokasi > 0 && (
          <p className="mt-3 text-xs text-muted">
            Sisa {rp(titipan)} akan dicatat sebagai Titipan Pelanggan — kewajiban,
            bukan pendapatan. Uang itu bisa dipakai untuk faktur berikutnya.
          </p>
        )}
      </div>

      {res && <FormMessage res={res} />}
    </div>
  );
}
