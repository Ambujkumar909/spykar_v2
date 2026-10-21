// ─── StorePicker — single-choice store dropdown with search ─────────────────
// Type to filter by code, name, city, region or ASM; ↑ ↓ to move, Enter to
// pick, Esc to close. Reviewed stores carry a tick.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, ChevronDown, CheckCircle2, Store as StoreIcon } from 'lucide-react';

export default function StorePicker({ stores, value, onChange, reviewed }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const box = useRef(null); const input = useRef(null); const listRef = useRef(null);
  const cur = stores.find((s) => s.code === value);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return stores;
    return stores.filter((s) => `${s.code} ${s.name} ${s.city} ${s.region} ${s.asm || ''}`.toLowerCase().includes(t));
  }, [stores, q]);
  useEffect(() => { setHi(0); }, [q]);
  useEffect(() => {
    if (!open) return undefined;
    setTimeout(() => input.current?.focus(), 0);
    const off = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', off); return () => document.removeEventListener('mousedown', off);
  }, [open]);
  useEffect(() => { listRef.current?.querySelector(`[data-i="${hi}"]`)?.scrollIntoView({ block: 'nearest' }); }, [hi]);
  const pick = (s) => { if (!s) return; onChange(s.code); setOpen(false); setQ(''); };
  const key = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((i) => Math.min(shown.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(shown[hi]); }
    else if (e.key === 'Escape') { setOpen(false); }
  };
  return (
    <div className="wr-pick" ref={box}>
      <button type="button" className="wr-pick-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <StoreIcon size={14} />
        <span className="wr-pick-v">{cur ? <><b>{cur.code}</b> {cur.name}<em>{cur.city}</em></> : 'Choose a store'}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="wr-pick-pop" role="listbox">
          <div className="wr-pick-search"><Search size={14} />
            <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={key} placeholder="Search code, store, city, region, ASM" aria-label="Search stores" />
            <span>{shown.length}</span>
          </div>
          <div className="wr-pick-list" ref={listRef}>
            {shown.length === 0 && <div className="wr-pick-none">No store matches</div>}
            {shown.map((s, i) => (
              <button type="button" key={s.code} data-i={i} role="option" aria-selected={s.code === value}
                className={`wr-pick-o${i === hi ? ' hi' : ''}${s.code === value ? ' on' : ''}`} onMouseEnter={() => setHi(i)} onClick={() => pick(s)}>
                <b>{s.code}</b><span>{s.name}<em>{s.city} · {s.region}{s.asm ? ` · ${s.asm}` : ''}</em></span>
                {reviewed(s) && <CheckCircle2 size={14} className="pos" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
