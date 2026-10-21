// ─── /war-room — the weekly store review, live from the ERP ─────────────────
// Every store's week / MTD / YTD against last year, bills and basket KPIs,
// what moved sales, category and stock mix, and the ASM's reason / action —
// for any date. Numbers come only from data already in the database.
//
// One request per as-on date (+ product filter) returns the whole network;
// every store-side Lens filter then applies in the browser, instantly.
// ASM notes load separately, so saving one never reloads the board.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DashboardLayout from '../components/layout/DashboardLayout';
import LoadError from '../components/ui/LoadError';
import { useFilters } from '../lib/useFilters';
import { FiltersProvider } from '../lib/FiltersContext';
import { useTheme } from '../lib/useTheme';
import { warRoomService } from '../lib/services';
import { notifyApiError } from '../lib/notifyApiError';
import { Crosshair, LayoutGrid, ListOrdered, Store as StoreIcon, Radar, ChevronLeft, ChevronRight, Download, IndianRupee, Package, X, Filter, CalendarDays, Printer } from 'lucide-react';
import { Seg, Shim } from '../components/warroom/ui';
import { filterStores, fmtRange, fmtDay, fmtDow, addDays, num } from '../components/warroom/wrMath';
import CommandView from '../components/warroom/CommandView';
import SnapView from '../components/warroom/SnapView';
import LeagueView from '../components/warroom/LeagueView';
import StoreView from '../components/warroom/StoreView';
import WarRoomStyles from '../components/warroom/WarRoomStyles';

const LENS_NAMES = {
  wr_channel: 'Channel', wr_region: 'Region', wr_type: 'Type', wr_status: 'Status', wr_asm: 'ASM', wr_review: 'Review',
  state: 'State', city: 'City', store_code: 'Store', gender_name: 'Gender', category: 'Category', product: 'Product',
  sub_product: 'Sub-product', size: 'Size', color: 'Colour', season: 'Season',
};
const PRODUCT = [['gender', 'gender_name'], ['category', 'category'], ['product', 'product'], ['sub_product', 'sub_product'], ['size', 'size'], ['color', 'color'], ['season', 'season']];
const DEFAULTS = { wr_channel: ['EBO - SOR'] };
const VIEWS = ['command', 'snap', 'league', 'store'];
const list = (v) => (Array.isArray(v) ? v : v ? String(v).split(',') : []);

