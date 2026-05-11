import { useState, useRef, useEffect, useCallback } from 'react';
import { Bot, Send, X, Minimize2, Maximize2, RotateCcw, Sparkles, GripHorizontal } from 'lucide-react';
import { aiService } from '../lib/services';
import { useAuth } from '../lib/auth-context';

// ─── Suggestion Bank ──────────────────────────────────────────────────────────
const SUGGESTIONS = [
  { cat: 'Stock Overview',  q: 'What is total stock across all locations?' },
  { cat: 'Stock Overview',  q: 'Which location has highest stock?' },
  { cat: 'Stock Overview',  q: 'Show stock by store type' },
  { cat: 'Stock Overview',  q: 'What is total inventory value?' },
  { cat: 'Stock Overview',  q: 'How many active locations?' },
  { cat: 'Stock Overview',  q: 'Show warehouse stock summary' },
  { cat: 'Top Sellers',     q: 'What are top 10 selling SKUs?' },
  { cat: 'Top Sellers',     q: 'Best selling colours this month' },
  { cat: 'Top Sellers',     q: 'Top 5 sizes by units sold' },
  { cat: 'Top Sellers',     q: 'Which store has highest sales?' },
  { cat: 'Top Sellers',     q: 'Top selling SKUs in last 30 days' },
  { cat: 'Top Sellers',     q: 'Best performing distributors' },
  { cat: 'Top Sellers',     q: 'Top 10 stores by revenue' },
  { cat: 'Returns',         q: 'Which SKU has highest returns?' },
  { cat: 'Returns',         q: 'Top 10 colours by return rate' },
  { cat: 'Returns',         q: 'Which store has most returns?' },
  { cat: 'Returns',         q: 'Return rate by size' },
  { cat: 'Returns',         q: 'Total returns this month' },
  { cat: 'Returns',         q: 'Compare sales vs returns by colour' },
  { cat: 'Slow Moving',     q: 'Show dead stock items' },
  { cat: 'Slow Moving',     q: 'Which SKUs have not sold in 90 days?' },
  { cat: 'Slow Moving',     q: 'Slow moving stock by location' },
  { cat: 'Slow Moving',     q: 'Stock ageing summary' },
  { cat: 'Slow Moving',     q: 'Never sold items with high stock' },
  { cat: 'Colours',         q: 'How many units of BLACK colour in stock?' },
  { cat: 'Colours',         q: 'Top colours by inventory value' },
  { cat: 'Colours',         q: 'Which colour sells fastest?' },
  { cat: 'Colours',         q: 'Colour-wise stock distribution' },
  { cat: 'Colours',         q: 'Show MID BLUE stock across locations' },
  { cat: 'Colours',         q: 'Least stocked colours' },
  { cat: 'Sizes',           q: 'Which size has maximum stock?' },
  { cat: 'Sizes',           q: 'Size-wise sales ranking' },
  { cat: 'Sizes',           q: 'Which size is most returned?' },
  { cat: 'Sizes',           q: 'Show stock for size 32' },
  { cat: 'Sizes',           q: 'Size distribution across warehouses' },
  { cat: 'Sizes',           q: 'Which sizes are running low?' },
  { cat: 'Locations',       q: 'Show all COCO store stock' },
  { cat: 'Locations',       q: 'Which distributor has lowest stock?' },
  { cat: 'Locations',       q: 'FOFO store performance' },
  { cat: 'Locations',       q: 'Stock distribution by zone' },
  { cat: 'Locations',       q: 'Show Delhi store inventory' },
  { cat: 'Locations',       q: 'Which city has highest sales?' },
  { cat: 'Locations',       q: 'Mumbai stores stock summary' },
  { cat: 'Locations',       q: 'State-wise inventory report' },
  { cat: 'Alerts',          q: 'Which items are out of stock?' },
  { cat: 'Alerts',          q: 'Show reorder alerts' },
  { cat: 'Alerts',          q: 'Low stock locations' },
  { cat: 'Alerts',          q: 'Critical stock alerts today' },
  { cat: 'Alerts',          q: 'Stores below safety stock level' },
  { cat: 'Trends',          q: 'Sales trend last 6 months' },
  { cat: 'Trends',          q: 'Monthly stock movement summary' },
  { cat: 'Trends',          q: 'Which month had highest sales?' },
  { cat: 'Trends',          q: 'Revenue trend by quarter' },
  { cat: 'Trends',          q: 'Year over year sales comparison' },
  { cat: 'Revenue',         q: 'Total revenue this year' },
  { cat: 'Revenue',         q: 'Revenue by store type' },
  { cat: 'Revenue',         q: 'Average selling price by size' },
  { cat: 'Revenue',         q: 'Top 10 stores by revenue' },
  { cat: 'Revenue',         q: 'Revenue contribution by colour' },
  { cat: 'Revenue',         q: 'Highest MRP items in stock' },
  { cat: 'Ageing',          q: 'Show 180+ day old stock' },
  { cat: 'Ageing',          q: 'Ageing bucket summary' },
  { cat: 'Ageing',          q: 'Dead stock value by location' },
  { cat: 'Ageing',          q: 'Items in 90-180 day bucket' },
  { cat: 'Ageing',          q: 'At-risk stock across network' },
  { cat: 'SKU',             q: 'Find SKU by colour and size' },
  { cat: 'SKU',             q: 'Show all black size L SKUs' },
  { cat: 'SKU',             q: 'How many unique SKUs in stock?' },
  { cat: 'SKU',             q: 'SKUs with zero stock' },
  { cat: 'SKU',             q: 'Top 20 SKUs by stock value' },
  { cat: 'SKU',             q: 'Which SKU moved most last week?' },
  { cat: 'Dispatch',        q: 'Recent dispatches summary' },
  { cat: 'Dispatch',        q: 'Dispatches by distributor' },
  { cat: 'Dispatch',        q: 'Pending dispatch orders' },
  { cat: 'Dispatch',        q: 'Stock dispatched this month' },
  { cat: 'Network',         q: 'Network health overview' },
  { cat: 'Network',         q: 'Fill rate by location type' },
  { cat: 'Network',         q: 'Zone-wise stock summary' },
  { cat: 'Network',         q: 'Underperforming locations' },
  { cat: 'Network',         q: 'Overstocked vs understocked stores' },
  { cat: 'Network',         q: 'Top 5 zones by inventory value' },
];

