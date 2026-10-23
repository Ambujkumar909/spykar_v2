// ─── War Room · League — every store, sortable, one row each ─────────────────
import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Search, CheckCircle2, CircleDashed, Flame } from 'lucide-react';
import { Spark, StatusPill, Delta } from './ui';
import { kpis, growth, statusOf, reviewed, streak, weekRanks, inr, num, pct, share, sumPeriods, sumTargets, achTone } from './wrMath';

const COLS = [
  { k: 'rank', l: '#', w: 44, sort: (r) => r.rank ?? 9999 },
  { k: 'move', l: 'Δ rank', sub: 'vs PW', w: 64, sort: (r) => r.move ?? -9999 },
  { k: 'store', l: 'Store', w: 250, sort: (r) => r.s.name },
  { k: 'region', l: 'Region', w: 96, sort: (r) => `${r.s.region}` },
  { k: 'status', l: 'Status', w: 92, sort: (r) => ['Critical', 'Degrowth', 'Soft', 'Stable', 'Growth', 'New', 'Closed'].indexOf(r.status) },
  { k: 'cw', l: 'Week', sub: 'CW / LY', w: 120, sort: (r) => r.cw },
  { k: 'cwg', l: 'YoY', w: 74, sort: (r) => r.cwg ?? -9 },
  { k: 'mtd', l: 'MTD', sub: 'TY / LY', w: 120, sort: (r) => r.mtd },
  { k: 'mtdg', l: 'MTD GoLY', w: 76, sort: (r) => r.mtdg ?? -9 },
  { k: 'ach', l: 'MTD Ach%', sub: 'of Tgt', w: 76, sort: (r) => r.ach ?? -9 },
  { k: 'ytd', l: 'YTD', sub: 'TY / LY', w: 120, sort: (r) => r.ytd },
  { k: 'ytdg', l: 'YTD GoLY', w: 76, sort: (r) => r.ytdg ?? -9 },
  { k: 'bills', l: 'NOB', sub: 'MTD', w: 92, sort: (r) => r.k.bills ?? -1 },
  { k: 'upt', l: 'UPT', w: 60, sort: (r) => r.k.upt ?? -1 },
  { k: 'atv', l: 'ATV', w: 80, sort: (r) => r.k.atv ?? -1 },
  { k: 'disc', l: 'Disc', sub: 'MTD', w: 64, sort: (r) => r.k.disc ?? -1 },
  { k: 'streak', l: 'Below LY', sub: 'weeks', w: 72, sort: (r) => r.streak },
  { k: 'trend', l: '13 wks', w: 100, sort: (r) => r.trend },
  { k: 'rev', l: 'Rev', w: 52, sort: (r) => (r.rev ? 1 : 0) },
];
const heat = (g) => {
  if (g == null || !Number.isFinite(g)) return undefined;
  const a = Math.min(0.30, 0.05 + Math.abs(g) * 0.55);
  return { background: g >= 0 ? `rgba(16,185,129,${a})` : `rgba(239,68,68,${a})` };
};

