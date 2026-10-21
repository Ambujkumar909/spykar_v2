// ─── War Room · Command — the network (as filtered) on one screen ────────────
import { useMemo, useState } from 'react';
import { CalendarDays, CalendarRange, CalendarClock, Users, HeartPulse, Map as MapIcon, Trophy, Siren, Target, ArrowUpRight, ArrowDownRight, Flame } from 'lucide-react';
import { Card, Delta, Spark, StatusPill, Tween, Seg } from './ui';
import { PeriodCard, TrendPanel, CategoryPanel, DriversPanel, BridgePanel, PacePanel, QuadrantPanel } from './Panels';
import WrMap from './WrMap';
import { sumPeriods, sumWeeks, sumDays, sumCats, sumStock, kpis, growth, statusOf, isActive, reviewed, groupStores, streak,
  inr, num, pct, share, fmtRange, fmtDow, STATUS } from './wrMath';

function Tile({ icon: Icon, eyebrow, title, value, format, children, accent }) {
  return (
    <div className={`wr-tile wr-accent-${accent}`}>
      <div className="wr-tile-h"><span className="wr-tile-ic"><Icon size={14} strokeWidth={2.3} /></span><div><div className="wr-eyebrow">{eyebrow}</div><div className="wr-tile-t">{title}</div></div></div>
      <div className="wr-tile-main"><div className="wr-tile-v"><Tween value={value} format={format} /></div>{children}</div>
    </div>
  );
}