const CAT_COLORS = {
  'Stock Overview': '#A78BFA', 'Top Sellers': '#34D399', 'Returns': '#F87171',
  'Slow Moving': '#FBBF24',   'Colours': '#C084FC',     'Sizes': '#38BDF8',
  'Locations': '#22D3EE',     'Alerts': '#FB7185',      'Trends': '#818CF8',
  'Revenue': '#6EE7B7',       'Ageing': '#FCD34D',      'SKU': '#60A5FA',
  'Dispatch': '#FB923C',      'Network': '#94A3B8',      'Suggested': '#F472B6',
};

// ─── Premium Light Theme (matches website) ────────────────────────────────────
const T = {
  panelBg:       'var(--bg-card, #FFFFFF)',
  panelBorder:   'var(--border-default, rgba(15,23,42,0.1))',
  headerBg:      'linear-gradient(135deg, #C0392B 0%, #E74C3C 100%)',
  headerBorder:  'rgba(192,57,43,0.3)',
  accentRed:     '#C0392B',
  accentGold:    '#D4AF37',
  msgsBg:        'var(--bg-canvas, #F8FAFC)',
  userBubble:    'linear-gradient(135deg, #C0392B, #E74C3C)',
  userText:      '#FFFFFF',
  userBorder:    'rgba(192,57,43,0.4)',
  botBubble:     'var(--bg-card, #FFFFFF)',
  botBorder:     'var(--border-default, rgba(15,23,42,0.08))',
  botText:       'var(--text-primary, #1F2937)',
  botTextMuted:  'var(--text-muted, #6B7280)',
  timestampC:    'var(--text-disabled, #9CA3AF)',
  inputBg:       'var(--bg-elevated, #FFFFFF)',
  inputBorder:   'var(--border-default, rgba(15,23,42,0.15))',
  inputFocus:    '#C0392B',
  inputText:     'var(--text-primary, #1F2937)',
  sendBtnOn:     'linear-gradient(135deg, #C0392B, #E74C3C)',
  sendBtnOff:    'var(--bg-elevated, #F3F4F6)',
  chipBg:        'var(--bg-elevated, #FFF5F4)',
  chipBorder:    'var(--border-default, rgba(192,57,43,0.2))',
  chipText:      'var(--text-secondary, #374151)',
  divider:       'var(--border-subtle, rgba(15,23,42,0.08))',
  tableBg:       'var(--bg-card, #FFFFFF)',
  tableThBg:     'var(--bg-elevated, #FEF2F2)',
  tableThText:   'var(--text-secondary, #991B1B)',
  tableTdText:   'var(--text-secondary, #374151)',
  tableRowAlt:   'var(--bg-card-hover, #FFFAF9)',
  shadowColor:   'rgba(15,23,42,0.12)',
  glowColor:     'rgba(192,57,43,0.1)',
  fabGradient:   'linear-gradient(135deg, #C0392B, #E74C3C)',
  fabShadow:     'rgba(192,57,43,0.45)',
  resizeHandle:  'var(--text-muted, rgba(15,23,42,0.2))',
  scrollThumb:   'rgba(192,57,43,0.25)',
};

const DEFAULT_W = 440;
const DEFAULT_H = 640;
const MIN_W = 360;
const MIN_H = 480;
const MAX_W = 980;
const MAX_H = 900;