export default function LeagueView({ stores, measure, onOpen }) {
  const [sort, setSort] = useState({ k: 'rank', dir: 1 });
  const [q, setQ] = useState('');
  const I = measure === 'qty' ? 0 : 1;
  const fmtM = measure === 'qty' ? (v) => num(v) : (v) => inr(v);
  const rows = useMemo(() => {
    const ranks = weekRanks(stores);
    return stores.map((s) => {
      const k = kpis(s.m.mtd); const kl = kpis(s.m.mtdly); const r = ranks[s.code];
      return {
        s, status: statusOf(s), rev: reviewed(s), k, kl, rank: r?.now, move: r?.move, streak: streak(s),
        cw: s.m.cw[I], cwly: s.m.ly[I], cwg: growth(s.m.cw[I], s.m.ly[I]),
        mtd: s.m.mtd[I], mtdly: s.m.mtdly[I], mtdg: growth(s.m.mtd[I], s.m.mtdly[I]),
        ach: s.t && s.t.mtd && s.t.mtd[I] ? s.m.mtd[I] / s.t.mtd[I] : null,
        ytd: s.m.ytd[I], ytdly: s.m.ytdly[I], ytdg: growth(s.m.ytd[I], s.m.ytdly[I]),
        trend: s.wk.slice(-5, -1).reduce((a, b) => a + b, 0) - s.wkly.slice(-5, -1).reduce((a, b) => a + b, 0),
      };
    });
  }, [stores, I]);
  const shown = useMemo(() => {
    const col = COLS.find((c) => c.k === sort.k) || COLS[0];
    const qq = q.trim().toLowerCase();
    return rows.filter((r) => !qq || `${r.s.code} ${r.s.name} ${r.s.city} ${r.s.region} ${r.s.asm}`.toLowerCase().includes(qq))
      .sort((a, b) => { const x = col.sort(a); const y = col.sort(b); return (x > y ? 1 : x < y ? -1 : 0) * sort.dir; });
  }, [rows, sort, q]);
  const A = useMemo(() => sumPeriods(stores), [stores]); const tk = kpis(A.mtd);
  const TT = useMemo(() => sumTargets(stores), [stores]); const tach = TT.cover && TT.mtd[I] ? A.mtd[I] / TT.mtd[I] : null;
  const click = (k) => setSort((s) => (s.k === k ? { k, dir: -s.dir } : { k, dir: ['store', 'region', 'rank', 'status'].includes(k) ? 1 : -1 }));

  return (
    <div className="wr-view">
      <div className="wr-league-bar">
        <div className="wr-search"><Search size={14} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Store, code, city, region, ASM" aria-label="Search stores" /></div>
        <span className="wr-count">{num(shown.length)} stores · # = CW YoY</span>
      </div>
      <div className="wr-tablewrap">
        <table className="wr-table wr-league">
          <thead>
            <tr>{COLS.map((c) => (
              <th key={c.k} style={{ minWidth: c.w }} onClick={() => click(c.k)} className={sort.k === c.k ? 'on' : ''} aria-sort={sort.k === c.k ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
                <span>{c.l}{sort.k === c.k && (sort.dir > 0 ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}</span>{c.sub && <em>{c.sub}</em>}
              </th>))}
            </tr>
          </thead>
          <tbody>
            <tr className="wr-total">
              <td /><td /><td><b>Total</b><em>{num(stores.length)} stores</em></td><td /><td />
              <td><b>{fmtM(A.cw[I])}</b><em>{fmtM(A.ly[I])}</em></td><td style={heat(growth(A.cw[I], A.ly[I]))}>{pct(growth(A.cw[I], A.ly[I]))}</td>
              <td><b>{fmtM(A.mtd[I])}</b><em>{fmtM(A.mtdly[I])}</em></td><td style={heat(growth(A.mtd[I], A.mtdly[I]))}>{pct(growth(A.mtd[I], A.mtdly[I]))}</td>
              <td className={`wr-${achTone(tach)}`}>{tach == null ? '—' : share(tach, 0)}</td>
              <td><b>{fmtM(A.ytd[I])}</b><em>{fmtM(A.ytdly[I])}</em></td><td style={heat(growth(A.ytd[I], A.ytdly[I]))}>{pct(growth(A.ytd[I], A.ytdly[I]))}</td>
              <td>{num(tk.bills)}</td><td>{num(tk.upt, 2)}</td><td>{inr(tk.atv, { compact: false })}</td><td>{share(tk.disc)}</td><td /><td /><td />
            </tr>
            {shown.map((r) => (
              <tr key={r.s.code} onClick={() => onOpen(r.s.code)} className={r.rev ? 'is-rev' : ''} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(r.s.code); }}>
                <td className="mute">{r.rank ?? '—'}</td>
                <td className={r.move > 0 ? 'pos' : r.move < 0 ? 'neg' : 'mute'}>{r.move == null ? '—' : r.move > 0 ? `▲${r.move}` : r.move < 0 ? `▼${-r.move}` : '='}</td>
                <td><b>{r.s.name}</b><em>{r.s.code} · {r.s.city} · {r.s.type}{r.s.asm ? ` · ${r.s.asm}` : ''}</em></td>
                <td><span className="wr-tag">{r.s.region}</span><em>{r.s.state}</em></td>
                <td><StatusPill status={r.status} small /></td>
                <td><b>{fmtM(r.cw)}</b><em>{fmtM(r.cwly)}</em></td><td style={heat(r.cwg)}>{pct(r.cwg)}</td>
                <td><b>{fmtM(r.mtd)}</b><em>{fmtM(r.mtdly)}</em></td><td style={heat(r.mtdg)}>{pct(r.mtdg)}</td>
                <td className={`wr-${achTone(r.ach)}`}>{r.ach == null ? '—' : share(r.ach, 0)}</td>
                <td><b>{fmtM(r.ytd)}</b><em>{fmtM(r.ytdly)}</em></td><td style={heat(r.ytdg)}>{pct(r.ytdg)}</td>
                <td>{r.k.bills == null ? 'n/a' : num(r.k.bills)}<Delta v={growth(r.k.bills, r.kl.bills)} size="sm" /></td>
                <td>{num(r.k.upt, 2)}</td>
                <td>{inr(r.k.atv, { compact: false })}</td>
                <td>{share(r.k.disc)}</td>
                <td className={r.streak >= 3 ? 'neg' : 'mute'}>{r.streak ? <span className="wr-streak">{r.streak >= 3 && <Flame size={11} />}{r.streak}</span> : '—'}</td>
                <td><Spark ty={r.s.wk} ly={r.s.wkly} w={88} h={24} /></td>
                <td className="c">{r.rev ? <CheckCircle2 size={15} className="pos" /> : <CircleDashed size={15} className="mute" />}</td>
              </tr>))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
