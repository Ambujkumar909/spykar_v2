// ─── WrMap — India by state, coloured by growth (diverging) ──────────────────
// Red ← 0 → green on the chosen GoLY; grey where a state has no LY base.
// Hover shows the state's numbers; click filters the page to that state.
import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { inr, pct, num } from './wrMath';

const ComposableMap = dynamic(() => import('react-simple-maps').then((m) => m.ComposableMap), { ssr: false });
const Geographies = dynamic(() => import('react-simple-maps').then((m) => m.Geographies), { ssr: false });
const Geography = dynamic(() => import('react-simple-maps').then((m) => m.Geography), { ssr: false });

const key = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');
const ALIAS = { orissa: 'odisha', uttaranchal: 'uttarakhand', newdelhi: 'delhi', pondicherry: 'puducherry', chattisgarh: 'chhattisgarh', tamilnadu: 'tamilnadu', jammukashmir: 'jammuandkashmir' };
const k2 = (s) => ALIAS[key(s)] || key(s);

// Diverging scale, symmetric around 0, saturating at ±cap.
function fill(g, cap) {
  if (g == null || !Number.isFinite(g)) return 'var(--wr-map-none)';
  const t = Math.max(-1, Math.min(1, g / cap));
  const a = 0.18 + 0.72 * Math.abs(t);
  return t >= 0 ? `rgba(16, 185, 129, ${a.toFixed(3)})` : `rgba(239, 68, 68, ${a.toFixed(3)})`;
}

export default function WrMap({ rows, onPick, selected = [], metric = 'MTD' }) {
  const [hover, setHover] = useState(null);
  const by = useMemo(() => new Map(rows.map((r) => [k2(r.state), r])), [rows]);
  const cap = useMemo(() => {
    const gs = rows.map((r) => Math.abs(r.g ?? 0)).filter(Number.isFinite).sort((a, b) => a - b);
    return Math.max(0.1, gs[Math.floor(gs.length * 0.85)] || 0.25);
  }, [rows]);
  const sel = new Set(selected.map(k2));
  return (
    <div className="wr-map">
      <ComposableMap projection="geoMercator" projectionConfig={{ scale: 1000, center: [82.8, 22.6] }} width={600} height={640} style={{ width: '100%', height: 'auto' }}>
        <Geographies geography="/maps/india-states.json">
          {({ geographies }) => geographies.map((geo) => {
            const name = geo.properties.name; const r = by.get(k2(name)); const on = sel.has(k2(name));
            return (
              <Geography key={geo.rsmKey} geography={geo}
                onMouseEnter={() => setHover({ name, r })} onMouseLeave={() => setHover(null)}
                onClick={() => r && onPick && onPick(r.state)}
                style={{
                  default: { fill: r ? fill(r.g, cap) : 'var(--wr-map-empty)', stroke: on ? 'var(--wr-gold)' : 'var(--wr-map-line)', strokeWidth: on ? 1.6 : 0.6, outline: 'none', transition: 'fill 300ms' },
                  hover: { fill: r ? fill(r.g, cap) : 'var(--wr-map-empty)', stroke: 'var(--wr-gold)', strokeWidth: 1.4, outline: 'none', cursor: r ? 'pointer' : 'default' },
                  pressed: { outline: 'none' },
                }} />
            );
          })}
        </Geographies>
      </ComposableMap>
      <div className="wr-map-legend">
        <span>{pct(-cap, 0)}</span><i /><span>0</span><i className="g" /><span>{pct(cap, 0)}</span>
      </div>
      {hover && (
        <div className="wr-map-tip">
          <b>{hover.name}</b>
          {hover.r ? (
            <>
              <div><span>{metric} sales</span><em>{inr(hover.r.ty)}</em></div>
              <div><span>Last year</span><em>{inr(hover.r.ly)}</em></div>
              <div><span>GoLY</span><em className={hover.r.g >= 0 ? 'pos' : 'neg'}>{pct(hover.r.g)}</em></div>
              <div><span>Stores</span><em>{num(hover.r.n)}</em></div>
            </>
          ) : <div className="mute">No stores in view</div>}
        </div>
      )}
    </div>
  );
}
