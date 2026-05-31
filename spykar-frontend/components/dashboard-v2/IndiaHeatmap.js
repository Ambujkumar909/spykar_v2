// ─── IndiaHeatmap — the slide every CEO asks for ────────────────────────────
// State-level choropleth of net sales, with hover tooltip showing the state's
// stats.  Uses react-simple-maps + a TopoJSON of India in /public/maps/.
//
// Color scale: 5-step quantile from a near-white base to brand red, so the
// strongest selling states pop visually without rainbow noise.
//
// State-name normalisation: TopoJSON uses Title Case ("Maharashtra"); our
// SQL upper-cases the column ("MAHARASHTRA").  We compare uppercased.

import { useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import dynamic from 'next/dynamic';
import { formatINR, formatCompact } from '../../lib/v2/format';

// react-simple-maps is window-only.  Skip SSR.
const ComposableMap = dynamic(() => import('react-simple-maps').then(m => m.ComposableMap), { ssr: false });
const Geographies   = dynamic(() => import('react-simple-maps').then(m => m.Geographies),   { ssr: false });
const Geography     = dynamic(() => import('react-simple-maps').then(m => m.Geography),     { ssr: false });

const TOPO_URL = '/maps/india-states.json';

// Quantile color scale — base "no-sale" → 5 brand-red shades.
const SCALE = ['#FCE7E9', '#F4B6BC', '#E97582', '#D63B4A', '#A11625', '#6B0E18'];

function pickColor(value, breakpoints) {
  if (!value || !breakpoints || breakpoints.length === 0) return SCALE[0];
  for (let i = 0; i < breakpoints.length; i++) {
    if (value <= breakpoints[i]) return SCALE[Math.min(i + 1, SCALE.length - 1)];
  }
  return SCALE[SCALE.length - 1];
}

// Aliases for state names that differ between our DB and the TopoJSON.
const ALIASES = {
  'ORISSA':           'orissa',          // both spellings exist; map names this
  'ODISHA':           'orissa',
  'UTTARAKHAND':      'uttaranchal',     // TopoJSON uses old name "Uttaranchal"
  'JAMMU & KASHMIR':  'jammu and kashmir',
  'NEW DELHI':        'delhi',
  'TAMILNADU':        'tamil nadu',
  'PONDICHERRY': 'puducherry',
  'LADAKH': 'ladakh', 
};

// Override TopoJSON names with modern/correct display names for the tooltip.
const GEO_DISPLAY = {
  'uttaranchal': 'Uttarakhand',
  'orissa': 'Odisha',
  'jammu & kashmir':   'Jammu & Kashmir',      // ← add
  'jammu and kashmir': 'Jammu & Kashmir',      // ← add
  'ladakh':            'Ladakh',
};
const displayName = n => GEO_DISPLAY[(n || '').toLowerCase().trim()] || n;

const norm = s => (s || '').toUpperCase().trim();
const lookupKey = s => ALIASES[norm(s)] || norm(s).toLowerCase();

export default function IndiaHeatmap({ data, loading, preset, fromISO, toISO }) {
  const router = useRouter();
  const [hovered, setHovered] = useState(null);

  // Click a state → jump to the Sales page pre-filtered to that state AND on
  // the SAME date window the dashboard is currently showing.
  //   • state  : prefer the DB's canonical value (row.state_name) so it matches
  //              the Sales filter exactly (ILIKE, case-insensitive).
  //   • dates  : pass the dashboard's `preset` (Today/WTD/MTD/QTD/YTD) so the
  //              Sales page reproduces the identical range via the same
  //              useTimeRange hook; also pass explicit date_from/date_to so a
  //              custom dashboard range carries over too.
  const goToStateSales = (stateValue) => {
    const s = String(stateValue || '').trim();
    if (!s) return;
    const params = new URLSearchParams({ state: s });
    if (preset)  params.set('preset', preset);
    if (fromISO) params.set('date_from', fromISO);
    if (toISO)   params.set('date_to', toISO);
    router.push(`/sales?${params.toString()}`);
  };

  const indexed = useMemo(() => {
    const map = new Map();
    (data || []).forEach(r => {
      map.set(lookupKey(r.state_name), r);
    });
    return map;
  }, [data]);

  // Quantile breakpoints over net_value for the color scale.
  const breakpoints = useMemo(() => {
    const values = (data || []).map(r => Number(r.net_value || 0)).filter(v => v > 0).sort((a, b) => a - b);
    if (values.length === 0) return null;
    return [0.20, 0.40, 0.60, 0.80].map(q => values[Math.floor((values.length - 1) * q)]);
  }, [data]);

  const top = useMemo(
    () => (data || []).slice(0, 3).map(r => ({ name: r.state_name, value: Number(r.net_value || 0) })),
    [data]
  );

  return (
    <div className="v2-card" style={{ padding: 20, animation: 'v2FadeInUp 380ms var(--v2-ease) both' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <div>
          <div style={{
            fontFamily: 'var(--v2-font-display)',
            fontSize: 13, fontWeight: 800,
            letterSpacing: '0.08em', textTransform: 'uppercase',
            color: 'var(--v2-fg-tertiary)',
          }}>
            India · Sales by State
          </div>
          <div style={{ fontSize: 13, marginTop: 4, color: 'var(--v2-fg-secondary)' }}>
            {(data || []).length > 0
              ? `${data.length} states active · top 3: ${top.map(t => t.name).join(', ')}`
              : 'Where sales are happening'}
          </div>
        </div>
      </div>

      {loading ? (
        <div style={{ height: 380, background: 'var(--v2-bg-elevated)', borderRadius: 8 }} />
      ) : (
        <div style={{ position: 'relative' }}>
          {/* viewBox aspect tuned to match India's natural shape (~1:1.05).
              Previous 520×320 (1.625:1) letterboxed the geometry inside the
              card with empty top/bottom bands. New 480×460 lets the country
              fill the frame edge-to-edge. Scale bumped 750 → 880 + center
              nudged slightly south (82, 23) so Kashmir doesn't clip and
              Tamil Nadu reaches the bottom comfortably. SVG `height: auto`
              lets the card breathe responsively without a fixed-height
              letterbox; preserveAspectRatio keeps the map centered on
              wider/narrower viewports. */}
          <ComposableMap
            projection="geoMercator"
            projectionConfig={{ center: [80.5, 21.5], scale: 790 }}
            width={480} height={500}
            preserveAspectRatio="xMidYMid meet"
            style={{ width: '100%', height: 'auto', maxHeight: 500, display: 'block' }}
          >
            <Geographies geography={TOPO_URL}>
              {({ geographies }) =>
                geographies.map(geo => {
                  // AFTER
                  const geoName = geo.properties.name || geo.properties.NAME || '';
                  const geoKey = ALIASES[geoName.toUpperCase().trim()] || geoName.toLowerCase().trim();
                  const row = indexed.get(geoKey);
                  const fill = row ? pickColor(Number(row.net_value), breakpoints) : SCALE[0];
                  return (
                    <Geography
                      key={geo.rsmKey || geo.id}
                      geography={geo}
                      onMouseEnter={() => setHovered({ geoName, row })}
                      onMouseLeave={() => setHovered(null)}
                      onClick={() => goToStateSales(row ? row.state_name : geoName)}
                      style={{
                        default: { fill, stroke: '#FFFFFF', strokeWidth: 0.6, outline: 'none', cursor: 'pointer' },
                        hover:   { fill: row ? '#0A0B0D' : '#D2D6DD', stroke: '#FFFFFF', strokeWidth: 0.8, outline: 'none', cursor: 'pointer' },
                        pressed: { fill: row ? '#0A0B0D' : '#D2D6DD', outline: 'none' },
                      }}
                    />
                  );
                })
              }
            </Geographies>
          </ComposableMap>

          {/* Hover tooltip — overlaid in top-left of the map */}
          {hovered && (
            <div
              style={{
                position: 'absolute', top: 6, left: 6,
                padding: '8px 12px',
                background: 'var(--v2-bg-card)',
                border: '1px solid var(--v2-border-strong)',
                borderRadius: 8,
                boxShadow: '0 4px 12px rgba(10,11,13,0.10)',
                fontSize: 12, lineHeight: 1.5,
                pointerEvents: 'none',
                maxWidth: 220,
              }}
            >
              <div style={{ fontWeight: 700, color: 'var(--v2-fg-primary)' }}>
                {displayName(hovered.geoName)}
              </div>
              {hovered.row ? (
                <>
                  <div className="tabular-nums" style={{ color: 'var(--v2-fg-secondary)' }}>
                    Net sales <strong style={{ color: 'var(--v2-fg-primary)' }}>{formatINR(hovered.row.net_value)}</strong>
                  </div>
                  <div className="tabular-nums" style={{ color: 'var(--v2-fg-secondary)' }}>
                    {formatCompact(hovered.row.units_sold)} units · {hovered.row.store_count} stores
                  </div>
                  {Number(hovered.row.units_returned) > 0 && (
                    <div className="tabular-nums" style={{ color: 'var(--v2-fg-tertiary)', fontSize: 11 }}>
                      {hovered.row.units_returned} returned
                    </div>
                  )}
                </>
              ) : (
                <div style={{ color: 'var(--v2-fg-tertiary)' }}>No active stores</div>
              )}
            </div>
          )}

          {/* Color-scale legend */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, justifyContent: 'flex-end' }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--v2-fg-tertiary)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Less
            </span>
            {SCALE.map(c => (
              <span key={c} style={{ width: 14, height: 8, background: c, borderRadius: 2 }} />
            ))}
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--v2-fg-tertiary)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              More
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
