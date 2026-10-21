// ─── War Room panels shared by the network view and the store view ──────────
import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { CalendarDays, CalendarRange, CalendarClock, Boxes, Shirt, Scale, TrendingUp, Flame, Snail, CheckCircle2, Split, Waves, Gauge, Crosshair } from 'lucide-react';
import { Card, Delta, DualBar, Seg } from './ui';
import { kpis, growth, drivers, bridge, statusOf, isActive, inr, num, pct, share, pts, fmtRange, fmtDay, tone, STATUS_TONE } from './wrMath';

const Chart = dynamic(() => import('react-apexcharts'), { ssr: false });
const axis = (isDark) => ({ fg: isDark ? '#94A3B8' : '#64748B', grid: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.07)', gold: isDark ? '#E9C46A' : '#B7791F' });

// ── Week / MTD / YTD ─────────────────────────────────────────────────────────
function Row({ label, ty, ly, g, fmt, strong }) {
  return (
    <div className={`wr-prow${strong ? ' strong' : ''}`}>
      <span className="wr-prow-l">{label}</span>
      <span className="wr-prow-ty">{fmt(ty)}</span>
      <span className="wr-prow-ly">{fmt(ly)}</span>
      <span className="wr-prow-g"><Delta v={g} size="sm" /></span>
    </div>
  );
}
export function PeriodCard({ kind, P, A, measure }) {
  const cfg = {
    week: { title: 'Week', icon: CalendarDays, ty: 'cw', ly: 'ly', alt: 'pw', range: P.cw, lyRange: P.ly, accent: 'red' },
    mtd: { title: 'MTD', icon: CalendarRange, ty: 'mtd', ly: 'mtdly', range: P.mtd, lyRange: P.mtdly, accent: 'gold' },
    ytd: { title: 'YTD', icon: CalendarClock, ty: 'ytd', ly: 'ytdly', range: P.ytd, lyRange: P.ytdly, accent: 'violet' },
  }[kind];
  const ty = A[cfg.ty]; const ly = A[cfg.ly]; const alt = cfg.alt ? A[cfg.alt] : null;
  const KT = kpis(ty); const KL = kpis(ly);
  const I = measure === 'qty' ? 0 : 1;
  const fmtM = measure === 'qty' ? (v) => num(v) : (v) => inr(v);
  const dd = KT.disc != null && KL.disc != null ? KT.disc - KL.disc : null;
  const k4 = [['Bills', KT.bills, KL.bills, (v) => num(v)], ['UPT', KT.upt, KL.upt, (v) => num(v, 2)],
    ['ASP', KT.asp, KL.asp, (v) => inr(v, { compact: false })], ['ATV', KT.atv, KL.atv, (v) => inr(v, { compact: false })]];
  return (
    <Card className="wr-period" accent={cfg.accent} icon={cfg.icon} eyebrow={fmtRange(cfg.range)} title={cfg.title}
      right={<span className="wr-vs">LY {fmtRange(cfg.lyRange, true)}</span>}>
      <div className="wr-period-hero">
        <div className="wr-hero-v">{fmtM(ty[I])}</div>
        <div className="wr-hero-sub">
          <Delta v={growth(ty[I], ly[I])} label="LY" />
          {alt && <Delta v={growth(ty[I], alt[I])} label="PW" />}
        </div>
      </div>
      <div className="wr-ptable">
        <div className="wr-prow head"><span /><span>TY</span><span>LY</span><span>Δ</span></div>
        <Row label="Net sales" ty={ty[1]} ly={ly[1]} g={growth(ty[1], ly[1])} fmt={(v) => inr(v)} strong />
        <Row label="Units" ty={ty[0]} ly={ly[0]} g={growth(ty[0], ly[0])} fmt={(v) => num(v)} />
        <Row label="MRP" ty={ty[2]} ly={ly[2]} g={growth(ty[2], ly[2])} fmt={(v) => inr(v)} />
        <div className="wr-prow">
          <span className="wr-prow-l">Discount</span>
          <span className="wr-prow-ty">{share(KT.disc)}</span><span className="wr-prow-ly">{share(KL.disc)}</span>
          <span className="wr-prow-g"><span className={`wr-delta wr-delta-sm wr-${dd == null ? 'mute' : dd > 0.005 ? 'neg' : dd < -0.005 ? 'pos' : 'flat'}`}>{pts(dd)}</span></span>
        </div>
        {alt && <Row label={`PW ${fmtRange(P.pw)}`} ty={ty[1]} ly={alt[1]} g={growth(ty[1], alt[1])} fmt={(v) => inr(v)} />}
      </div>
      <div className="wr-kq">
        {k4.map(([l, a, b, f]) => (
          <div key={l} className="wr-kq-i"><span className="wr-kq-l">{l}</span><b>{a == null ? 'n/a' : f(a)}</b><Delta v={growth(a, b)} size="sm" /></div>
        ))}
      </div>
    </Card>
  );
}

// ── B · what moved sales: bills × UPT × ASP ──────────────────────────────────
export function DriversPanel({ A }) {
  const rows = [['Week', A.cw, A.ly], ['MTD', A.mtd, A.mtdly], ['YTD', A.ytd, A.ytdly]].map(([l, t, y]) => [l, drivers(t, y)]);
  return (
    <Card icon={Split} eyebrow="Net sales vs LY = bills × UPT × ASP" title="What moved sales">
      {rows.every(([, d]) => !d) ? <div className="wr-empty sm">Bills are not split by product.</div> : (
        <div className="wr-drv">
          <div className="wr-drv-r head"><span /><span>Sales</span><span>Bills</span><span>UPT</span><span>ASP</span></div>
          {rows.map(([l, d]) => (
            <div key={l} className="wr-drv-r">
              <span className="wr-drv-l">{l}</span>
              {d ? (
                <>
                  <span><b className={d.total >= 0 ? 'pos' : 'neg'}>{pct(d.total)}</b><em>{d.delta >= 0 ? '+' : ''}{inr(d.delta)}</em></span>
                  {d.parts.map((p) => (
                    <span key={p.k} className="wr-drv-c">
                      <i className={p.rs >= 0 ? 'pos' : 'neg'} style={{ width: `${Math.min(100, Math.abs(p.rs) / (Math.max(...d.parts.map((x) => Math.abs(x.rs))) || 1) * 100)}%` }} />
                      <b className={p.g >= 0 ? 'pos' : 'neg'}>{pct(p.g)}</b><em>{p.rs >= 0 ? '+' : ''}{inr(p.rs)}</em>
                    </span>
                  ))}
                </>
              ) : <span className="mute" style={{ gridColumn: '2 / -1' }}>—</span>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── C · growth bridge: LY → TY, by group ─────────────────────────────────────
export function BridgePanel({ stores, cats, measure, onFilter }) {
  const [by, setBy] = useState('wr_region'); const [period, setPeriod] = useState('mtd');
  const B = useMemo(() => bridge(stores, by, period, cats, measure), [stores, by, period, cats, measure]);
  const fmt = measure === 'qty' ? (v) => num(v) : (v) => inr(v);
  const max = Math.max(1, ...B.rows.map((r) => Math.abs(r.d)));
  const rows = B.rows.length > 14 ? [...B.rows.slice(0, 7), ...B.rows.slice(-7)] : B.rows;
  return (
    <Card icon={Waves} eyebrow={`${fmt(B.ly)} → ${fmt(B.ty)} · ${pct(growth(B.ty, B.ly))}`} title="Growth bridge"
      right={<><Seg size="sm" value={period} onChange={setPeriod} options={[{ value: 'cw', label: 'Week' }, { value: 'mtd', label: 'MTD' }, { value: 'ytd', label: 'YTD' }]} />
        <Seg size="sm" value={by} onChange={setBy} options={[{ value: 'wr_region', label: 'Region' }, { value: 'state', label: 'State' }, { value: 'wr_type', label: 'Type' }, { value: 'category', label: 'Category' }]} /></>}>
      <div className="wr-bridge">
        <div className="wr-br-r end"><span>LY</span><span /><b>{fmt(B.ly)}</b><span /></div>
        {rows.map((r) => (
          <button type="button" key={r.key} className="wr-br-r" onClick={by === 'category' || !onFilter ? undefined : () => onFilter(by, [r.key])}>
            <span className="wr-br-n">{r.key}</span>
            <span className="wr-br-bar"><i className={r.d >= 0 ? 'pos' : 'neg'} style={{ width: `${(Math.abs(r.d) / max) * 50}%`, [r.d >= 0 ? 'left' : 'right']: '50%' }} /></span>
            <b className={r.d >= 0 ? 'pos' : 'neg'}>{r.d >= 0 ? '+' : ''}{fmt(r.d)}</b>
            <em>{pct(r.g)}</em>
          </button>
        ))}
        <div className="wr-br-r end"><span>TY</span><span /><b>{fmt(B.ty)}</b><span /></div>
      </div>
    </Card>
  );
}

// ── D · month pace: cumulative net sales by day, TY vs LY ────────────────────
export function PacePanel({ days, P, isDark }) {
  const { fg, grid, gold } = axis(isDark);
  const cum = (a) => a.reduce((o, v, i) => { o.push((o[i - 1] || 0) + v); return o; }, []);
  const ty = cum(days.ty); const ly = cum(days.ly);
  const labels = days.ty.map((_, i) => String(i + 1));
  const opts = {
    chart: { type: 'line', toolbar: { show: false }, zoom: { enabled: false }, background: 'transparent', fontFamily: 'Inter, sans-serif', animations: { speed: 450 } },
    stroke: { width: [0, 0, 3, 2.5], curve: 'smooth', dashArray: [0, 0, 0, 5] },
    colors: ['rgba(225,29,72,0.55)', isDark ? 'rgba(148,163,184,0.35)' : 'rgba(100,116,139,0.30)', '#E11D48', gold],
    plotOptions: { bar: { columnWidth: '62%', borderRadius: 3 } },
    dataLabels: { enabled: false }, legend: { show: true, position: 'top', horizontalAlign: 'right', labels: { colors: fg } },
    grid: { borderColor: grid, strokeDashArray: 4 },
    xaxis: { categories: labels, labels: { style: { colors: fg, fontSize: '10px' } }, axisBorder: { show: false }, axisTicks: { show: false } },
    yaxis: [{ seriesName: 'Day', show: false }, { seriesName: 'Day', show: false },
      { seriesName: 'MTD', labels: { style: { colors: fg, fontSize: '10px' }, formatter: (v) => inr(v, { compact: true, decimals: 1 }) } }, { seriesName: 'MTD', show: false }],
    tooltip: { theme: isDark ? 'dark' : 'light', shared: true, intersect: false, y: { formatter: (v) => inr(v) } },
  };
  const g = growth(ty[ty.length - 1], ly[ly.length - 1]);
  return (
    <Card icon={Gauge} eyebrow={`${fmtRange(P.mtd)} vs ${fmtRange(P.mtdly, true)}`} title="Month pace"
      right={<span className="wr-vs">Day {ty.length} <Delta v={g} size="sm" /></span>}>
      <Chart type="line" height={240} options={opts} series={[
        { name: 'Day TY', type: 'column', data: days.ty.map(Math.round) }, { name: 'Day LY', type: 'column', data: days.ly.map(Math.round) },
        { name: 'MTD TY', type: 'line', data: ty.map(Math.round) }, { name: 'MTD LY', type: 'line', data: ly.map(Math.round) }]} />
    </Card>
  );
}

// ── E · 13-week trend ────────────────────────────────────────────────────────
export function TrendPanel({ weeks, weeksLy, series, isDark, title = '13 weeks' }) {
  const opts = useMemo(() => {
    const { fg, grid, gold } = axis(isDark);
    return {
      chart: { type: 'line', toolbar: { show: false }, zoom: { enabled: false }, animations: { enabled: true, speed: 500 }, fontFamily: 'Inter, sans-serif', background: 'transparent' },
      stroke: { width: [0, 2.5], curve: 'smooth', dashArray: [0, 5] },
      fill: { type: ['gradient', 'solid'], gradient: { shade: isDark ? 'dark' : 'light', type: 'vertical', shadeIntensity: 0.4, opacityFrom: 0.95, opacityTo: 0.55, stops: [0, 100] } },
      colors: ['#E11D48', gold],
      plotOptions: { bar: { columnWidth: '58%', borderRadius: 6, borderRadiusApplication: 'end' } },
      dataLabels: { enabled: false },
      grid: { borderColor: grid, strokeDashArray: 4, padding: { left: 6, right: 6 } },
      xaxis: { categories: weeks.map((w) => fmtDay(w[0])), labels: { style: { colors: fg, fontSize: '10px' }, rotate: 0, hideOverlappingLabels: true }, axisBorder: { show: false }, axisTicks: { show: false } },
      yaxis: { labels: { style: { colors: fg, fontSize: '10px' }, formatter: (v) => inr(v, { compact: true, decimals: 1 }) } },
      legend: { show: true, position: 'top', horizontalAlign: 'right', labels: { colors: fg }, markers: { size: 6 } },
      tooltip: {
        theme: isDark ? 'dark' : 'light', shared: true, intersect: false,
        x: { formatter: (_, { dataPointIndex }) => fmtRange(weeks[dataPointIndex]) },
        y: { formatter: (v, { dataPointIndex, seriesIndex }) => (seriesIndex === 0 ? `${inr(v)}  ${pct(growth(series.ty[dataPointIndex], series.ly[dataPointIndex]))}` : `${inr(v)}  ${fmtRange(weeksLy[dataPointIndex], true)}`) },
      },
    };
  }, [weeks, weeksLy, series, isDark]);
  const total = series.ty.reduce((a, b) => a + b, 0); const totalLy = series.ly.reduce((a, b) => a + b, 0);
  return (
    <Card className="wr-trend" icon={TrendingUp} eyebrow="Net sales by week" title={title}
      right={<span className="wr-vs">{inr(total)} <Delta v={growth(total, totalLy)} size="sm" /></span>}>
      <Chart type="line" height={240} options={opts}
        series={[{ name: 'TY', type: 'column', data: series.ty.map(Math.round) }, { name: 'LY', type: 'line', data: series.ly.map(Math.round) }]} />
    </Card>
  );
}

// ── I · size × growth quadrant ───────────────────────────────────────────────
export function QuadrantPanel({ stores, isDark, onOpen }) {
  const [period, setPeriod] = useState('mtd');
  const LY = { cw: 'ly', mtd: 'mtdly', ytd: 'ytdly' }[period];
  const pts_ = useMemo(() => stores.filter((s) => isActive(s) && s.m[LY][1] > 0).map((s) => ({
    x: Math.round(s.m[LY][1]), y: Math.max(-1, Math.min(1.5, growth(s.m[period][1], s.m[LY][1]))) * 100, s, st: statusOf(s),
  })), [stores, period, LY]);
  const medX = useMemo(() => { const xs = pts_.map((p) => p.x).sort((a, b) => a - b); return xs[Math.floor(xs.length / 2)] || 0; }, [pts_]);
  const quad = useMemo(() => {
    const q = { big_down: 0, big_up: 0, small_down: 0, small_up: 0 }; let atRisk = 0;
    for (const p of pts_) { const k = `${p.x >= medX ? 'big' : 'small'}_${p.y >= 0 ? 'up' : 'down'}`; q[k]++; if (k === 'big_down') atRisk += p.s.m[LY][1] - p.s.m[period][1]; }
    return { ...q, atRisk };
  }, [pts_, medX, period, LY]);
  const { fg, grid } = axis(isDark);
  const COLOR = { pos: '#10B981', info: '#60A5FA', warn: '#F59E0B', neg: '#FB7185', crit: '#E11D48', violet: '#A78BFA', mute: '#94A3B8' };
  const groups = ['Growth', 'Stable', 'Soft', 'Degrowth', 'Critical'];
  const series = groups.map((g) => ({ name: g, data: pts_.filter((p) => p.st === g).map((p) => ({ x: p.x, y: p.y, code: p.s.code, name: p.s.name })) }));
  const opts = {
    chart: { type: 'scatter', toolbar: { show: false }, zoom: { enabled: false }, background: 'transparent', fontFamily: 'Inter, sans-serif',
      events: { dataPointSelection: (e, ctx, { seriesIndex, dataPointIndex }) => { const d = series[seriesIndex]?.data[dataPointIndex]; if (d && onOpen) onOpen(d.code); } } },
    colors: groups.map((g) => COLOR[STATUS_TONE[g]]), markers: { size: 5, strokeWidth: 0, hover: { size: 7 } },
    grid: { borderColor: grid, strokeDashArray: 4 },
    xaxis: { type: 'numeric', tickAmount: 6, labels: { style: { colors: fg, fontSize: '10px' }, formatter: (v) => inr(Number(v), { compact: true, decimals: 1 }) }, title: { text: 'LY sales', style: { color: fg, fontSize: '10px', fontWeight: 600 } } },
    yaxis: { labels: { style: { colors: fg, fontSize: '10px' }, formatter: (v) => `${Math.round(v)}%` }, title: { text: 'Growth', style: { color: fg, fontSize: '10px', fontWeight: 600 } } },
    annotations: { yaxis: [{ y: 0, borderColor: fg, strokeDashArray: 0, opacity: 0.4 }], xaxis: [{ x: medX, borderColor: fg, strokeDashArray: 4, opacity: 0.4 }] },
    legend: { show: true, position: 'top', horizontalAlign: 'right', labels: { colors: fg } },
    tooltip: { theme: isDark ? 'dark' : 'light', custom: ({ seriesIndex, dataPointIndex }) => {
      const d = series[seriesIndex].data[dataPointIndex];
      return `<div class="wr-qtip"><b>${String(d.name).replace(/[<>&]/g, '')}</b><span>${d.code}</span><span>LY ${inr(d.x)} · ${d.y >= 0 ? '+' : ''}${d.y.toFixed(1)}%</span></div>`;
    } },
  };
  return (
    <Card icon={Crosshair} eyebrow={`${pts_.length} stores · median LY ${inr(medX)}`} title="Size × growth"
      right={<Seg size="sm" value={period} onChange={setPeriod} options={[{ value: 'cw', label: 'Week' }, { value: 'mtd', label: 'MTD' }, { value: 'ytd', label: 'YTD' }]} />}>
      <div className="wr-quad-k">
        <span className="neg"><b>{quad.big_down}</b> big · falling <em>−{inr(quad.atRisk)}</em></span>
        <span className="pos"><b>{quad.big_up}</b> big · growing</span>
        <span className="warn"><b>{quad.small_down}</b> small · falling</span>
        <span className="info"><b>{quad.small_up}</b> small · growing</span>
      </div>
      <Chart type="scatter" height={300} options={opts} series={series} />
    </Card>
  );
}

// ── categories: sales TY vs LY, closing stock + cover (J), sales vs stock mix ─
export function CategoryPanel({ cats, catSum, stockSum, P, measure, coreOnly, onCoreOnly }) {
  const list = (coreOnly ? cats.slice(0, 6) : cats).filter((c) => catSum[c] && (catSum[c][0] || catSum[c][1] || (stockSum[c] && stockSum[c][0])));
  const I = measure === 'qty' ? [0, 1] : [6, 7];
  const fmt = measure === 'qty' ? (v) => num(v) : (v) => inr(v);
  const max = Math.max(1, ...list.map((c) => Math.max(catSum[c][I[0]], catSum[c][I[1]])));
  const totS = list.reduce((a, c) => a + catSum[c][0], 0); const totK = list.reduce((a, c) => a + (stockSum[c] ? stockSum[c][0] : 0), 0);
  const days = Math.max(1, Math.round((new Date(P.mtd[1]) - new Date(P.mtd[0])) / 864e5) + 1);
  const hasLy = Boolean(P.stock.ly);
  const mx = Math.max(0.0001, ...list.map((x) => Math.max(totS ? catSum[x][0] / totS : 0, totK ? (stockSum[x] ? stockSum[x][0] : 0) / totK : 0)));   // longest bar
  return (
    <div className="wr-catgrid">
      <Card className="wr-cat" icon={Shirt} eyebrow={`YTD ${fmtRange(P.ytd)}`} title="Categories"
        right={<button type="button" className={`wr-chip${coreOnly ? ' on' : ''}`} onClick={() => onCoreOnly(!coreOnly)}>{coreOnly ? 'Core 6' : 'All'}</button>}>
        <div className="wr-ctable">
          <div className="wr-crow head"><span /><span>TY</span><span>LY</span><span>Δ</span><span>Mix</span></div>
          {list.map((c) => {
            const a = catSum[c]; const g = growth(a[I[0]], a[I[1]]);
            return (
              <div key={c} className="wr-crow">
                <span className="wr-crow-n">{c}<DualBar ty={a[I[0]]} ly={a[I[1]]} max={max} toneName={tone(g)} /></span>
                <span className="b">{fmt(a[I[0]])}</span><span className="mute">{fmt(a[I[1]])}</span>
                <span><Delta v={g} size="sm" /></span><span className="mute">{share(totS ? a[0] / totS : null)}</span>
              </div>
            );
          })}
        </div>
      </Card>
      <Card className="wr-cat" icon={Boxes} eyebrow={P.stock.ty ? `${fmtDay(P.stock.ty, true)}${hasLy ? ` vs ${fmtDay(P.stock.ly, true)}` : ''}` : '—'} title="Stock">
        {!P.stock.ty ? <div className="wr-empty sm">No stock snapshot.</div> : (
          <div className="wr-ctable">
            <div className="wr-crow head"><span /><span>Units</span><span>{hasLy ? 'LY' : 'MRP'}</span><span>{hasLy ? 'Δ' : ''}</span><span>Cover</span></div>
            {list.map((c) => {
              const k = stockSum[c] || [0, 0, 0, 0]; const rate = catSum[c] ? catSum[c][2] / days : 0; const cover = rate > 0 ? k[0] / rate : null;
              return (
                <div key={c} className="wr-crow">
                  <span className="wr-crow-n">{c}</span>
                  <span className="b">{num(k[0])}</span>
                  <span className="mute">{hasLy ? num(k[1]) : inr(k[2])}</span>
                  <span>{hasLy ? <Delta v={growth(k[0], k[1])} size="sm" invert /> : null}</span>
                  <span className={cover == null ? 'mute' : cover > 180 ? 'neg' : cover < 21 ? 'warn' : ''}>{cover == null ? '—' : `${num(cover)}d`}</span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      <Card className="wr-contro" icon={Scale} eyebrow="Share of YTD sales vs share of stock on hand" title="Sales vs stock">
        {!totK ? <div className="wr-empty sm">No stock snapshot.</div> : (
          <div className="wr-mix2">
            <div className="wr-mix2-r head"><span>Category</span><span><i className="s" />Sales share</span><span><i className="k" />Stock share</span><span>Gap</span></div>
            {list.map((c) => {
              const sv = totS ? catSum[c][0] / totS : 0; const kv = totK ? (stockSum[c] ? stockSum[c][0] : 0) / totK : 0; const gap = sv - kv;
              const t = Math.abs(gap) < 0.03 ? 'bal' : gap > 0 ? 'hot' : 'slow';
              return (
                <div key={c} className="wr-mix2-r">
                  <span className="wr-mix2-n">{c}</span>
                  <span className="wr-mix2-c s"><b>{share(sv)}</b><i style={{ width: `${(sv / mx) * 100}%` }} /></span>
                  <span className="wr-mix2-c k"><b>{share(kv)}</b><i style={{ width: `${(kv / mx) * 100}%` }} /></span>
                  <span className={`wr-mix2-g ${t}`}>
                    {t === 'hot' ? <Flame size={13} /> : t === 'slow' ? <Snail size={13} /> : <CheckCircle2 size={13} />}
                    <b>{pts(gap)}</b><em>{t === 'hot' ? 'Sells faster than stocked' : t === 'slow' ? 'Overstocked' : 'Balanced'}</em>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
