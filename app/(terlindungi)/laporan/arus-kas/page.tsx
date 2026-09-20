import { arusKas, LABEL_KATEGORI } from "@/lib/arus-kas";
import { geserRentang, tanggalAcuan } from "@/lib/laporan-keuangan";
import { Badge, PageHeader, Panel, StatBand } from "@/components/ui";
import { TabelArusKas } from "@/components/laporan/TabelArusKas";
import { TombolEkspor } from "@/components/TombolEkspor";
import { rupiah, tanggal } from "@/lib/format";

export const dynamic = "force-dynamic";

const TGL = /^\d{4}-\d{2}-\d{2}$/;

export default async function ArusKasPage({
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
  const a = await arusKas(dari, sampai, banding.dari, banding.sampai);

  const labelPeriode = `${tanggal(dari)} – ${tanggal(sampai)}`;
  const labelPembanding = `${tanggal(banding.dari)} – ${tanggal(banding.sampai)}`;

  return (
    <>
      <PageHeader
        title="Arus Kas"
        desc="Metode langsung. Golongan setiap mutasi kas dibaca dari akun lawan di jurnal yang sama — bukan dari akun kasnya, karena kas untuk membeli mesin dan kas untuk membayar pemasok keluar dari akun yang sama."
        action={
          <TombolEkspor
            laporan="arus_kas"
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
          { label: "Saldo kas awal", value: rupiah(a.saldoAwal), hint: tanggal(dari) },
          { label: "Arus kas bersih", value: rupiah(a.totalArus), hint: labelPeriode },
          { label: "Saldo kas akhir", value: rupiah(a.saldoAkhir), hint: tanggal(sampai) },
          {
            label: "Selisih",
            value: rupiah(a.selisih),
            hint: a.seimbang ? "cocok" : "TIDAK cocok",
          },
        ]}
      />

      {!a.seimbang && (
        <div role="alert" className="card mb-6 p-4 text-sm">
          <strong className="text-danger">Arus kas tidak menutup.</strong> Saldo
          awal ditambah seluruh golongan menghasilkan{" "}
          {rupiah(a.saldoAwal + a.totalArus)}, sementara saldo kas menurut buku
          besar {rupiah(a.saldoAkhir)}. Selisih {rupiah(a.selisih)} berarti ada
          mutasi kas yang tidak tertangkap laporan ini.
        </div>
      )}

      {a.belumDigolongkan.length > 0 && (
        <div role="alert" className="card mb-6 p-4 text-sm">
          <strong className="text-danger">
            {a.belumDigolongkan.length} akun lawan belum punya golongan arus kas.
          </strong>{" "}
          Nilainya {rupiah(a.totalBelumDigolongkan)} dan sudah ikut dijumlahkan di
          bawah, tetapi tidak masuk golongan mana pun:{" "}
          {a.belumDigolongkan.map((b) => `${b.kode} ${b.nama}`).join(", ")}. Isi{" "}
          <code className="tnum">kategori_arus_kas</code> akun itu.
        </div>
      )}

      <Panel
        className="mb-6"
        title="Saldo kas awal periode"
        meta={`per ${tanggal(dari)}`}
        action={
          <Badge tone={a.seimbang ? "positive" : "danger"}>
            {a.seimbang ? "Menutup" : "Tidak menutup"}
          </Badge>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <tbody>
              <tr>
                <td className="td">Kas dan setara kas pada awal periode</td>
                <td className="td td-num tnum font-semibold">
                  {rupiah(a.saldoAwal)}
                </td>
                <td className="td td-num tnum text-muted">
                  {rupiah(a.bandingSaldoAwal)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel className="mb-6" title={LABEL_KATEGORI.OPERASI} meta={labelPeriode}>
        <TabelArusKas
          judul="Aktivitas operasi"
          baris={a.operasi}
          total={a.totalOperasi}
          bandingTotal={a.bandingTotalOperasi}
          labelPeriode={labelPeriode}
          labelPembanding={labelPembanding}
          kosong="Tidak ada mutasi kas dari aktivitas operasi pada periode ini."
        />
      </Panel>

      <Panel className="mb-6" title={LABEL_KATEGORI.INVESTASI} meta={labelPeriode}>
        <TabelArusKas
          judul="Aktivitas investasi"
          baris={a.investasi}
          total={a.totalInvestasi}
          bandingTotal={a.bandingTotalInvestasi}
          labelPeriode={labelPeriode}
          labelPembanding={labelPembanding}
          kosong="Tidak ada mutasi kas dari aktivitas investasi. Bagan akun belum punya akun aset tetap, jadi golongan ini memang masih kosong."
        />
      </Panel>

      <Panel className="mb-6" title={LABEL_KATEGORI.PENDANAAN} meta={labelPeriode}>
        <TabelArusKas
          judul="Aktivitas pendanaan"
          baris={a.pendanaan}
          total={a.totalPendanaan}
          bandingTotal={a.bandingTotalPendanaan}
          labelPeriode={labelPeriode}
          labelPembanding={labelPembanding}
          kosong="Tidak ada setoran modal maupun mutasi pinjaman pada periode ini."
        />
      </Panel>

      <Panel title="Saldo kas akhir periode" meta={`per ${tanggal(sampai)}`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr>
                <th className="th">Perhitungan</th>
                <th className="th text-right">{labelPeriode}</th>
                <th className="th text-right">{labelPembanding}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="td">Saldo kas awal</td>
                <td className="td td-num tnum">{rupiah(a.saldoAwal)}</td>
                <td className="td td-num tnum text-muted">
                  {rupiah(a.bandingSaldoAwal)}
                </td>
              </tr>
              <tr>
                <td className="td">Arus kas dari operasi</td>
                <td className="td td-num tnum">{rupiah(a.totalOperasi)}</td>
                <td className="td td-num tnum text-muted">
                  {rupiah(a.bandingTotalOperasi)}
                </td>
              </tr>
              <tr>
                <td className="td">Arus kas dari investasi</td>
                <td className="td td-num tnum">{rupiah(a.totalInvestasi)}</td>
                <td className="td td-num tnum text-muted">
                  {rupiah(a.bandingTotalInvestasi)}
                </td>
              </tr>
              <tr>
                <td className="td">Arus kas dari pendanaan</td>
                <td className="td td-num tnum">{rupiah(a.totalPendanaan)}</td>
                <td className="td td-num tnum text-muted">
                  {rupiah(a.bandingTotalPendanaan)}
                </td>
              </tr>
              {a.totalBelumDigolongkan !== 0 && (
                <tr>
                  <td className="td text-danger">Belum digolongkan</td>
                  <td className="td td-num tnum text-danger">
                    {rupiah(a.totalBelumDigolongkan)}
                  </td>
                  <td className="td td-num tnum text-muted">—</td>
                </tr>
              )}
              <tr className="border-t border-line">
                <td className="td font-semibold">
                  Saldo kas akhir
                  <span className="ml-2 text-xs font-normal text-muted">
                    dicocokkan dengan buku besar akun kas
                  </span>
                </td>
                <td className="td td-num tnum font-semibold">
                  {rupiah(a.saldoAkhir)}
                </td>
                <td className="td td-num tnum text-muted">
                  {rupiah(a.bandingSaldoAkhir)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted">
          Transfer antar rekening kas tidak muncul di sini: jurnalnya tidak punya
          baris lawan non-kas sama sekali, sehingga ia tidak menyumbang ke
          golongan mana pun — dan saldo total kas memang tidak berubah olehnya.
          Transfer yang membawa biaya administrasi tetap muncul, sebesar biayanya
          saja.
        </p>
      </Panel>
    </>
  );
}
