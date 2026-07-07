// ─── /inventory-ageing — TRUE inventory ageing (FIFO + continuous-on-hand) ────
// Two sources, one page. WAREHOUSE = real FIFO on the M3 MITTRA ledger (each
// in-stock unit dated by the receipt it belongs to). STORE = continuous-on-hand
// on the daily snapshot (units that never left across a window are ≥ that old).
// Reads the precomputed inventory_ageing table → instant. Ageing profiles are
// drawn as CSS stacked bars (no chart lib → zero hover artefacts). Lens-driven:
// sidebar filters + clickable rows re-scope everything.

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import DashboardLayout from '../components/layout/DashboardLayout';
import { useTheme } from '../lib/useTheme';
import { useFilters } from '../lib/useFilters';
import { FiltersProvider } from '../lib/FiltersContext';
import { ageingService } from '../lib/services';
import { notifyApiError } from '../lib/notifyApiError';
import {
  Hourglass, Warehouse, Store, MapPin, Building2, Layers, Tag, Palette, Ruler, Shirt,
  Download, ChevronRight, AlertTriangle, Boxes, IndianRupee, Clock, ShieldCheck,
} from 'lucide-react';

const fmtNum = (n) => (n == null ? '0' : Number(n).toLocaleString('en-IN'));
function fmtCr(n) {
  if (n == null) return '—'; n = Number(n); const neg = n < 0; const a = Math.abs(n); let s;
  if (a >= 1e7) s = '₹' + (a / 1e7).toFixed(2) + ' Cr';
  else if (a >= 1e5) s = '₹' + (a / 1e5).toFixed(2) + 'L';
  else s = '₹' + Math.round(a).toLocaleString('en-IN');
  return (neg ? '−' : '') + s;
}
function cnt(n) {
  if (n == null) return '0'; n = Number(n);
  if (n >= 1e7) return (n / 1e7).toFixed(2) + ' Cr';
  if (n >= 1e5) return (n / 1e5).toFixed(2) + ' L';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString('en-IN');
}
const prettyDate = (iso) => (iso ? new Date(String(iso).length === 10 ? iso + 'T00:00:00' : iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

// Bucket ramp: fresh → aged (green → deep red), undetermined = slate.
const BUCKET_META = {
  d0_30:        { label: '0–30 d',    color: '#10B981' },
  d31_60:       { label: '31–60 d',   color: '#84CC16' },
  d61_90:       { label: '61–90 d',   color: '#EAB308' },
  d91_180:      { label: '91–180 d',  color: '#F97316' },
  d181_365:     { label: '181–365 d', color: '#EF4444' },
  d365_plus:    { label: '365+ d',    color: '#B91C1C' },
  undetermined: { label: 'Undet.',    color: '#64748B' },
};
const BUCKET_ORDER = ['d0_30', 'd31_60', 'd61_90', 'd91_180', 'd181_365', 'd365_plus', 'undetermined'];

const SOURCES = [
  { value: 'warehouse', label: 'Warehouse (FIFO)', Icon: Warehouse },
  { value: 'store', label: 'Store (on-hand)', Icon: Store },
];
const MEASURE_OPTIONS = [{ value: 'units', label: 'Units' }, { value: 'gross', label: 'Value (MRP)' }, { value: 'cost', label: 'Cost' }];
const STATUS_OPTIONS = [{ value: 'active', label: 'Active stores' }, { value: 'inactive', label: 'Inactive stores' }, { value: 'all', label: 'All stores' }];

const VIEW_BY = {
  warehouse: [
    { key: 'warehouse', label: 'Warehouse', Icon: Warehouse }, { key: 'category', label: 'Category', Icon: Tag },
    { key: 'colour', label: 'Colour', Icon: Palette }, { key: 'size', label: 'Size', Icon: Ruler }, { key: 'product', label: 'Product', Icon: Shirt },
  ],
  store: [
    { key: 'state', label: 'State', Icon: MapPin }, { key: 'city', label: 'City', Icon: Building2 },
    { key: 'channel', label: 'Channel', Icon: Layers }, { key: 'store', label: 'Store', Icon: Store },
    { key: 'category', label: 'Category', Icon: Tag }, { key: 'colour', label: 'Colour', Icon: Palette }, { key: 'size', label: 'Size', Icon: Ruler },
  ],
};
// view-by → Lens filter key for row-click drill (null = not drillable, e.g. store opens nothing extra here)
const VIEWBY_LENS = { warehouse: 'warehouse', state: 'state', city: 'city', channel: 'group_name', store: 'store_code', category: 'category', colour: 'color', size: 'size', product: 'product' };
const LENS_LABELS = {
  state: 'State', city: 'City', store_code: 'Store', group_name: 'Channel', warehouse: 'Warehouse',
  category: 'Category', product: 'Product', sub_product: 'Sub-product', gender_name: 'Gender', size: 'Size', color: 'Colour', season: 'Season',
};
const measureVal = (r, m) => (m === 'gross' ? r.value_gross : m === 'cost' ? r.value_cost : r.units);
const measureFmt = (n, m) => (m === 'units' ? fmtNum(n) : fmtCr(n));
const measureLabel = (m) => (m === 'units' ? 'Units' : m === 'gross' ? 'Value' : 'Cost');

function HeaderField({ label, value, onChange, options, minWidth = 120 }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 9, height: 34, padding: '0 6px 0 12px',
      borderRadius: 10, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
      <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{label}</span>
      <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
        <select value={value} onChange={(e) => onChange?.(e.target.value)} style={{ height: 28, padding: '0 22px 0 4px',
          background: 'transparent', border: 'none', fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)',
          cursor: 'pointer', appearance: 'none', WebkitAppearance: 'none', outline: 'none', minWidth }}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <svg style={{ position: 'absolute', right: 4, pointerEvents: 'none', opacity: 0.5 }} width={11} height={11}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}><polyline points="6 9 12 15 18 9" /></svg>
      </div>
    </label>
  );
}

