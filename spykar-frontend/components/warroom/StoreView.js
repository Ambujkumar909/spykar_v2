// ─── War Room · Store — one store, its numbers, and the ASM's review ─────────
import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, NotebookPen, Save, History, MapPin, Store as StoreIcon, Award, Flame } from 'lucide-react';
import { Card, StatusPill, Ring } from './ui';
import StorePicker from './StorePicker';
import { PeriodCard, TrendPanel, CategoryPanel, DriversPanel, PacePanel } from './Panels';
import { sumPeriods, sumWeeks, sumDays, sumCats, sumStock, sumTargets, runRate, growth, statusOf, reviewed, streak, weekRanks, inr, num, pct, share, fmtDay, monName } from './wrMath';
import { warRoomService } from '../../lib/services';
import { notifyApiError } from '../../lib/notifyApiError';

export default function StoreView({ board, store, list, network, onNav, onSaved, measure, isDark }) {
  const P = board.periods;
  const one = useMemo(() => [store], [store]);
  const A = useMemo(() => sumPeriods(one), [one]);
  const W = useMemo(() => sumWeeks(one, P.weeks.length), [one, P]);
  const Dd = useMemo(() => sumDays(one), [one]);
  const T = useMemo(() => sumTargets(one), [one]);
  const rr = store.t && store.t.month ? runRate(store.t.month[1], store.m.mtd[1], P) : null;
  const catSum = useMemo(() => sumCats(one, board.cats), [one, board.cats]);
  const stockSum = useMemo(() => sumStock(one, board.cats), [one, board.cats]);
  const [coreOnly, setCoreOnly] = useState(true);
  const idx = list.findIndex((s) => s.code === store.code);
  const go = (d) => { if (!list.length) return; const i = idx < 0 ? 0 : (idx + d + list.length) % list.length; onNav(list[i].code); };

  // rank by MTD ₹ growth (network / region) and by week growth with movement vs PW
  const rank = useMemo(() => {
    const ok = (s) => s.m.mtdly[1] > 0 && !['Closed', 'New'].includes(statusOf(s));
    const g = (s) => growth(s.m.mtd[1], s.m.mtdly[1]);
    const net = network.filter(ok).sort((a, b) => g(b) - g(a));
    const reg = net.filter((s) => s.region === store.region);
    return { net: net.findIndex((s) => s.code === store.code) + 1, netN: net.length, reg: reg.findIndex((s) => s.code === store.code) + 1, regN: reg.length, wk: weekRanks(network)[store.code] };
  }, [network, store]);
  const k = streak(store);

  const [asm, setAsm] = useState(''); const [reason, setReason] = useState(''); const [action, setAction] = useState('');
  const [state, setState] = useState('idle');
  useEffect(() => {
    setAsm(store.asm || ''); setReason(store.note?.reason || ''); setAction(store.note?.action || ''); setState('idle');
  }, [store.code]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (next) => {
    setState('saving');
    try {
      const r = await warRoomService.saveNote({ week_start: P.weekStart, external_id: store.code, asm: asm.trim(), reason: reason.trim(), action: action.trim() });
      onSaved(store.code, { asm: asm.trim(), reason: reason.trim(), action: action.trim(), by: r.data?.data?.by, at: new Date().toISOString() });
      setState('saved');
      if (next) go(1);
    } catch (e) { setState('dirty'); notifyApiError(e, 'Could not save'); }
  };
  const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(true); } };
  const dirty = () => setState('dirty');

  return (
    <div className="wr-view">
      <div className="wr-storenav">
        <button type="button" className="wr-btn ghost" onClick={() => go(-1)} aria-label="Previous store"><ChevronLeft size={15} /></button>
        <StorePicker stores={list} value={store.code} onChange={onNav} reviewed={reviewed} />
        <button type="button" className="wr-btn ghost" onClick={() => go(1)} aria-label="Next store"><ChevronRight size={15} /></button>
        <span className="wr-count">{idx + 1} / {list.length}</span>
      </div>

      <div className="wr-storehero">
        <div className="wr-storehero-l">
          <div className="wr-eyebrow"><StoreIcon size={12} /> {store.code} · {store.channel}</div>
          <h2>{store.name}</h2>
          <div className="wr-storemeta">
            <span><MapPin size={12} /> {store.city}, {store.state}</span><span>{store.region}</span><span>{store.type}</span>
            {store.opened && <span>Since {fmtDay(store.opened, true)}</span>}
            {store.asm && <span>ASM {store.asm}</span>}
          </div>
        </div>
        <div className="wr-storehero-r">
          {k >= 2 && <div className={`wr-streakbox ${k >= 3 ? 'neg' : 'warn'}`}><Flame size={14} /><b>{k}</b><span>weeks below LY</span></div>}
          <div className="wr-rankbox"><Award size={14} />
            <div><b>#{rank.net || '—'}</b><span>of {rank.netN} · MTD</span></div>
            <div><b>#{rank.reg || '—'}</b><span>of {rank.regN} · {store.region}</span></div>
            {rank.wk && <div><b>#{rank.wk.now}<i className={rank.wk.move > 0 ? 'pos' : rank.wk.move < 0 ? 'neg' : 'mute'}>{rank.wk.move > 0 ? ` ▲${rank.wk.move}` : rank.wk.move < 0 ? ` ▼${-rank.wk.move}` : ' ='}</i></b><span>week · vs PW</span></div>}
          </div>
          <StatusPill status={statusOf(store)} />
          {store.t && store.t.mtd && store.t.mtd[1] ? <Ring value={store.m.mtd[1] / store.t.mtd[1]} size={70} sub="MTD Ach" /> : null}
        </div>
      </div>
      {rr && rr.left > 0 && (
        <div className="wr-runrate">{monName(P.mtd[1])} Target <b>{inr(store.t.month[1])}</b> · Ach Val <b>{inr(store.m.mtd[1])}</b> ({share(rr.ach, 0)}) · need <b>{inr(Math.max(0, rr.perDay))}</b>/day for {rr.left} days · now <b>{inr(rr.pace)}</b>/day</div>
      )}

      <div className="wr-tri">
        <PeriodCard kind="week" P={P} A={A} measure={measure} T={T} />
        <PeriodCard kind="mtd" P={P} A={A} measure={measure} T={T} />
        <PeriodCard kind="ytd" P={P} A={A} measure={measure} T={T} />
      </div>

      <div className="wr-store2">
        <div className="wr-stack">
          <DriversPanel A={A} />
          <TrendPanel weeks={P.weeks} weeksLy={P.weeksLy} series={W} isDark={isDark} />
        </div>
        <Card icon={NotebookPen} eyebrow={`Week of ${fmtDay(P.weekStart)}`} title="ASM Inputs" className="wr-editor"
          right={<span className={`wr-state ${state}`}>{state === 'saving' ? 'Saving…' : state === 'saved' ? 'Updated' : state === 'dirty' ? 'Unsaved' : reviewed(store) ? 'Reviewed' : 'Pending'}</span>}>
          <div className="wr-field"><label htmlFor="wr-asm">ASM Name</label>
            <input id="wr-asm" value={asm} onChange={(e) => { setAsm(e.target.value); dirty(); }} onKeyDown={onKey} maxLength={80} autoComplete="off" /></div>
          <div className="wr-field"><label htmlFor="wr-reason">Reason</label>
            <textarea id="wr-reason" value={reason} onChange={(e) => { setReason(e.target.value); dirty(); }} onKeyDown={onKey} rows={4}
              placeholder={`MTD ${pct(growth(store.m.mtd[1], store.m.mtdly[1]))} vs LY`} maxLength={2000} /></div>
          <div className="wr-field"><label htmlFor="wr-action">Remark | Action</label>
            <textarea id="wr-action" value={action} onChange={(e) => { setAction(e.target.value); dirty(); }} onKeyDown={onKey} rows={4} maxLength={2000} /></div>
          <div className="wr-editor-a">
            <button type="button" className="wr-btn" onClick={() => save(false)} disabled={state === 'saving'}><Save size={14} /> Update</button>
            <button type="button" className="wr-btn primary" onClick={() => save(true)} disabled={state === 'saving'}>Update &amp; Next <ChevronRight size={14} /></button>
            <span className="wr-hint">Ctrl + Enter</span>
          </div>
          {store.note?.by && <div className="wr-hint">{store.note.by}{store.note.at ? ` · ${new Date(store.note.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}</div>}
          {store.prev && (
            <div className="wr-prevnote"><div className="wr-eyebrow"><History size={11} /> {fmtDay(store.prev.week, true)}{store.prev.by ? ` · ${store.prev.by}` : ''}</div>
              {store.prev.reason && <p><b>Reason</b> {store.prev.reason}</p>}{store.prev.action && <p><b>Remark | Action</b> {store.prev.action}</p>}</div>
          )}
        </Card>
      </div>

      <PacePanel days={Dd} P={P} isDark={isDark} />
      <CategoryPanel cats={board.cats} catSum={catSum} stockSum={stockSum} P={P} measure={measure} coreOnly={coreOnly} onCoreOnly={setCoreOnly} />
      <div className="wr-foot mute">Last sale {fmtDay(store.lastSale, true)} · YTD Qty {num(store.m.ytd[0])}</div>
    </div>
  );
}
