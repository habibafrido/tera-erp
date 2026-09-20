import { geserRentang, labaRugi, tanggalAcuan } from "@/lib/laporan-keuangan";
import { Empty, PageHeader, Panel, StatBand } from "@/components/ui";
import { TabelKeuangan } from "@/components/laporan/TabelKeuangan";
import { TombolEkspor } from "@/components/TombolEkspor";
import { rupiah, tanggal } from "@/lib/format";

export const dynamic = "force-dynamic";

const TGL = /^\d{4}-\d{2}-\d{2}$/;

export default async function LabaRugiPage({
  searchParams,
}: {
  searchParams: Promise<{ dari?: string; sampai?: string; banding?: string }>;
}) {
  const sp = await searchParams;
  const acuan = await tanggalAcuan();

  // Tanggal tetap berupa teks sepanjang jalurnya, tidak pernah objek Date.
  const dari = TGL.test(sp.dari ?? "") ? sp.dari! : acuan.awalBulan;
  const sampai = TGL.test(sp.sampai ?? "") ? sp.sampai! : acuan.hariIni;
  const satuan = sp.banding === "tahun" ? "tahun" : "bulan";

  const banding = await geserRentang(dari, sampai, satuan);
  const lr = await labaRugi(dari, sampai, banding.dari, banding.sampai);

  const labelPeriode = `${tanggal(dari)} – ${tanggal(sampai)}`;
  const labelPembanding = `${tanggal(banding.dari)} – ${tanggal(banding.sampai)}`;
  const marginPersen =
    lr.totalPendapatan === 0 ? null : (lr.laba / lr.totalPendapatan) * 100;
  const awalTahun = sampai.slice(0, 4) + "-01-01";

  return (
    <>
      <PageHeader
        title="Laba Rugi"
        desc="Pergerakan pendapatan dan beban di dalam rentang tanggal — bukan akumulasi. Pendapatan bersaldo normal kredit, beban bersaldo normal debit; keduanya tampil positif saat searah dengan saldo normalnya."
        action={
          <TombolEkspor
            laporan="laba_rugi"
            filter={{ dari, sampai, banding: satuan }}
          />
        }
      />

      <form method="get" className="card mb-6 flex flex-wrap items-end gap-4 p-4">
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Dari</span>
          <input className="field" type="date" name="dari" defaultValue={dari} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Sampai</span>
          <input className="field" type="date" name="sampai" defaultValue={sampai} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Bandingkan dengan</span>
          <select className="field" name="banding" defaultValue={satuan}>
            <option value="bulan">Periode yang sama bulan lalu</option>
            <option value="tahun">Periode yang sama tahun lalu</option>
          </select>
        </label>
        <button type="submit" className="btn">Tampilkan</button>
      </form>

      <StatBand
        items={[
          { label: "Pendapatan", value: rupiah(lr.totalPendapatan), hint: labelPeriode },
          { label: "Beban", value: rupiah(lr.totalBeban) },
          {
            label: lr.laba < 0 ? "Rugi" : "Laba",
            value: rupiah(lr.laba),
            hint:
              marginPersen === null
                ? "tidak ada pendapatan"
                : `margin ${marginPersen.toFixed(1)}%`,
          },
          {
            label: "Laba pembanding",
            value: rupiah(lr.bandingLaba),
            hint: labelPembanding,
          },
        ]}
      />

      <Panel className="mb-6" title="Pendapatan" meta={labelPeriode}>
        {lr.pendapatan.length === 0 ? (
          <Empty text="Belum ada pendapatan pada periode ini." />
        ) : (
          <TabelKeuangan
            baris={lr.pendapatan}
            labelPeriode={labelPeriode}
            labelPembanding={labelPembanding}
            jumlah={{
              label: "Total pendapatan",
              nilai: lr.totalPendapatan,
              pembanding: lr.bandingPendapatan,
            }}
          />
        )}
      </Panel>

      <Panel className="mb-6" title="Beban" meta={labelPeriode}>
        {lr.beban.length === 0 ? (
          <Empty text="Belum ada beban pada periode ini." />
        ) : (
          <TabelKeuangan
            baris={lr.beban}
            labelPeriode={labelPeriode}
            labelPembanding={labelPembanding}
            jumlah={{
              label: "Total beban",
              nilai: lr.totalBeban,
              pembanding: lr.bandingBeban,
            }}
          />
        )}
      </Panel>

      <Panel title={lr.laba < 0 ? "Rugi bersih" : "Laba bersih"} meta={labelPeriode}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead>
              <tr>
                <th className="th">Perhitungan</th>
                <th className="th text-right">{labelPeriode}</th>
                <th className="th text-right">{labelPembanding}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="td">Total pendapatan</td>
                <td className="td td-num tnum">{rupiah(lr.totalPendapatan)}</td>
                <td className="td td-num tnum text-muted">
                  {rupiah(lr.bandingPendapatan)}
                </td>
              </tr>
              <tr>
                <td className="td">Dikurangi total beban</td>
                <td className="td td-num tnum">({rupiah(lr.totalBeban)})</td>
                <td className="td td-num tnum text-muted">
                  ({rupiah(lr.bandingBeban)})
                </td>
              </tr>
              <tr className="border-t border-line">
                <td className="td font-semibold">
                  {lr.laba < 0 ? "Rugi bersih" : "Laba bersih"}
                </td>
                <td className="td td-num tnum font-semibold">{rupiah(lr.laba)}</td>
                <td className="td td-num tnum text-muted">{rupiah(lr.bandingLaba)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted">
          Angka ini masuk ke Neraca sebagai laba periode berjalan bila rentangnya
          dimulai dari awal tahun buku. Neraca menghitungnya sendiri dari{" "}
          {tanggal(awalTahun)} sampai tanggal neracanya, jadi keduanya hanya akan
          sama bila rentang di sini juga dimulai dari awal tahun.
        </p>
      </Panel>
    </>
  );
}
