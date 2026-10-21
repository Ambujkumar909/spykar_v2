// ─── War Room · Snap — the network broken down by any store dimension ───────
import { useMemo, useState } from 'react';
import { CalendarDays, CalendarRange, CalendarClock } from 'lucide-react';
import { Card, Seg, Delta } from './ui';
import { sumPeriods, kpis, growth, groupStores, isActive, inr, num, share, fmtRange } from './wrMath';

const BY = [
  { value: 'wr_region', label: 'Region' }, { value: 'state', label: 'State' }, { value: 'city', label: 'City' }, { value: 'wr_type', label: 'Type' },
  { value: 'wr_status', label: 'Status' }, { value: 'wr_asm', label: 'ASM' }, { value: 'wr_channel', label: 'Channel' },
];

export default function SnapView({ board, stores, onFilter }) {
  const [by, setBy] = useState('wr_region');
  const P = board.periods;
  const groups = useMemo(() => groupStores(stores, by).map((g) => ({ ...g, A: sumPeriods(g.stores), act: g.stores.filter(isActive).length }))
    .sort((a, b) => b.A.mtd[1] - a.A.mtd[1]), [stores, by]);
  const all = useMemo(() => ({ key: 'TOTAL', stores, A: sumPeriods(stores), act: stores.filter(isActive).length }), [stores]);
  const G = (a, b) => <Delta v={growth(a, b)} size="sm" />;
  const dlt = (a, b) => <span className={a - b >= 0 ? 'pos' : 'neg'}>{a - b >= 0 ? '+' : ''}{inr(a - b)}</span>;
  const contrib = (g, p, l) => { const D = all.A[p][1] - all.A[l][1]; return D ? share((g.A[p][1] - g.A[l][1]) / Math.abs(D)) : '—'; };
  const R = (g, cells, isTot) => (
    <tr key={g.key} className={isTot ? 'wr-total' : ''} onClick={isTot ? undefined : () => onFilter(by, [g.key])}>
      <td><b>{isTot ? 'Total' : g.key}</b><em>{g.act}/{g.stores.length}</em></td>{cells}
    </tr>
  );
  const week = (g) => { const k = kpis(g.A.cw); const kl = kpis(g.A.ly); return R(g, [
    <td key="1">{num(g.A.cw[0])}</td>, <td key="2"><b>{inr(g.A.cw[1])}</b></td>, <td key="3">{inr(g.A.pw[1])}</td>, <td key="4">{inr(g.A.ly[1])}</td>,
    <td key="5">{G(g.A.cw[1], g.A.pw[1])}</td>, <td key="6">{G(g.A.cw[1], g.A.ly[1])}</td>, <td key="7">{dlt(g.A.cw[1], g.A.ly[1])}</td>,
    <td key="8">{g.key === 'TOTAL' ? '100%' : contrib(g, 'cw', 'ly')}</td>,
    <td key="9">{num(k.bills)}</td>, <td key="10">{G(k.bills, kl.bills)}</td>, <td key="11">{inr(k.atv, { compact: false })}</td>,
  ], g.key === 'TOTAL'); };
  const mtd = (g) => { const k = kpis(g.A.mtd); const kl = kpis(g.A.mtdly); return R(g, [
    <td key="1">{num(g.A.mtd[0])}</td>, <td key="2"><b>{inr(g.A.mtd[1])}</b></td>, <td key="3">{num(g.A.mtdly[0])}</td>, <td key="4">{inr(g.A.mtdly[1])}</td>,
    <td key="5">{G(g.A.mtd[1], g.A.mtdly[1])}</td>, <td key="6">{dlt(g.A.mtd[1], g.A.mtdly[1])}</td>, <td key="7">{g.key === 'TOTAL' ? '100%' : contrib(g, 'mtd', 'mtdly')}</td>,
    <td key="8">{num(k.upt, 2)}</td>, <td key="9">{inr(k.asp, { compact: false })}</td>, <td key="10">{share(k.disc)}</td>, <td key="11">{share(kl.disc)}</td>,
  ], g.key === 'TOTAL'); };
  const ytd = (g) => { const k = kpis(g.A.ytd); const kl = kpis(g.A.ytdly); return R(g, [
    <td key="1">{num(g.A.ytd[0])}</td>, <td key="2">{num(g.A.ytdly[0])}</td>, <td key="3"><b>{inr(g.A.ytd[1])}</b></td>, <td key="4">{inr(g.A.ytdly[1])}</td>,
    <td key="5">{G(g.A.ytd[1], g.A.ytdly[1])}</td>, <td key="6">{dlt(g.A.ytd[1], g.A.ytdly[1])}</td>, <td key="7">{inr(g.A.ytd[2])}</td>, <td key="8">{G(g.A.ytd[2], g.A.ytdly[2])}</td>,
    <td key="9">{share(k.disc)}</td>, <td key="10">{num(k.bills)}</td>, <td key="11">{G(k.bills, kl.bills)}</td>,
  ], g.key === 'TOTAL'); };
  const T = (head, fn) => (
    <div className="wr-tablewrap"><table className="wr-table wr-snap">
      <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{fn(all)}{groups.map(fn)}</tbody>
    </table></div>
  );
  return (
    <div className="wr-view">
      <div className="wr-snapbar"><Seg value={by} onChange={setBy} options={BY} /></div>
      <Card icon={CalendarDays} eyebrow={`${fmtRange(P.cw)} · PW ${fmtRange(P.pw)} · LY ${fmtRange(P.ly, true)}`} title="Week">
        {T(['', 'Units', 'Net ₹', 'PW ₹', 'LY ₹', 'vs PW', 'vs LY', 'Δ ₹', 'Share of Δ', 'Bills', 'Bills Δ', 'ATV'], week)}
      </Card>
      <Card icon={CalendarRange} eyebrow={`${fmtRange(P.mtd)} · LY ${fmtRange(P.mtdly, true)}`} title="MTD">
        {T(['', 'Units', 'Net ₹', 'LY units', 'LY ₹', 'Δ', 'Δ ₹', 'Share of Δ', 'UPT', 'ASP', 'Disc', 'LY disc'], mtd)}
      </Card>
      <Card icon={CalendarClock} eyebrow={`${fmtRange(P.ytd)} · LY ${fmtRange(P.ytdly, true)}`} title="YTD">
        {T(['', 'Units', 'LY units', 'Net ₹', 'LY ₹', 'Δ', 'Δ ₹', 'MRP ₹', 'MRP Δ', 'Disc', 'Bills', 'Bills Δ'], ytd)}
      </Card>
    </div>
  );
}