export default function WarRoomPage() {
  const filtersApi = useFilters({ defaults: DEFAULTS });
  const lens = filtersApi.filters;
  const { isDark } = useTheme();

  const [meta, setMeta] = useState(null);
  const [asOnSel, setAsOnSel] = useState('');
  const asOn = asOnSel || meta?.to || '';
  const [view, setView] = useState('command');
  const [measure, setMeasure] = useState('val');
  const [storeCode, setStoreCode] = useState(null);
  const [board, setBoard] = useState(null);
  const [notes, setNotes] = useState({ notes: {}, prev: {}, asm: {} });
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retryN, setRetryN] = useState(0);
  const [busy, setBusy] = useState('');
  const reqId = useRef(0);

  const product = useMemo(() => {
    const p = {}; for (const [api, key] of PRODUCT) { const l = list(lens[key]); if (l.length) p[api] = l.join(','); } return p;
  }, [lens]);
  const productKey = JSON.stringify(product);

  useEffect(() => {
    let a = true;
    warRoomService.getMeta().then((r) => { if (a) setMeta(r.data?.data || {}); })
      .catch((e) => { if (a) { setFailed(true); setLoading(false); notifyApiError(e, 'War Room unavailable'); } });
    return () => { a = false; };
  }, []);
  useEffect(() => {
    if (!asOn) return undefined;
    const id = ++reqId.current; setLoading(true);
    warRoomService.getBoard({ as_on: asOn, ...product })
      .then((r) => { if (id === reqId.current) { setBoard(r.data?.data || null); setFailed(false); } })
      .catch((e) => { if (id === reqId.current) { setFailed(true); notifyApiError(e, 'War Room unavailable'); } })
      .finally(() => { if (id === reqId.current) setLoading(false); });
    return undefined;
  }, [asOn, productKey, retryN]); // eslint-disable-line react-hooks/exhaustive-deps
  const weekStart = board?.periods?.weekStart;
  useEffect(() => {
    if (!weekStart) return undefined;
    let a = true;
    warRoomService.getNotes(weekStart).then((r) => { if (a) setNotes(r.data?.data || { notes: {}, prev: {}, asm: {} }); }).catch(() => {});
    return () => { a = false; };
  }, [weekStart]);

  // board stores + their notes (ASM, reason / action, last week's note)
  const all = useMemo(() => (board ? board.stores.map((s) => ({
    ...s, asm: notes.asm[s.code] || '', note: notes.notes[s.code] || null, prev: notes.prev[s.code] || null,
  })) : []), [board, notes]);
  const stores = useMemo(() => filterStores(all, lens), [all, lens]);
  const current = useMemo(() => (storeCode ? all.find((s) => s.code === storeCode) : null), [all, storeCode]);
  const openStore = useCallback((code) => { setStoreCode(code); setView('store'); if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' }); }, []);
  // Click-to-filter anywhere on the page: clicking the same single value again clears it.
  const onFilter = useCallback((k, v) => {
    const cur = list(lens[k]);
    filtersApi.setFilter(k, v.length === 1 && cur.length === 1 && cur[0] === v[0] ? [] : v);
  }, [filtersApi, lens]);
  // Health tile: add / remove one status (several can be on at once).
  const onToggle = useCallback((k, v) => {
    const cur = list(lens[k]);
    filtersApi.setFilter(k, cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]);
  }, [filtersApi, lens]);
  // The stores before the Status filter — so the Health tile keeps showing every status's count.
  const statusBase = useMemo(() => filterStores(all, { ...lens, wr_status: [] }), [all, lens]);
  const onSaved = useCallback((code, n) => {
    setNotes((x) => ({ ...x, notes: { ...x.notes, [code]: n }, asm: n.asm ? { ...x.asm, [code]: n.asm } : x.asm }));
  }, []);
  useEffect(() => { if (view === 'store' && !current && stores.length) setStoreCode(stores[0].code); }, [view, current, stores]);

  // keyboard: 1–4 switch views; ←/→ walk stores in the Store view (never while typing)
  useEffect(() => {
    const h = (e) => {
      if (/input|textarea|select/i.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^[1-4]$/.test(e.key)) { setView(VIEWS[Number(e.key) - 1]); return; }
      if (view !== 'store' || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || !stores.length) return;
      const i = stores.findIndex((s) => s.code === storeCode);
      setStoreCode(stores[(i + (e.key === 'ArrowRight' ? 1 : -1) + stores.length) % stores.length].code);
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [view, stores, storeCode]);

  const doExport = async () => {
    setBusy('export');
    try {
      const r = await warRoomService.exportXlsx({ as_on: asOn, ...product });
      const url = URL.createObjectURL(r.data); const a = document.createElement('a');
      a.href = url; a.download = `War_Room_${asOn}.xlsx`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { notifyApiError(e, 'Export failed'); } finally { setBusy(''); }
  };

  const P = board?.periods;
  const chips = Object.keys(LENS_NAMES).flatMap((k) => list(lens[k]).map((v) => ({ k, v })));
  const step = (n) => { const d = addDays(asOn, n); if (meta?.to && d > meta.to) return; if (meta?.from && d < meta.from) return; setAsOnSel(d); };

  return (
    <FiltersProvider value={filtersApi}>
      <DashboardLayout title="War Room" subtitle="Week · MTD · YTD vs last year — every store" hideSync>
        <div className="wr">
          <WarRoomStyles />
          <div className="wr-crown">
            <div className="wr-crown-mark"><Crosshair size={16} /><span>War Room</span><i /></div>
            {P && (
              <div className="wr-ribbon">
                {[['Week', P.cw], ['PW', P.pw], ['LY', P.ly, true], ['MTD', P.mtd], ['LY', P.mtdly, true], ['YTD', P.ytd], ['LY', P.ytdly, true]].map(([l, r, y], i) => (
                  <span key={`${l}${i}`} className={y ? 'ly' : ''}><b>{l}</b>{fmtRange(r, y)}</span>
                ))}
                <span className="stk"><b>Stock</b>{P.stock.ty ? fmtDay(P.stock.ty) : 'n/a'}</span>
              </div>
            )}
          </div>

          <div className="wr-cmd">
            <div className="wr-cmd-date">
              <button type="button" className="wr-iconbtn" onClick={() => step(-7)} aria-label="Back one week"><ChevronLeft size={15} /><ChevronLeft size={15} style={{ marginLeft: -9 }} /></button>
              <button type="button" className="wr-iconbtn" onClick={() => step(-1)} aria-label="Back one day"><ChevronLeft size={15} /></button>
              <label className="wr-datebox">
                <CalendarDays size={14} />
                <span><em>As on</em><b>{asOn ? `${fmtDow(asOn)} ${fmtDay(asOn, true)}` : '—'}</b></span>
                <input type="date" value={asOn} min={meta?.from || undefined} max={meta?.to || undefined} onChange={(e) => e.target.value && setAsOnSel(e.target.value)} aria-label="As-on date" />
              </label>
              <button type="button" className="wr-iconbtn" onClick={() => step(1)} aria-label="Forward one day" disabled={!meta || asOn >= meta.to}><ChevronRight size={15} /></button>
              <button type="button" className="wr-iconbtn" onClick={() => step(7)} aria-label="Forward one week" disabled={!meta || addDays(asOn || '2000-01-01', 7) > meta.to}><ChevronRight size={15} /><ChevronRight size={15} style={{ marginLeft: -9 }} /></button>
              {asOnSel && asOnSel !== meta?.to && <button type="button" className="wr-chip" onClick={() => setAsOnSel('')}>Latest</button>}
            </div>
            <Seg value={view} onChange={setView} options={[
              { value: 'command', label: 'Command', icon: Radar }, { value: 'snap', label: 'Snap', icon: LayoutGrid },
              { value: 'league', label: 'League', icon: ListOrdered, badge: board ? stores.length : null }, { value: 'store', label: 'Store', icon: StoreIcon }]} />
            <div className="wr-cmd-r">
              <Seg size="sm" value={measure} onChange={setMeasure} options={[{ value: 'val', label: '₹', icon: IndianRupee }, { value: 'qty', label: 'Units', icon: Package }]} />
              <button type="button" className="wr-iconbtn" onClick={() => window.print()} aria-label="Print"><Printer size={15} /></button>
              <button type="button" className="wr-btn" onClick={doExport} disabled={!board || busy === 'export'}><Download size={14} /> {busy === 'export' ? '…' : 'Excel'}</button>
            </div>
          </div>

          {(chips.length > 0 || board?.scoped) && (
            <div className="wr-chips">
              <Filter size={13} className="mute" />
              {chips.map(({ k, v }) => (
                <button type="button" key={`${k}:${v}`} className="wr-fchip" onClick={() => onFilter(k, list(lens[k]).filter((x) => x !== v))}>
                  <em>{LENS_NAMES[k]}</em>{v}<X size={11} />
                </button>
              ))}
              {chips.length > 0 && <button type="button" className="wr-chip" onClick={() => filtersApi.clearAll()}>Clear</button>}
              {board?.scoped && <span className="wr-scoped">Product view · bills, UPT, ATV n/a</span>}
              <span className="wr-count">{num(stores.length)} / {num(all.length)} stores</span>
            </div>
          )}

          {failed && !board ? <LoadError label="War Room unavailable" onRetry={() => setRetryN((n) => n + 1)} minHeight={320} />
            : !board ? (
              <div className="wr-view"><div className="wr-tiles">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="wr-tile"><Shim h={12} w="40%" /><div style={{ height: 14 }} /><Shim h={30} w="70%" /><div style={{ height: 10 }} /><Shim h={12} w="55%" /></div>)}</div>
                <div className="wr-tri">{[0, 1, 2].map((i) => <div key={i} className="wr-card" style={{ padding: 20 }}><Shim h={220} /></div>)}</div></div>
            ) : (
              <div className={`wr-stage${loading ? ' is-loading' : ''}`} aria-busy={loading}>
                {stores.length === 0 ? <div className="wr-empty">No stores match. <button type="button" className="wr-chip" onClick={() => filtersApi.clearAll()}>Clear</button></div>
                  : view === 'command' ? <CommandView board={board} stores={stores} statusBase={statusBase} measure={measure} isDark={isDark} onFilter={onFilter} onToggle={onToggle} onOpen={openStore} lens={lens} />
                    : view === 'snap' ? <SnapView board={board} stores={stores} onFilter={onFilter} />
                      : view === 'league' ? <LeagueView stores={stores} measure={measure} onOpen={openStore} />
                        : current ? <StoreView board={board} store={current} list={stores} network={all} onNav={setStoreCode} onSaved={onSaved} measure={measure} isDark={isDark} />
                          : <div className="wr-empty">—</div>}
              </div>
            )}
        </div>
      </DashboardLayout>
    </FiltersProvider>
  );
}