export default function CommandView({ board, stores, measure, isDark, onFilter, onOpen, lens }) {
  const P = board.periods;
  const A = useMemo(() => sumPeriods(stores), [stores]);
  const W = useMemo(() => sumWeeks(stores, P.weeks.length), [stores, P]);
  const Dd = useMemo(() => sumDays(stores), [stores]);
  const catSum = useMemo(() => sumCats(stores, board.cats), [stores, board.cats]);
  const stockSum = useMemo(() => sumStock(stores, board.cats), [stores, board.cats]);
  const [coreOnly, setCoreOnly] = useState(true);
  const [geoBy, setGeoBy] = useState('wr_region');
  const [moverBy, setMoverBy] = useState('mtd');
  const I = measure === 'qty' ? 0 : 1;
  const fmtM = measure === 'qty' ? (v) => num(v) : (v) => inr(v);

  const act = useMemo(() => stores.filter(isActive), [stores]);
  const statusCount = STATUS.map((s) => [s, stores.filter((x) => statusOf(x) === s).length]).filter(([, n]) => n);
  const rev = act.filter(reviewed).length;
  const KC = kpis(A.cw); const KL = kpis(A.ly);
  const streaks = useMemo(() => act.map((s) => [s, streak(s)]).filter(([, n]) => n >= 3), [act]);

  // signals: one line each, numbers only
  const signals = useMemo(() => {
    const regs = groupStores(stores, 'wr_region').map((g) => { const s = sumPeriods(g.stores); return [g.key, growth(s.mtd[1], s.mtdly[1]), s.mtd[1] - s.mtdly[1]]; }).filter((r) => r[1] != null).sort((a, b) => b[1] - a[1]);
    const cats = board.cats.slice(0, 6).map((c) => [c, growth(catSum[c][6], catSum[c][7])]).filter((r) => r[1] != null && catSum[r[0]][7] > 0).sort((a, b) => b[1] - a[1]);
    const out = [];
    if (regs.length) out.push({ t: 'pos', l: 'Best region', v: `${regs[0][0]} ${pct(regs[0][1])}` }, { t: 'neg', l: 'Weakest region', v: `${regs[regs.length - 1][0]} ${pct(regs[regs.length - 1][1])}` });
    if (cats.length) out.push({ t: 'pos', l: 'Best category', v: `${cats[0][0]} ${pct(cats[0][1])}` }, { t: 'neg', l: 'Weakest category', v: `${cats[cats.length - 1][0]} ${pct(cats[cats.length - 1][1])}` });
    out.push({ t: 'crit', l: 'Critical', v: num(act.filter((s) => statusOf(s) === 'Critical').length), f: ['wr_status', ['Critical']] });
    out.push({ t: 'warn', l: '3+ weeks below LY', v: num(streaks.length) });
    return out;
  }, [stores, board.cats, catSum, act, streaks]);

  const stateRows = useMemo(() => groupStores(stores, 'state').map((g) => {
    const s = sumPeriods(g.stores); return { state: g.key, ty: s.mtd[1], ly: s.mtdly[1], g: growth(s.mtd[1], s.mtdly[1]), n: g.stores.length };
  }), [stores]);
  const groups = useMemo(() => groupStores(stores, geoBy).map((g) => {
    const s = sumPeriods(g.stores);
    return { key: g.key, n: g.stores.length, ty: s.mtd[I], ly: s.mtdly[I], g: growth(s.mtd[I], s.mtdly[I]) };
  }).sort((a, b) => (b.g ?? -9) - (a.g ?? -9)), [stores, geoBy, I]);
  const gMax = Math.max(0.1, ...groups.map((g) => Math.abs(g.g || 0)));

  const movers = useMemo(() => {
    const p = moverBy === 'mtd' ? ['mtd', 'mtdly'] : moverBy === 'cw' ? ['cw', 'ly'] : ['ytd', 'ytdly'];
    const list = act.filter((s) => s.m[p[1]][1] > 0 && s.type !== 'New').map((s) => ({ s, g: growth(s.m[p[0]][I], s.m[p[1]][I]), d: s.m[p[0]][I] - s.m[p[1]][I] }));
    list.sort((a, b) => b.d - a.d);
    return { up: list.slice(0, 6), down: list.slice(-6).reverse() };
  }, [act, moverBy, I]);
  const attention = useMemo(() => act.filter((s) => statusOf(s) === 'Critical' || (statusOf(s) === 'Degrowth' && !reviewed(s)) || streak(s) >= 4)
    .map((s) => ({ s, g: growth(s.m.mtd[1], s.m.mtdly[1]), gap: s.m.mtd[1] - s.m.mtdly[1], k: streak(s) }))
    .sort((a, b) => a.gap - b.gap).slice(0, 10), [act]);

  return (
    <div className="wr-view">
      <div className="wr-tiles">
        <Tile icon={CalendarDays} accent="red" eyebrow={`${fmtRange(P.cw)} · ${fmtDow(P.cw[0])}–${fmtDow(P.cw[1])}`} title="Week" value={A.cw[I]} format={fmtM}>
          <div className="wr-tile-d"><Delta v={growth(A.cw[I], A.ly[I])} label="LY" /><Delta v={growth(A.cw[I], A.pw[I])} label="PW" /></div>
        </Tile>
        <Tile icon={CalendarRange} accent="gold" eyebrow={fmtRange(P.mtd)} title="MTD" value={A.mtd[I]} format={fmtM}>
          <div className="wr-tile-d"><Delta v={growth(A.mtd[I], A.mtdly[I])} label="LY" /></div>
          <div className="wr-tile-s">LY <b>{fmtM(A.mtdly[I])}</b></div>
        </Tile>
        <Tile icon={CalendarClock} accent="violet" eyebrow={fmtRange(P.ytd)} title="YTD" value={A.ytd[I]} format={fmtM}>
          <div className="wr-tile-d"><Delta v={growth(A.ytd[I], A.ytdly[I])} label="LY" /></div>
          <div className="wr-tile-s">Disc <b>{share(kpis(A.ytd).disc)}</b> · LY {share(kpis(A.ytdly).disc)}</div>
        </Tile>
        <div className="wr-tile wr-accent-sky">
          <div className="wr-tile-h"><span className="wr-tile-ic"><Users size={14} /></span><div><div className="wr-eyebrow">Week vs LY</div><div className="wr-tile-t">Customers</div></div></div>
          <div className="wr-kgrid">
            {[['Bills', KC.bills, KL.bills, (v) => num(v)], ['UPT', KC.upt, KL.upt, (v) => num(v, 2)], ['ASP', KC.asp, KL.asp, (v) => inr(v, { compact: false })], ['ATV', KC.atv, KL.atv, (v) => inr(v, { compact: false })]].map(([l, a, b, f]) => (
              <div key={l}><span>{l}</span><b>{a == null ? 'n/a' : f(a)}</b><Delta v={growth(a, b)} size="sm" /></div>
            ))}
          </div>
        </div>
        <div className="wr-tile wr-accent-mint">
          <div className="wr-tile-h"><span className="wr-tile-ic"><HeartPulse size={14} /></span><div><div className="wr-eyebrow">MTD vs LY · {num(act.length)} trading</div><div className="wr-tile-t">Health</div></div></div>
          <div className="wr-health">
            <div className="wr-health-bar">{statusCount.map(([s, n]) => <i key={s} className={`wr-hb-${s}`} style={{ flex: n }} title={`${s} ${n}`} onClick={() => onFilter('wr_status', [s])} />)}</div>
            <div className="wr-health-leg">{statusCount.map(([s, n]) => <button key={s} type="button" onClick={() => onFilter('wr_status', [s])}><StatusPill status={s} small /><b>{n}</b></button>)}</div>
          </div>
          <div className="wr-tile-s">Reviewed <b>{num(rev)}</b>/{num(act.length)} <span className="wr-prog"><i style={{ width: `${act.length ? (rev / act.length) * 100 : 0}%` }} /></span></div>
        </div>
      </div>

      <div className="wr-signals">
        {signals.map((x) => (
          <button type="button" key={x.l} className={`wr-sig wr-${x.t}`} onClick={x.f ? () => onFilter(...x.f) : undefined} disabled={!x.f}>
            <em>{x.l}</em><b>{x.v}</b>
          </button>
        ))}
      </div>

      <div className="wr-tri">
        <PeriodCard kind="week" P={P} A={A} measure={measure} />
        <PeriodCard kind="mtd" P={P} A={A} measure={measure} />
        <PeriodCard kind="ytd" P={P} A={A} measure={measure} />
      </div>

      <div className="wr-two">
        <DriversPanel A={A} />
        <PacePanel days={Dd} P={P} isDark={isDark} />
      </div>
      <div className="wr-two">
        <TrendPanel weeks={P.weeks} weeksLy={P.weeksLy} series={W} isDark={isDark} />
        <BridgePanel stores={stores} cats={board.cats} measure={measure} onFilter={onFilter} />
      </div>

      <CategoryPanel cats={board.cats} catSum={catSum} stockSum={stockSum} P={P} measure={measure} coreOnly={coreOnly} onCoreOnly={setCoreOnly} />

      <div className="wr-geo">
        <Card icon={MapIcon} eyebrow={`MTD vs ${fmtRange(P.mtdly, true)}`} title="States" className="wr-geo-map">
          <WrMap rows={stateRows} selected={[].concat(lens.state || [])} onPick={(s) => onFilter('state', [s])} />
        </Card>
        <div className="wr-stack">
          <QuadrantPanel stores={stores} isDark={isDark} onOpen={onOpen} />
          <Card icon={Target} eyebrow="MTD vs LY" title="League"
            right={<Seg size="sm" value={geoBy} onChange={setGeoBy} options={[{ value: 'wr_region', label: 'Region' }, { value: 'state', label: 'State' }, { value: 'wr_type', label: 'Type' }, { value: 'wr_asm', label: 'ASM' }]} />}>
            <div className="wr-rank">
              {groups.map((g, i) => (
                <button type="button" key={g.key} className="wr-rank-r" onClick={() => onFilter(geoBy, [g.key])}>
                  <span className="wr-rank-i">{i + 1}</span>
                  <span className="wr-rank-n">{g.key}<em>{g.n} · {fmtM(g.ty)}</em></span>
                  <span className="wr-rank-bar"><i className={g.g >= 0 ? 'pos' : 'neg'} style={{ width: `${(Math.abs(g.g || 0) / gMax) * 50}%`, [g.g >= 0 ? 'left' : 'right']: '50%' }} /></span>
                  <span className={`wr-rank-g ${g.g >= 0 ? 'pos' : 'neg'}`}>{pct(g.g)}</span>
                </button>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <div className="wr-movers">
        <Card icon={Trophy} eyebrow="Change vs LY" title="Movers"
          right={<Seg size="sm" value={moverBy} onChange={setMoverBy} options={[{ value: 'cw', label: 'Week' }, { value: 'mtd', label: 'MTD' }, { value: 'ytd', label: 'YTD' }]} />}>
          <div className="wr-mv">
            {[['Gainers', 'pos', ArrowUpRight, movers.up], ['Losers', 'neg', ArrowDownRight, movers.down]].map(([h, t, Ic, list]) => (
              <div key={h}><div className={`wr-mv-h ${t}`}><Ic size={13} /> {h}</div>
                {list.map(({ s, g, d }) => (
                  <button type="button" key={s.code} className="wr-mv-r" onClick={() => onOpen(s.code)}>
                    <span className="wr-mv-n">{s.name}<em>{s.code} · {s.city}</em></span><Spark ty={s.wk} ly={s.wkly} w={70} h={22} />
                    <span className="wr-mv-v"><b className={t}>{d >= 0 ? '+' : ''}{fmtM(d)}</b><em>{pct(g)}</em></span>
                  </button>))}
              </div>
            ))}
          </div>
        </Card>
        <Card icon={Siren} eyebrow="Critical · unreviewed decline · 4+ weeks below LY" title="Attention" accent="red">
          {attention.length === 0 ? <div className="wr-empty sm">Nothing flagged.</div> : (
            <div className="wr-att">
              {attention.map(({ s, g, gap, k }) => (
                <button type="button" key={s.code} className="wr-att-r" onClick={() => onOpen(s.code)}>
                  <StatusPill status={statusOf(s)} small />
                  <span className="wr-mv-n">{s.name}<em>{s.code} · {s.region}{s.asm ? ` · ${s.asm}` : ''}</em></span>
                  <span className="wr-mv-v"><b className="neg">{pct(g)}</b><em>{inr(gap)}</em></span>
                  <span className="wr-att-k">{k >= 2 ? <><Flame size={11} />{k}w</> : ''}</span>
                  <span className={`wr-att-rev ${reviewed(s) ? 'on' : ''}`}>{reviewed(s) ? '✓' : '•'}</span>
                </button>))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