// ─── Inject CSS ───────────────────────────────────────────────────────────────
const CSS = `
  @keyframes slideUpElite {
    from { transform: translateY(24px) scale(0.97); opacity: 0; }
    to   { transform: translateY(0)    scale(1);    opacity: 1; }
  }
  @keyframes fadeInMsg {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0);   }
  }
  @keyframes pulseGlow {
    0%,100% { box-shadow: 0 0 0 0 ${T.fabShadow}, 0 6px 24px ${T.fabShadow}; }
    50%     { box-shadow: 0 0 0 10px rgba(192,57,43,0), 0 8px 32px ${T.fabShadow}; }
  }
  @keyframes badge { 0%,100%{transform:scale(1)} 50%{transform:scale(1.3)} }
  @keyframes spinSend { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
  @keyframes bounce3 {
    0%,60%,100%{transform:translateY(0);opacity:0.3}
    30%{transform:translateY(-5px);opacity:1}
  }
  @keyframes shimmer {
    0%   { background-position: -200% center; }
    100% { background-position:  200% center; }
  }
  @keyframes glowPulse {
    0%,100% { opacity: 0.4; }
    50%     { opacity: 1; }
  }
  .ai-scroll::-webkit-scrollbar { width: 4px; height: 4px; }
  .ai-scroll::-webkit-scrollbar-track { background: transparent; }
  .ai-scroll::-webkit-scrollbar-thumb { background: ${T.scrollThumb}; border-radius: 4px; }
  .ai-scroll::-webkit-scrollbar-thumb:hover { background: rgba(220,38,38,0.55); }
  .ai-chip-btn:hover { transform: translateY(-1px) !important; }
`;