// CSS stacked bar — segments proportional to bucket units.
function AgeBar({ buckets, height = 10 }) {
  const total = BUCKET_ORDER.reduce((a, k) => a + (buckets[k] || 0), 0) || 1;
  return (
    <div style={{ display: 'flex', width: '100%', height, borderRadius: 999, overflow: 'hidden', background: 'var(--bg-elevated)' }}>
      {BUCKET_ORDER.map((k) => {
        const v = buckets[k] || 0; if (!v) return null;
        return <div key={k} title={`${BUCKET_META[k].label}: ${fmtNum(v)}`} style={{ width: `${(v / total) * 100}%`, background: BUCKET_META[k].color }} />;
      })}
    </div>
  );
}

// Feature flag — Inventory Ageing is DISABLED for now. Flip to false to restore
// the full page (nav item, filter route + backend /ageing route must also be
// re-enabled). While true, the component returns BEFORE any hook or API call
// fires, so nothing is calculated or fetched.
const AGEING_DISABLED = true;

function AgeingDisabledNotice() {
  return (
    <DashboardLayout title="Inventory Ageing" subtitle="Temporarily unavailable">
      <div style={{ minHeight: 320, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, textAlign: 'center', color: 'var(--text-muted)' }}>
        <Hourglass size={34} strokeWidth={1.6} />
        <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)' }}>Inventory Ageing is temporarily disabled</div>
        <div style={{ fontSize: 13, maxWidth: 420 }}>This feature is turned off for now. It will return once full stock &amp; MITTRA history is loaded.</div>
      </div>
    </DashboardLayout>
  );
}

export default function InventoryAgeingPage() {
  if (AGEING_DISABLED) return <AgeingDisabledNotice />;
  return <InventoryAgeingPageImpl />;
}

