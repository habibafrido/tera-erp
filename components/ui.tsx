import type { ReactNode } from "react";

/**
 * Primitif tampilan bersama.
 *
 * Tidak ada satu pun warna literal di berkas ini. Semua kelas warna
 * (text-muted, bg-surface, border-line, …) berasal dari token yang
 * didefinisikan di app/globals.css, sehingga tema berganti tanpa varian
 * `dark:` di mana pun.
 */

export function PageHeader({ title, desc, action }: {
  title: string;
  desc?: string;
  action?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {desc && <p className="mt-1 max-w-2xl text-sm text-muted">{desc}</p>}
      </div>
      {action}
    </header>
  );
}

export function Empty({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-sm text-muted">{text}</p>
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  );
}

const TONES = {
  muted: "border-line text-muted",
  positive: "border-positive/40 text-positive",
  warning: "border-warning/50 text-warning",
  danger: "border-danger/50 text-danger",
} as const;

export type Tone = keyof typeof TONES;

export function Badge({ children, tone = "muted" }: {
  children: ReactNode;
  tone?: Tone;
}) {
  return (
    <span
      className={
        "tnum inline-block rounded border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap " +
        TONES[tone]
      }
    >
      {children}
    </span>
  );
}

/** Status dokumen dipetakan ke warna yang sama di semua halaman. */
export function StatusBadge({ status }: { status: string }) {
  const tone: Tone =
    status === "POSTED" ? "positive" : status === "CANCELLED" ? "danger" : "muted";
  const label =
    status === "POSTED" ? "Terposting" : status === "CANCELLED" ? "Dibatalkan" : "Draf";
  return <Badge tone={tone}>{label}</Badge>;
}

/**
 * Pita angka ringkasan. Menggantikan kartu-kartu terpisah supaya angka
 * utama terbaca sebagai satu baris, bukan sebagai beberapa kotak sejajar.
 * Di lebar ponsel pita menumpuk jadi satu kolom.
 */
export function StatBand({ items }: {
  items: { label: string; value: ReactNode; hint?: string }[];
}) {
  return (
    <div className="card mb-6 grid gap-px overflow-hidden bg-line sm:grid-cols-2 lg:grid-cols-3">
      {items.map((s) => (
        <div key={s.label} className="bg-surface px-5 py-4">
          <div className="text-xs text-muted">{s.label}</div>
          <div className="tnum mt-1 font-mono text-2xl font-semibold tracking-tight">
            {s.value}
          </div>
          {s.hint && <div className="mt-0.5 text-xs text-muted">{s.hint}</div>}
        </div>
      ))}
    </div>
  );
}

/** Kartu bersudut dengan kepala opsional. Bentuk dasar setiap blok isi. */
export function Panel({ title, meta, action, children, className = "" }: {
  title?: string;
  meta?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={"card overflow-hidden " + className}>
      {(title || meta || action) && (
        <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          <div className="flex items-baseline gap-3">
            {meta && <span className="text-xs text-muted">{meta}</span>}
            {action}
          </div>
        </header>
      )}
      {children}
    </section>
  );
}

/**
 * Tabel lebar menggeser di dalam wadahnya sendiri, bukan menggeser seluruh
 * halaman. `min` adalah lebar minimum tabel dalam piksel; di bawah itu
 * barulah muncul geseran mendatar.
 */
export function TableWrap({ children, min }: { children: ReactNode; min?: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full" style={min ? { minWidth: min } : undefined}>
        {children}
      </table>
    </div>
  );
}

/**
 * Sel angka. Selalu mono, rata kanan, dan lebar digit tetap supaya kolom
 * angka sejajar. `credit` menandai kolom kredit pada jurnal — nilainya
 * diredupkan agar debit dan kredit bisa dibedakan sekilas tanpa warna
 * tambahan.
 */
export function Num({ children, credit, strong, muted, colSpan }: {
  children: ReactNode;
  credit?: boolean;
  strong?: boolean;
  muted?: boolean;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={
        "tnum td text-right font-mono" +
        (strong ? " font-semibold" : "") +
        (credit || muted ? " text-muted" : "")
      }
    >
      {children}
    </td>
  );
}

/** Nomor dokumen, SKU, kode akun. Inline supaya bisa dipakai di dalam sel. */
export function Code({ children }: { children: ReactNode }) {
  return <code className="tnum font-mono text-xs">{children}</code>;
}

/** Sel nama dengan baris keterangan kecil di bawahnya (biasanya SKU). */
export function NameCell({ name, sub }: { name: ReactNode; sub?: ReactNode }) {
  return (
    <td className="td">
      <div className="font-medium">{name}</div>
      {sub && <div className="tnum mt-0.5 font-mono text-xs text-muted">{sub}</div>}
    </td>
  );
}