function injectStyles() {
  if (typeof document !== 'undefined' && !document.getElementById('ai-elite-css')) {
    const s = document.createElement('style');
    s.id = 'ai-elite-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }
}

function groupByCategory(items) {
  const g = {};
  (items || []).forEach(item => {
    const cat = typeof item?.cat === 'string' ? item.cat : 'General';
    const q   = typeof item?.q   === 'string' ? item.q   : null;
    if (!q?.trim()) return;
    if (!g[cat]) g[cat] = [];
    g[cat].push(q.trim());
  });
  return g;
}

// ─── Shared formatters (used by DataTable) ────────────────────────────────────
const isRevenueCol = (key) => /revenue|value|mrp|amount|price|sales_val/i.test(key);

function fmtNum(n, key = '') {
  const prefix = isRevenueCol(key) ? '₹' : '';
  const abs = Math.abs(n);
  if (abs >= 10000000) return `${prefix}${(n / 10000000).toFixed(2)} Cr`;
  if (abs >= 100000)   return `${prefix}${(n / 100000).toFixed(2)} L`;
  if (abs >= 1000)     return `${prefix}${new Intl.NumberFormat('en-IN').format(Math.round(n))}`;
  return `${prefix}${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 }).format(n)}`;
}

function fmtVal(v, key = '') {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return fmtNum(v, key);
  if (typeof v === 'string') {
    if (v !== '' && !isNaN(Number(v)) && !/^\d{4}-\d{2}-\d{2}/.test(v)) return fmtNum(Number(v), key);
    if (/^\d{4}-\d{2}-\d{2}(T[\d:.Z+\-]+)?$/.test(v.trim())) {
      try {
        const d = new Date(v);
        if (!isNaN(d.getTime())) return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
      } catch (_) {}
    }
  }
  return String(v);
}

function isNumericCell(v) {
  if (typeof v === 'number') return true;
  if (typeof v === 'string' && v !== '' && !isNaN(Number(v)) && !/^\d{4}-\d{2}-\d{2}/.test(v)) return true;
  return false;
}

// ─── DataTable — preview + expandable drawer for 200+ rows ───────────────────
const PREVIEW_ROWS = 5;

function DataTable({ rows }) {
  const [expanded, setExpanded] = useState(false);

  if (!rows?.length) return null;

  const keys    = Object.keys(rows[0]);
  const total   = rows.length;
  const hasMore = total > PREVIEW_ROWS;
  const display = expanded ? rows : rows.slice(0, PREVIEW_ROWS);

  const thStyle = {
    padding: '7px 12px', color: T.tableThText, fontWeight: 700, fontSize: 10,
    textTransform: 'uppercase', letterSpacing: '0.07em',
    textAlign: 'left', whiteSpace: 'nowrap',
    borderBottom: `1px solid rgba(192,57,43,0.15)`,
    background: T.tableThBg,
  };

  return (
    <div style={{ marginTop: 12, borderRadius: 10, overflow: 'hidden', border: `1px solid ${T.botBorder}`, boxShadow: `0 2px 8px rgba(15,23,42,0.06)` }}>

      {/* Header bar */}
      <div style={{ padding: '5px 12px', background: T.tableThBg, borderBottom: `1px solid rgba(192,57,43,0.1)`, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: T.tableThText, letterSpacing: '0.06em', textTransform: 'uppercase', flex: 1 }}>
          {total} row{total !== 1 ? 's' : ''} · {keys.length} column{keys.length !== 1 ? 's' : ''}
        </span>
        {hasMore && (
          <button
            onClick={() => setExpanded(e => !e)}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              fontSize: 10, fontWeight: 700, color: T.accentRed,
              background: 'rgba(192,57,43,0.08)', border: `1px solid rgba(192,57,43,0.25)`,
              borderRadius: 6, padding: '3px 10px', cursor: 'pointer',
              transition: 'all 0.15s', letterSpacing: '0.03em',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(192,57,43,0.15)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(192,57,43,0.08)'; }}
          >
            {expanded
              ? <>▲ Collapse</>
              : <>▼ {total - PREVIEW_ROWS} more rows</>
            }
          </button>
        )}
      </div>

      {/* Table */}
      <div
        className="ai-scroll"
        style={{
          overflowX: 'auto',
          overflowY: expanded ? 'auto' : 'visible',
          maxHeight: expanded ? '460px' : 'none',
          transition: 'max-height 0.3s ease',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
          <thead style={{ position: expanded ? 'sticky' : 'relative', top: 0, zIndex: 2 }}>
            <tr>
              <th style={{ ...thStyle, minWidth: 28, padding: '7px 8px' }}>#</th>
              {keys.map(k => (
                <th key={k} style={thStyle}>{k.replace(/_/g, ' ')}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {display.map((row, i) => (
              <tr key={i}
                style={{ background: i % 2 === 0 ? T.tableBg : T.tableRowAlt, transition: 'background 0.1s' }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(192,57,43,0.06)'}
                onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? T.tableBg : T.tableRowAlt}>
                <td style={{ padding: '6px 8px', color: '#C4C9D4', fontSize: 10, borderBottom: `1px solid rgba(192,57,43,0.05)`, whiteSpace: 'nowrap' }}>
                  {i + 1}
                </td>
                {keys.map(k => (
                  <td key={k} style={{
                    padding: '6px 12px', borderBottom: `1px solid rgba(192,57,43,0.05)`,
                    whiteSpace: 'nowrap', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 12,
                  }}>
                    {isNumericCell(row[k])
                      ? <span style={{ fontWeight: 600, color: '#1D4ED8', fontVariantNumeric: 'tabular-nums' }}>{fmtVal(row[k], k)}</span>
                      : <span style={{ color: T.tableTdText }}>{fmtVal(row[k], k)}</span>
                    }
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Footer expand button (larger, visible below table) */}
      {hasMore && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            width: '100%', padding: '8px',
            background: 'rgba(192,57,43,0.05)',
            border: 'none', borderTop: `1px solid rgba(192,57,43,0.1)`,
            color: T.accentRed, fontSize: 11, fontWeight: 700,
            cursor: 'pointer', letterSpacing: '0.04em',
            transition: 'background 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(192,57,43,0.12)'}
          onMouseLeave={e => e.currentTarget.style.background = 'rgba(192,57,43,0.05)'}
        >
          ▼ Show all {total} rows
        </button>
      )}
    </div>
  );
}

// ─── Typing Dots ──────────────────────────────────────────────────────────────
function TypingDots() {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, animation: 'fadeInMsg 0.25s ease forwards', padding: '2px 0' }}>
      <div style={{ width: 30, height: 30, borderRadius: '50%', background: T.userBubble, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 2, border: `1px solid ${T.userBorder}`, boxShadow: `0 0 12px ${T.glowColor}` }}>
        <Bot size={14} color="#fff" />
      </div>
      <div style={{ background: T.botBubble, border: `1px solid ${T.botBorder}`, borderRadius: '4px 14px 14px 14px', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 5, boxShadow: `0 1px 4px rgba(15,23,42,0.06)` }}>
        {[0, 1, 2].map(i => (
          <span key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: T.accentRed, display: 'inline-block', animation: `bounce3 1.2s ease-in-out ${i * 0.2}s infinite` }} />
        ))}
      </div>
    </div>
  );
}

// ─── Bubble ───────────────────────────────────────────────────────────────────
function Bubble({ msg }) {
  const isUser = msg.role === 'user';
  const time   = new Date(msg.id).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div style={{ display: 'flex', flexDirection: isUser ? 'row-reverse' : 'row', alignItems: 'flex-start', gap: 10, animation: 'fadeInMsg 0.3s ease forwards', padding: '2px 0' }}>
      {!isUser && (
        <div style={{ width: 30, height: 30, borderRadius: '50%', background: T.userBubble, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 2, border: `1px solid ${T.userBorder}`, boxShadow: `0 0 10px ${T.glowColor}` }}>
          <Bot size={14} color="#fff" />
        </div>
      )}
      <div style={{ maxWidth: '84%', minWidth: 0 }}>
        <div style={{
          padding: '11px 15px',
          borderRadius: isUser ? '14px 4px 14px 14px' : '4px 14px 14px 14px',
          background: isUser ? T.userBubble : msg.error ? 'rgba(220,38,38,0.10)' : T.botBubble,
          border: isUser ? `1px solid ${T.userBorder}` : msg.error ? '1px solid #FECACA' : `1px solid ${T.botBorder}`,
          color: isUser ? T.userText : msg.error ? '#991B1B' : T.botText,
          fontSize: 13, lineHeight: 1.6, wordBreak: 'break-word',
          boxShadow: isUser
            ? `0 4px 20px rgba(220,38,38,0.35), inset 0 1px 0 rgba(255,255,255,0.1)`
            : `0 1px 4px rgba(15,23,42,0.06)`,
        }}>
          {msg.text}
          {msg.rows && <DataTable rows={msg.rows} />}
        </div>
        <div style={{ fontSize: 10, color: T.timestampC, marginTop: 4, textAlign: isUser ? 'right' : 'left', paddingLeft: isUser ? 0 : 4, paddingRight: isUser ? 4 : 0, letterSpacing: '0.03em' }}>
          {time}
        </div>
      </div>
    </div>
  );
}

// ─── Chip panel ───────────────────────────────────────────────────────────────
function Chips({ suggestions, onSelect }) {
  const grouped = groupByCategory(suggestions);
  return (
    <div style={{ padding: '4px 0 10px' }}>
      {Object.keys(grouped).map(cat => (
        <div key={cat} style={{ marginBottom: 6 }}>
          <div style={{ padding: '4px 16px 5px', fontSize: 9.5, fontWeight: 800, color: CAT_COLORS[cat] || T.accentRed, textTransform: 'uppercase', letterSpacing: '0.09em', display: 'flex', alignItems: 'center', gap: 5, opacity: 0.9 }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: CAT_COLORS[cat] || T.accentRed, display: 'inline-block', boxShadow: `0 0 6px ${CAT_COLORS[cat] || T.accentRed}` }} />
            {cat}
          </div>
          <div className="ai-scroll" style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '2px 16px 3px' }}>
            {grouped[cat].map((q, i) => {
              const c = CAT_COLORS[cat] || T.accentRed;
              return (
                <button key={i} className="ai-chip-btn" onClick={() => onSelect(q)} style={{
                  flexShrink: 0, padding: '5px 12px', borderRadius: 20,
                  border: `1px solid ${c}30`, background: `${c}10`,
                  color: T.chipText, fontSize: 11.5, cursor: 'pointer',
                  whiteSpace: 'nowrap', transition: 'all 0.18s ease',
                  fontWeight: 500, fontFamily: 'inherit', letterSpacing: '-0.01em',
                }}
                  onMouseEnter={e => { e.currentTarget.style.background = `${c}25`; e.currentTarget.style.color = c; e.currentTarget.style.borderColor = `${c}70`; e.currentTarget.style.boxShadow = `0 0 10px ${c}30`; }}
                  onMouseLeave={e => { e.currentTarget.style.background = `${c}10`; e.currentTarget.style.color = T.chipText; e.currentTarget.style.borderColor = `${c}30`; e.currentTarget.style.boxShadow = 'none'; }}>
                  {q}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function AiChatbot() {
  const { user } = useAuth();
  const [open,        setOpen]        = useState(false);
  const [messages,    setMessages]    = useState([]);
  const [input,       setInput]       = useState('');
  const [loading,     setLoading]     = useState(false);
  const [suggestions, setSuggestions] = useState(SUGGESTIONS);
  const [unread,      setUnread]      = useState(0);
  const [isVisible,   setIsVisible]   = useState(false);
  const [maximized,   setMaximized]   = useState(false);
  const greetedRef = useRef(false);

  // Resize state
  const [panelW, setPanelW] = useState(DEFAULT_W);
  const [panelH, setPanelH] = useState(DEFAULT_H);
  const resizeRef  = useRef(null);
  const isResizing = useRef(false);
  const startData  = useRef({});

  const endRef   = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => { injectStyles(); }, []);

  // ── Resize logic ──
  const onResizeMouseDown = useCallback((e, dir) => {
    e.preventDefault();
    e.stopPropagation();
    isResizing.current = true;
    startData.current  = { x: e.clientX, y: e.clientY, w: panelW, h: panelH, dir };
    document.body.style.userSelect = 'none';
    document.body.style.cursor     = dir === 'corner' ? 'nw-resize' : dir === 'left' ? 'ew-resize' : 'ns-resize';
  }, [panelW, panelH]);

  useEffect(() => {
    const onMove = (e) => {
      if (!isResizing.current) return;
      const { x, y, w, h, dir } = startData.current;
      const dx = x - e.clientX; // panel anchored bottom-right, so dragging left = wider
      const dy = y - e.clientY; // dragging up = taller
      if (dir === 'left' || dir === 'corner') {
        setPanelW(Math.min(MAX_W, Math.max(MIN_W, w + dx)));
      }
      if (dir === 'top' || dir === 'corner') {
        setPanelH(Math.min(MAX_H, Math.max(MIN_H, h + dy)));
      }
    };
    const onUp = () => {
      if (!isResizing.current) return;
      isResizing.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor     = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  useEffect(() => {
    if (open) {
      setIsVisible(true);
      setUnread(0);
      // Show greeting the very first time the chat is opened
      if (!greetedRef.current) {
        greetedRef.current = true;
        const displayName = user?.name
          ? user.name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
          : user?.role
            ? user.role.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
            : 'there';
        const hour = new Date().getHours();
        const timeGreet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
        setMessages([{
          role: 'bot',
          id: Date.now(),
          text: `${timeGreet}, ${displayName}! 👋\n\nI'm Spykar IQ — your AI inventory assistant. Ask me anything about stock, sales, returns, or store performance.\n\nHow can I help you today?`,
          error: false,
        }]);
      }
      setTimeout(() => { inputRef.current?.focus(); endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, 320);
    } else {
      const t = setTimeout(() => setIsVisible(false), 380);
      return () => clearTimeout(t);
    }
  }, [open, user]);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading, open]);

  useEffect(() => {
    let cancelled = false;
    aiService.getSuggestedQueries().then(res => {
      if (cancelled) return;
      const arr = res?.data?.data;
      if (Array.isArray(arr) && arr.length > 0) {
        const norm = arr.map(item => {
          const q = typeof item === 'string' ? item : (item?.question || item?.q || '');
          return typeof q === 'string' && q.trim() ? { cat: 'Suggested', q: q.trim() } : null;
        }).filter(Boolean);
        if (norm.length > 0) setSuggestions([...norm, ...SUGGESTIONS]);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const handleSubmit = useCallback(async (override) => {
    const question = (typeof override === 'string' && override.trim() ? override : input).trim();
    if (!question || loading) return;
    setMessages(p => [...p, { role: 'user', text: question, id: Date.now() }]);
    setInput('');
    setLoading(true);
    try {
      const res    = await aiService.query(question);
      const result = res?.data?.data;
      setMessages(p => [...p, {
        role: 'bot',
        text: result?.answer || result?.message || 'Here is what I found.',
        rows: result?.rows?.length ? result.rows : null,
        error: false, id: Date.now(),
      }]);
      if (!open) setUnread(n => n + 1);
    } catch (err) {
      setMessages(p => [...p, {
        role: 'bot',
        text: err?.response?.data?.message || err?.message || 'Something went wrong. Please try again.',
        error: true, id: Date.now(),
      }]);
      if (!open) setUnread(n => n + 1);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [input, loading, open]);

  const hasMessages  = messages.length > 0;
  const effectiveW   = maximized ? Math.min(window?.innerWidth  * 0.88, 1100) : panelW;
  const effectiveH   = maximized ? Math.min(window?.innerHeight * 0.88, 900)  : panelH;

  return (
    <>
      <div className="ai-chat-shell" style={{ position: 'fixed', bottom: 28, right: 28, zIndex: 9999, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', pointerEvents: 'none' }}>

        {/* ── Chat Panel ── */}
        {isVisible && (
          <div ref={resizeRef} className="ai-chat-panel" style={{
            width: effectiveW, height: effectiveH,
            borderRadius: 18,
            background: T.panelBg,
            border: `1px solid ${T.panelBorder}`,
            boxShadow: `0 32px 80px ${T.shadowColor}, 0 0 0 1px rgba(220,38,38,0.1), 0 0 60px ${T.glowColor}`,
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
            marginBottom: 16, pointerEvents: 'all',
            transform: open ? 'translateY(0) scale(1)' : 'translateY(110%) scale(0.95)',
            opacity: open ? 1 : 0,
            transition: isResizing.current ? 'none' : 'transform 0.35s cubic-bezier(0.4,0,0.2,1), opacity 0.3s cubic-bezier(0.4,0,0.2,1)',
            transformOrigin: 'bottom right',
            position: 'relative',
          }}>

            {/* ── Resize Handles ── */}
            {!maximized && (<>
              {/* Top edge */}
              <div onMouseDown={e => onResizeMouseDown(e, 'top')} style={{ position: 'absolute', top: 0, left: 16, right: 16, height: 6, cursor: 'ns-resize', zIndex: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ width: 40, height: 3, borderRadius: 3, background: T.resizeHandle, opacity: 0.6 }} />
              </div>
              {/* Left edge */}
              <div onMouseDown={e => onResizeMouseDown(e, 'left')} style={{ position: 'absolute', top: 16, left: 0, bottom: 16, width: 6, cursor: 'ew-resize', zIndex: 10 }} />
              {/* Top-left corner */}
              <div onMouseDown={e => onResizeMouseDown(e, 'corner')} style={{ position: 'absolute', top: 0, left: 0, width: 18, height: 18, cursor: 'nw-resize', zIndex: 11, borderRadius: '18px 0 0 0' }} />
            </>)}

            {/* ── Header ── */}
            <div style={{ background: T.headerBg, padding: '14px 16px 13px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, borderBottom: `1px solid ${T.headerBorder}`, position: 'relative', overflow: 'hidden' }}>
              {/* Gold shimmer line */}
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, background: 'linear-gradient(90deg, transparent 0%, rgba(212,175,55,0.6) 50%, transparent 100%)' }} />
              {/* Logo on white pill — preserves original colors on red header */}
              <div style={{ background: '#fff', borderRadius: 10, padding: '5px 12px', display: 'flex', alignItems: 'center', boxShadow: '0 2px 8px rgba(0,0,0,0.15)', flexShrink: 0 }}>
                <img
                  src="/spykar-logo.png"
                  alt="Spykar"
                  style={{ height: 28, width: 'auto', maxWidth: 130, objectFit: 'contain', objectPosition: 'center', display: 'block' }}
                  onError={e => { e.target.parentElement.style.display = 'none'; e.target.parentElement.nextSibling.style.display = 'flex'; }}
                />
              </div>
              {/* Fallback text if logo missing */}
              <div style={{ display: 'none', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <Bot size={18} color="#fff" />
                <span style={{ fontSize: 15, fontWeight: 800, color: '#fff', letterSpacing: '-0.02em' }}>Spykar IQ</span>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#4ADE80', display: 'inline-block', boxShadow: '0 0 6px #4ADE80', animation: 'glowPulse 2s ease-in-out infinite', flexShrink: 0 }} />
                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.75)', letterSpacing: '0.01em' }}>Inventory Intelligence · Online</span>
                </div>
              </div>
              {/* Header buttons */}
              {/* NOTE: header is always the red gradient (theme-independent),
                  so these buttons must NOT use var(--bg-elevated) — that
                  resolves to a near-white surface in day mode and makes the
                  white icons disappear against the red header. Hardcoded
                  translucent-white surface works in both day and night. */}
              {hasMessages && (
                <button onClick={() => { setMessages([]); setUnread(0); setTimeout(() => inputRef.current?.focus(), 50); }}
                  title="Clear chat"
                  style={{ background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.35)', borderRadius: 8, width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'all 0.18s', color: '#fff' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.32)'; e.currentTarget.style.color = '#fff'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.18)'; e.currentTarget.style.color = '#fff'; }}>
                  <RotateCcw size={13} />
                </button>
              )}
              <button onClick={() => setMaximized(m => !m)}
                title={maximized ? 'Restore' : 'Maximize'}
                style={{ background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.35)', borderRadius: 8, width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'all 0.18s', color: '#fff' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.32)'; e.currentTarget.style.color = '#fff'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.18)'; e.currentTarget.style.color = '#fff'; }}>
                {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              </button>
              <button onClick={() => setOpen(false)}
                title="Close"
                style={{ background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.35)', borderRadius: 8, width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'all 0.18s', color: '#fff' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(220,38,38,0.55)'; e.currentTarget.style.color = '#fff'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.5)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.18)'; e.currentTarget.style.color = '#fff'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.35)'; }}>
                <X size={14} />
              </button>
            </div>

            {/* ── Messages ── */}
            <div className="ai-scroll" style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 8px', background: T.msgsBg, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {!hasMessages ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 14, userSelect: 'none' }}>
                  <div style={{ width: 64, height: 64, borderRadius: 20, background: T.userBubble, border: '1px solid rgba(192,57,43,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 4px 20px rgba(192,57,43,0.3)` }}>
                    <Bot size={30} color="#F87171" />
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: '#F9FAFB', letterSpacing: '-0.03em' }}>Ask me anything</div>
                  <div style={{ fontSize: 12.5, color: T.botTextMuted, textAlign: 'center', maxWidth: 270, lineHeight: 1.6 }}>
                    Inventory · Sales · Returns · Alerts<br />
                    <span style={{ color: '#C0392B', fontSize: 11, fontWeight: 600, opacity: 0.7 }}>Powered by Gemini AI</span>
                  </div>
                </div>
              ) : (
                messages.map(msg => <Bubble key={msg.id} msg={msg} />)
              )}
              {loading && <TypingDots />}
              <div ref={endRef} />
            </div>

            {/* ── Quick Asks (when no messages) ── */}
            {!hasMessages && (
              <div style={{ borderTop: `1px solid ${T.divider}`, background: T.chipBg, flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 16px 4px', color: T.accentGold, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  <Sparkles size={11} color={T.accentGold} style={{ animation: 'glowPulse 2s ease-in-out infinite' }} />
                  Quick Asks
                </div>
                <div className="ai-scroll" style={{ overflowY: 'auto', maxHeight: 200 }}>
                  <Chips suggestions={suggestions} onSelect={q => handleSubmit(q)} />
                </div>
              </div>
            )}

            {/* ── Input ── */}
            <div style={{ padding: '10px 12px 13px', background: T.panelBg, borderTop: `1px solid ${T.divider}`, flexShrink: 0 }}>
              {/* Mini chips when chat active */}
              {hasMessages && (
                <div className="ai-scroll" style={{ display: 'flex', gap: 5, overflowX: 'auto', paddingBottom: 8 }}>
                  {suggestions.filter(s => typeof s?.q === 'string' && s.q.trim()).slice(0, 14).map((s, i) => (
                    <button key={i} onClick={() => handleSubmit(s.q)} style={{
                      flexShrink: 0, padding: '3px 10px', borderRadius: 14,
                      border: `1px solid ${T.chipBorder}`,
                      background: 'rgba(220,38,38,0.07)',
                      color: T.chipText, fontSize: 11, cursor: 'pointer',
                      whiteSpace: 'nowrap', transition: 'all 0.15s', fontWeight: 500, fontFamily: 'inherit',
                    }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(220,38,38,0.18)'; e.currentTarget.style.color = '#F87171'; e.currentTarget.style.borderColor = 'rgba(220,38,38,0.5)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'rgba(220,38,38,0.07)'; e.currentTarget.style.color = T.chipText; e.currentTarget.style.borderColor = 'rgba(220,38,38,0.25)'; }}>
                      {s.q}
                    </button>
                  ))}
                </div>
              )}
              {/* Textarea + send */}
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                <div style={{ flex: 1, border: `1.5px solid ${T.inputBorder}`, borderRadius: 14, background: T.inputBg, padding: '9px 13px', transition: 'border-color 0.2s, box-shadow 0.2s', boxShadow: '0 0 0 0 transparent' }}
                  onFocusCapture={e => { e.currentTarget.style.borderColor = T.inputFocus; e.currentTarget.style.boxShadow = `0 0 0 3px rgba(220,38,38,0.12)`; }}
                  onBlurCapture={e => { e.currentTarget.style.borderColor = T.inputBorder; e.currentTarget.style.boxShadow = 'none'; }}>
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
                    placeholder="Ask about inventory, sales, returns..."
                    rows={1}
                    style={{ width: '100%', border: 'none', outline: 'none', resize: 'none', background: 'transparent', fontSize: 13, color: T.inputText, lineHeight: 1.55, maxHeight: 100, overflowY: 'auto', fontFamily: 'inherit', caretColor: T.accentRed }}
                  />
                </div>
                <button
                  onClick={handleSubmit}
                  disabled={!input.trim() || loading}
                  style={{
                    width: 42, height: 42, borderRadius: 13, border: 'none',
                    background: !input.trim() || loading ? T.sendBtnOff : T.sendBtnOn,
                    cursor: !input.trim() || loading ? 'not-allowed' : 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0, transition: 'all 0.2s',
                    boxShadow: input.trim() && !loading ? `0 4px 16px rgba(220,38,38,0.4)` : 'none',
                    border: `1px solid ${input.trim() && !loading ? 'rgba(220,38,38,0.5)' : 'rgba(255,255,255,0.05)'}`,
                  }}
                  onMouseEnter={e => { if (input.trim() && !loading) { e.currentTarget.style.transform = 'scale(1.07)'; e.currentTarget.style.boxShadow = '0 6px 24px rgba(220,38,38,0.55)'; }}}
                  onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = input.trim() && !loading ? '0 4px 16px rgba(220,38,38,0.4)' : 'none'; }}>
                  <Send size={16} color={!input.trim() || loading ? '#4B2020' : '#fff'} style={loading ? { animation: 'spinSend 1s linear infinite' } : {}} />
                </button>
              </div>
              <div style={{ fontSize: 10, color: '#9CA3AF', textAlign: 'center', marginTop: 6, letterSpacing: '0.03em' }}>
                Press Enter to send · Shift+Enter for new line
              </div>
            </div>
          </div>
        )}

        {/* ── FAB ── */}
        <button
          className="ai-chat-fab"
          onClick={() => setOpen(o => !o)}
          style={{
            width: 58, height: 58, borderRadius: '50%', border: '1px solid rgba(220,38,38,0.5)',
            background: T.fabGradient,
            boxShadow: `0 6px 28px ${T.fabShadow}`,
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'all', position: 'relative', flexShrink: 0,
            transition: 'transform 0.3s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.2s',
            animation: !open ? 'pulseGlow 2.5s ease-in-out infinite' : 'none',
          }}
          onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.1)'; e.currentTarget.style.animation = 'none'; e.currentTarget.style.boxShadow = `0 8px 36px ${T.fabShadow}`; }}
          onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; if (!open) e.currentTarget.style.animation = 'pulseGlow 2.5s ease-in-out infinite'; e.currentTarget.style.boxShadow = `0 6px 28px ${T.fabShadow}`; }}>
          <div style={{ transition: 'transform 0.3s cubic-bezier(0.34,1.56,0.64,1)', transform: open ? 'rotate(90deg) scale(0.85)' : 'rotate(0deg) scale(1)' }}>
            {open ? <X size={22} color="#fff" /> : <Bot size={22} color="#fff" />}
          </div>
          {!open && unread > 0 && (
            <div style={{ position: 'absolute', top: -3, right: -3, width: 20, height: 20, borderRadius: '50%', background: 'linear-gradient(135deg,#EF4444,#DC2626)', border: '2px solid #fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 800, color: '#fff', animation: 'badge 1.2s ease-in-out infinite' }}>
              {unread > 9 ? '9+' : unread}
            </div>
          )}
        </button>
      </div>
    </>
  );
}