function InventoryAgeingPageImpl() {
  const { isDark } = useTheme();
  const ORANGE = '#F97316';

  const [source, setSource] = useState('warehouse');
  const [measure, setMeasure] = useState('units');
  const [viewBy, setViewBy] = useState('warehouse');
  const [summary, setSummary] = useState(null);
  const [sumLoading, setSumLoading] = useState(true);
  const [pivot, setPivot] = useState(null);
  const [pivotLoading, setPivotLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  // Sidebar Lens (shared) — row clicks write here too.
  const filtersApi = useFilters({ defaults: { mode: 'active' }, persist: ['mode'] });
  const lens = filtersApi.filters;
  const setLens = filtersApi.setFilter;
  const clearLens = filtersApi.clearFilter;
  const status = lens.mode || 'active';

  const activeLensDims = useMemo(
    () => Object.keys(LENS_LABELS).filter((d) => { const v = lens[d]; return Array.isArray(v) ? v.length > 0 : Boolean(v); }),
    [lens]);
  const lensScope = useMemo(() => {
    const p = {};
    const put = (k, v) => { if (v && v.length) p[k] = Array.isArray(v) ? v.join(',') : v; };
    put('state', lens.state); put('city', lens.city); put('channel', lens.group_name); put('store', lens.store_code);
    put('warehouse', lens.warehouse); put('category', lens.category); put('color', lens.color); put('size', lens.size);
    put('product', lens.product); put('gender', lens.gender_name); put('sub_product', lens.sub_product); put('season', lens.season);
    return p;
  }, [lens]);
  const scope = useMemo(() => ({ source, status, ...lensScope }), [source, status, lensScope]);
  const scopeKey = useMemo(() => JSON.stringify(scope), [scope]);

  // keep viewBy valid when source flips
  useEffect(() => { if (!VIEW_BY[source].some((v) => v.key === viewBy)) setViewBy(VIEW_BY[source][0].key); }, [source]); // eslint-disable-line

  useEffect(() => {
    let a = true; setSumLoading(true);
    ageingService.getSummary(scope)
      .then((r) => { if (a) setSummary(r.data?.data || null); })
      .catch((e) => { if (a) notifyApiError(e, 'Failed to load ageing summary'); })
      .finally(() => { if (a) setSumLoading(false); });
    return () => { a = false; };
  }, [scopeKey]); // eslint-disable-line

  useEffect(() => {
    let a = true; setPivotLoading(true);
    ageingService.getPivot({ group_by: viewBy, measure, ...scope })
      .then((r) => { if (a) setPivot(r.data?.data || null); })
      .catch((e) => { if (a) notifyApiError(e, 'Failed to load ageing breakdown'); })
      .finally(() => { if (a) setPivotLoading(false); });
    return () => { a = false; };
  }, [viewBy, measure, scopeKey]); // eslint-disable-line

  const lensKeyFor = VIEWBY_LENS[viewBy];
  const onRowClick = useCallback((r) => {
    if (!lensKeyFor) return;
    const cur = lens[lensKeyFor];
    const already = Array.isArray(cur) ? (cur.length === 1 && cur[0] === r.key) : cur === r.key;
    setLens(lensKeyFor, already ? undefined : [r.key]);
  }, [lensKeyFor, lens, setLens]);

  const onExport = useCallback(async () => {
    try {
      setExporting(true);
      const res = await ageingService.exportCsv({ group_by: viewBy, measure, ...scope });
      const url = window.URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const a = document.createElement('a'); a.href = url; a.download = `ageing-${source}-${viewBy}.csv`;
      document.body.appendChild(a); a.click(); a.remove(); window.URL.revokeObjectURL(url);
    } catch (e) { notifyApiError(e, 'Export failed'); } finally { setExporting(false); }
  }, [viewBy, measure, scope, source]);

  const sortedRows = useMemo(() => {
    const rows = [...(pivot?.rows || [])];
    return rows.sort((a, b) => measureVal(b, measure) - measureVal(a, measure)).slice(0, 200);
  }, [pivot, measure]);

  const dimLabel = (VIEW_BY[source].find((v) => v.key === viewBy) || {}).label || viewBy;
  const cov = summary?.meta?.covered_days;
  const isStoreThin = source === 'store' && (summary?.buckets?.find((b) => b.key === 'undetermined')?.units || 0) > 0;

  return (
    <FiltersProvider value={filtersApi}>
    <DashboardLayout title="Inventory Ageing"
      subtitle="How old is the stock we're holding — true FIFO in warehouses, continuous-on-hand in stores">
      <div className="ag-page">
        {/* toolbar */}
        <div className="ag-toolbar">
          <div className="ag-src">
            {SOURCES.map(({ value, label, Icon }) => (
              <button key={value} className={`ag-srcbtn ${source === value ? 'on' : ''}`} onClick={() => setSource(value)}><Icon size={14} /> {label}</button>
            ))}
          </div>
          <div style={{ flex: 1 }} />
          <HeaderField label="Measure" value={measure} onChange={setMeasure} options={MEASURE_OPTIONS} minWidth={96} />
          {source === 'store' && <HeaderField label="Status" value={status} onChange={(v) => setLens('mode', v)} options={STATUS_OPTIONS} minWidth={104} />}
        </div>

        {/* active Lens chips */}
        {activeLensDims.length > 0 && (
          <div className="ag-chips">
            <span className="ag-cap" style={{ color: ORANGE, marginRight: 2 }}>Filtered by</span>
            {activeLensDims.map((dim) => {
              const v = lens[dim]; const vals = Array.isArray(v) ? v : [v];
              return (
                <span key={dim} className="ag-chip">
                  <span className="ag-chip-k">{LENS_LABELS[dim]}</span>
                  <span className="ag-chip-v" title={vals.join(', ')}>{vals.join(', ')}</span>
                  <button type="button" onClick={() => clearLens(dim)} className="ag-chip-x" aria-label={`Clear ${LENS_LABELS[dim]}`}>✕</button>
                </span>
              );
            })}
            {activeLensDims.length > 1 && <button className="ag-chip-clear" onClick={() => activeLensDims.forEach((d) => clearLens(d))}>Clear all</button>}
          </div>
        )}

        {/* hero */}
        <div className="ag-hero">
          <div className="ag-hero-glow" />
          <div style={{ position: 'relative' }}>
            <div className="ag-eyebrow"><Hourglass size={12} /> {source === 'warehouse' ? 'Warehouse ageing · FIFO' : 'Store ageing · continuous-on-hand'} · as of {prettyDate(summary?.meta?.as_of)}</div>
            {sumLoading ? <div className="sx-shimmer" style={{ height: 58, width: '50%', borderRadius: 10 }} /> : (
              <div className="ag-hero-num">
                {summary?.aged_pct == null ? '—' : `${summary.aged_pct}%`}
                <span className="ag-hero-tag"><AlertTriangle size={14} /> aged &gt; 90 days</span>
              </div>
            )}
            <div className="ag-hero-sub">
              <span><b>{cnt(summary?.total_units)}</b> units held</span>
              <span><b>{fmtCr(measure === 'cost' ? summary?.total_value_cost : summary?.total_value_gross)}</b> value</span>
              <span><b>{fmtCr(summary?.aged_value_gross)}</b> at risk (&gt;90d)</span>
              {cov != null && <span className="ag-cov">history covers {cov} days</span>}
            </div>
          </div>
        </div>

        {/* coverage caveat for thin store history */}
        {isStoreThin && (
          <div className="ag-note"><ShieldCheck size={14} />
            Store ageing is proven only to <b>{cov} days</b> so far — older stock sits in <b>“Undetermined”</b> until more daily snapshots load. Warehouse ageing (FIFO) is exact today.</div>
        )}

        {/* ageing profile — full-width stacked bar + legend */}
        <div className="sx-card" style={{ padding: 20, marginTop: 16 }}>
          <div className="ag-sec"><Clock size={14} color={ORANGE} /> Ageing profile</div>
          {sumLoading ? <div className="sx-shimmer" style={{ height: 16, borderRadius: 999 }} /> : (
            <>
              <AgeBar buckets={Object.fromEntries((summary?.buckets || []).map((b) => [b.key, b.units]))} height={16} />
              <div className="ag-legend">
                {(summary?.buckets || []).filter((b) => b.units > 0).map((b) => (
                  <div key={b.key} className="ag-leg">
                    <span className="ag-dot" style={{ background: BUCKET_META[b.key]?.color }} />
                    <span className="ag-leg-l">{BUCKET_META[b.key]?.label}</span>
                    <span className="ag-leg-v">{measureFmt(measureVal({ units: b.units, value_gross: b.value_gross, value_cost: b.value_cost }, measure), measure)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* view-by + export */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '18px 0 12px' }}>
          <div className="ag-viewby">
            {VIEW_BY[source].map(({ key, label, Icon }) => (
              <button key={key} className={`ag-vb ${viewBy === key ? 'on' : ''}`} onClick={() => setViewBy(key)}><Icon size={13} /> {label}</button>
            ))}
          </div>
          <div style={{ flex: 1 }} />
          <button className="ag-export" onClick={onExport} disabled={exporting || !pivot?.rows?.length}><Download size={13} /> {exporting ? 'Exporting…' : 'Export CSV'}</button>
        </div>

        {/* pivot */}
        <div className="sx-card" style={{ overflow: 'hidden' }}>
          <div className="ag-tblhead">
            <span className="ag-cap" style={{ color: ORANGE }}>Ageing by {dimLabel}</span>
            {!pivotLoading && pivot?.rows && <span className="ag-count">{fmtNum(pivot.rows.length)}</span>}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="ag-tbl">
              <thead><tr>
                <th className="l">{dimLabel}</th><th>{measureLabel(measure)}</th><th>Aged &gt;90d</th><th style={{ minWidth: 200 }}>Ageing mix</th>
              </tr></thead>
              <tbody>
                {pivotLoading ? Array.from({ length: 10 }).map((_, i) => <tr key={i}><td colSpan={4}><div className="sx-shimmer" style={{ height: 14, borderRadius: 4 }} /></td></tr>)
                  : sortedRows.length ? sortedRows.map((r, i) => {
                    const active = lensKeyFor && (Array.isArray(lens[lensKeyFor]) ? lens[lensKeyFor].includes(r.key) : lens[lensKeyFor] === r.key);
                    return (
                      <tr key={r.key || i} className={`${lensKeyFor ? 'clk' : ''}${active ? ' on' : ''}`} onClick={() => lensKeyFor && onRowClick(r)}>
                        <td className="l strong">{r.label || '—'} {lensKeyFor && <ChevronRight size={12} style={{ color: active ? ORANGE : 'var(--text-muted)', verticalAlign: 'middle' }} />}</td>
                        <td className="strong">{measureFmt(measureVal(r, measure), measure)}</td>
                        <td className={r.aged_pct > 20 ? 'bad' : r.aged_pct > 5 ? 'warn' : ''}>{r.aged_pct == null ? '—' : `${r.aged_pct}%`}</td>
                        <td><AgeBar buckets={r.buckets} /></td>
                      </tr>); }) : <tr><td colSpan={4} style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontWeight: 700 }}>No stock for this selection</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <style jsx>{`
        .ag-page { padding-bottom: 40px; }
        .ag-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
        .ag-src { display: inline-flex; gap: 5px; padding: 4px; background: var(--bg-elevated); border: 1px solid var(--border-subtle); border-radius: 12px; }
        .ag-srcbtn { display: inline-flex; align-items: center; gap: 7px; padding: 8px 14px; border-radius: 8px; border: none; cursor: pointer; font-size: 12.5px; font-weight: 700; background: transparent; color: var(--text-secondary); transition: all 0.15s; }
        .ag-srcbtn.on { background: ${ORANGE}; color: #fff; box-shadow: 0 4px 12px ${ORANGE}55; }
        .ag-cap { font-size: 11px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); }
        .ag-chips { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; padding: 10px 14px; border-radius: 12px; background: ${ORANGE}0d; border: 1px solid ${ORANGE}33; }
        .ag-chip { display: inline-flex; align-items: center; gap: 7px; height: 28px; padding: 0 4px 0 11px; border-radius: 999px; background: var(--bg-surface); border: 1px solid var(--border-subtle); max-width: 320px; }
        .ag-chip-k { font-size: 9px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: ${ORANGE}; flex-shrink: 0; }
        .ag-chip-v { font-size: 12.5px; font-weight: 700; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .ag-chip-x { width: 20px; height: 20px; border: none; border-radius: 50%; background: transparent; color: var(--text-muted); cursor: pointer; font-size: 11px; flex-shrink: 0; }
        .ag-chip-x:hover { background: ${ORANGE}; color: #fff; }
        .ag-chip-clear { border: none; background: transparent; color: var(--text-muted); font-size: 12px; font-weight: 700; cursor: pointer; }
        .ag-hero { position: relative; overflow: hidden; border-radius: 20px; padding: 26px 28px; margin-bottom: 16px; background: linear-gradient(135deg, var(--bg-surface), var(--bg-elevated)); border: 1px solid var(--border-subtle); }
        .ag-hero-glow { position: absolute; inset: 0; background: radial-gradient(600px 260px at 85% -30%, ${ORANGE}26, transparent 60%); }
        .ag-eyebrow { display: inline-flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 800; letter-spacing: 0.10em; text-transform: uppercase; color: var(--text-muted); margin-bottom: 10px; }
        .ag-hero-num { font-size: clamp(38px, 6vw, 60px); font-weight: 850; letter-spacing: -0.03em; line-height: 1; color: var(--text-primary); display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
        .ag-hero-tag { font-size: 13px; font-weight: 800; display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: 999px; color: #b45309; background: rgba(249,115,22,0.14); }
        .ag-hero-sub { display: flex; gap: 8px 22px; flex-wrap: wrap; margin-top: 16px; font-size: 14px; color: var(--text-secondary); }
        .ag-hero-sub b { color: var(--text-primary); font-weight: 800; }
        .ag-cov { color: ${ORANGE}; font-weight: 700; }
        .ag-note { display: flex; align-items: center; gap: 9px; padding: 12px 16px; border-radius: 12px; margin-bottom: 4px; font-size: 13px; font-weight: 600; color: var(--text-secondary); background: ${ORANGE}0d; border: 1px solid ${ORANGE}33; }
        .ag-note b { color: var(--text-primary); }
        .ag-sec { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 800; color: var(--text-primary); margin-bottom: 14px; }
        .ag-legend { display: flex; flex-wrap: wrap; gap: 8px 20px; margin-top: 14px; }
        .ag-leg { display: inline-flex; align-items: center; gap: 7px; }
        .ag-dot { width: 11px; height: 11px; border-radius: 3px; }
        .ag-leg-l { font-size: 11.5px; font-weight: 700; color: var(--text-secondary); }
        .ag-leg-v { font-size: 11.5px; font-weight: 800; color: var(--text-primary); font-variant-numeric: tabular-nums; }
        .ag-viewby { display: inline-flex; flex-wrap: wrap; gap: 5px; padding: 4px; background: var(--bg-elevated); border: 1px solid var(--border-subtle); border-radius: 12px; }
        .ag-vb { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; border-radius: 8px; border: none; cursor: pointer; font-size: 12px; font-weight: 700; background: transparent; color: var(--text-secondary); }
        .ag-vb.on { background: ${ORANGE}; color: #fff; box-shadow: 0 4px 12px ${ORANGE}55; }
        .ag-export { display: inline-flex; align-items: center; gap: 7px; padding: 8px 14px; border-radius: 10px; border: 1px solid var(--border-subtle); background: var(--bg-elevated); cursor: pointer; color: var(--text-primary); font-size: 12px; font-weight: 700; }
        .ag-export:disabled { opacity: 0.5; }
        .ag-tblhead { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--border-subtle); }
        .ag-count { font-size: 10px; font-weight: 800; color: #fff; background: ${ORANGE}; border-radius: 100px; padding: 2px 8px; }
        .ag-tbl { width: 100%; border-collapse: collapse; }
        .ag-tbl th, .ag-tbl td { padding: 11px 14px; font-size: 13px; white-space: nowrap; border-bottom: 1px solid var(--border-subtle); text-align: right; }
        .ag-tbl th { font-size: 10px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); }
        .ag-tbl th.l, .ag-tbl td.l { text-align: left; }
        .ag-tbl td { color: var(--text-secondary); font-weight: 600; font-variant-numeric: tabular-nums; }
        .ag-tbl td.strong { color: var(--text-primary); font-weight: 800; }
        .ag-tbl td.warn { color: #d97706; font-weight: 800; } .ag-tbl td.bad { color: #dc2626; font-weight: 800; }
        .ag-tbl tr.clk { cursor: pointer; } .ag-tbl tbody tr:hover { background: var(--bg-card-hover, rgba(148,163,184,0.06)); }
        .ag-tbl tr.on { background: ${ORANGE}14; } .ag-tbl tr.on td.l.strong { color: ${ORANGE}; }
      `}</style>
    </DashboardLayout>
    </FiltersProvider>
  );
}
