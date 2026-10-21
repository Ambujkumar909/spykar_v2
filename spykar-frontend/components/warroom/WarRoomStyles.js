// ─── War Room design layer ───────────────────────────────────────────────────
// Scoped to .wr. Built on the app's tokens (globals.css) so dark / light both
// work; adds a champagne-gold hairline accent, glass cards with a soft inner
// glow, display numerals (Plus Jakarta Sans, tabular), and quiet motion.
export default function WarRoomStyles() {
  return (
    <style jsx global>{`
.wr {
  --wr-gold: #E9C46A; --wr-gold-2: #C9A227; --wr-red: #E11D48; --wr-ink: var(--bg-card);
  --wr-pos: #10B981; --wr-neg: #F43F5E; --wr-warn: #F59E0B; --wr-info: #60A5FA; --wr-violet: #A78BFA; --wr-crit: #E11D48;
  --wr-line: rgba(255,255,255,0.07); --wr-line-2: rgba(255,255,255,0.12);
  --wr-glass: linear-gradient(180deg, rgba(255,255,255,0.045), rgba(255,255,255,0.012));
  --wr-shadow: 0 1px 0 rgba(255,255,255,0.05) inset, 0 18px 40px -22px rgba(0,0,0,0.75), 0 2px 6px rgba(0,0,0,0.25);
  --wr-map-none: rgba(148,163,184,0.22); --wr-map-empty: rgba(148,163,184,0.08); --wr-map-line: rgba(255,255,255,0.18);
  --wr-num: 'Plus Jakarta Sans', 'Inter', sans-serif;
  position: relative; color: var(--text-primary); font-family: var(--font-body, Inter, sans-serif);
  font-variant-numeric: tabular-nums; padding-bottom: 48px;
}
html.theme-light .wr {
  --wr-gold: #B7791F; --wr-gold-2: #9A6512; --wr-pos: #059669; --wr-neg: #E11D48; --wr-warn: #D97706; --wr-info: #2563EB; --wr-violet: #7C3AED;
  --wr-line: rgba(15,23,42,0.07); --wr-line-2: rgba(15,23,42,0.12);
  --wr-glass: linear-gradient(180deg, rgba(255,255,255,0.96), rgba(255,255,255,0.88));
  --wr-shadow: 0 1px 0 rgba(255,255,255,0.9) inset, 0 16px 34px -24px rgba(15,23,42,0.35), 0 1px 3px rgba(15,23,42,0.08);
  --wr-map-none: rgba(100,116,139,0.18); --wr-map-empty: rgba(100,116,139,0.07); --wr-map-line: rgba(15,23,42,0.22);
}
.wr .pos { color: var(--wr-pos); } .wr .neg { color: var(--wr-neg); } .wr .mute { color: var(--text-muted); }
.wr button { font: inherit; color: inherit; }

/* ── crown + period ribbon ── */
.wr-crown { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin: 2px 0 12px; }
.wr-crown-mark { position: relative; display: inline-flex; align-items: center; gap: 8px; padding: 7px 14px 7px 11px; border-radius: 999px;
  font-family: var(--wr-num); font-weight: 800; font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase;
  background: linear-gradient(135deg, rgba(225,29,72,0.16), rgba(233,196,106,0.10)); border: 1px solid rgba(233,196,106,0.35); color: var(--text-primary); overflow: hidden; }
.wr-crown-mark svg { color: var(--wr-red); }
.wr-crown-mark i { position: absolute; inset: 0; background: linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.18) 50%, transparent 70%); transform: translateX(-100%); animation: wrSheen 5.5s ease-in-out infinite; }
@keyframes wrSheen { 0%, 70% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
.wr-ribbon { display: flex; gap: 6px; flex-wrap: wrap; }
.wr-ribbon span { display: inline-flex; gap: 6px; align-items: baseline; padding: 4px 10px; border-radius: 999px; font-size: 11.5px; color: var(--text-secondary);
  background: var(--bg-surface); border: 1px solid var(--wr-line); white-space: nowrap; }
.wr-ribbon b { font-weight: 700; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); }
.wr-ribbon span.ly { opacity: 0.8; } .wr-ribbon span.stk b { color: var(--wr-gold); } .wr-ribbon span.warn { border-color: rgba(245,158,11,0.4); color: var(--wr-warn); }

/* ── command bar ── */
.wr-cmd { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 10px 12px; margin: 0 0 12px;
  border-radius: 16px; background: color-mix(in srgb, var(--bg-surface) 82%, transparent); backdrop-filter: blur(14px) saturate(1.3);
  border: 1px solid var(--wr-line-2); box-shadow: var(--wr-shadow); }
.wr-cmd-date { display: flex; align-items: center; gap: 4px; }
.wr-cmd-r { display: flex; align-items: center; gap: 8px; margin-left: auto; flex-wrap: wrap; }
.wr-iconbtn { display: inline-flex; align-items: center; justify-content: center; height: 34px; min-width: 30px; padding: 0 6px; border-radius: 10px; cursor: pointer;
  background: transparent; border: 1px solid var(--wr-line); color: var(--text-secondary); transition: all 150ms; }
.wr-iconbtn:hover:not(:disabled) { border-color: var(--wr-gold); color: var(--text-primary); } .wr-iconbtn:disabled { opacity: 0.35; cursor: default; }
.wr-datebox { position: relative; display: inline-flex; align-items: center; gap: 9px; height: 38px; padding: 0 14px; border-radius: 12px; cursor: pointer;
  background: linear-gradient(135deg, rgba(225,29,72,0.10), rgba(233,196,106,0.08)); border: 1px solid rgba(233,196,106,0.38); }
.wr-datebox svg { color: var(--wr-gold); }
.wr-datebox span { display: flex; flex-direction: column; line-height: 1.05; }
.wr-datebox em { font-style: normal; font-size: 9.5px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--text-muted); }
.wr-datebox b { font-family: var(--wr-num); font-size: 14px; font-weight: 800; letter-spacing: -0.01em; }
.wr-datebox input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.wr-datebox input::-webkit-calendar-picker-indicator { position: absolute; inset: 0; width: 100%; height: 100%; cursor: pointer; }
.wr-btn { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 13px; border-radius: 10px; cursor: pointer; font-size: 12.5px; font-weight: 650;
  background: var(--bg-elevated); border: 1px solid var(--wr-line-2); color: var(--text-primary); transition: all 160ms; white-space: nowrap; }
.wr-btn:hover:not(:disabled) { border-color: var(--wr-gold); transform: translateY(-1px); }
.wr-btn.ghost { background: transparent; }
.wr-btn.primary { background: linear-gradient(135deg, #E11D48, #BE123C); border-color: transparent; color: #fff; box-shadow: 0 8px 20px -10px rgba(225,29,72,0.8); }
.wr-btn:disabled { opacity: 0.55; cursor: progress; }
.wr-chip { display: inline-flex; align-items: center; height: 26px; padding: 0 10px; border-radius: 999px; font-size: 11.5px; font-weight: 600; cursor: pointer;
  border: 1px solid var(--wr-line-2); background: transparent; color: var(--text-secondary); }
.wr-chip:hover, .wr-chip.on { border-color: var(--wr-gold); color: var(--text-primary); background: rgba(233,196,106,0.08); }
.wr-seg { display: inline-flex; padding: 3px; gap: 2px; border-radius: 12px; background: var(--bg-input); border: 1px solid var(--wr-line); }
.wr-seg button { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border: 0; border-radius: 9px; background: transparent; cursor: pointer;
  font-size: 12.5px; font-weight: 650; color: var(--text-muted); transition: all 180ms; white-space: nowrap; }
.wr-seg button:hover { color: var(--text-primary); }
.wr-seg button.on { color: var(--text-primary); background: var(--bg-elevated); box-shadow: 0 0 0 1px rgba(233,196,106,0.45), 0 6px 16px -10px rgba(0,0,0,0.6); }
.wr-seg button.on svg { color: var(--wr-red); }
.wr-seg button em { font-style: normal; font-size: 10px; padding: 1px 6px; border-radius: 999px; background: var(--wr-line-2); color: var(--text-secondary); }
.wr-seg-sm button { height: 26px; padding: 0 9px; font-size: 11.5px; }

/* ── filter chips ── */
.wr-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: -2px 0 12px; }
.wr-fchip { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 8px 0 10px; border-radius: 999px; cursor: pointer; font-size: 11.5px; font-weight: 600;
  background: rgba(225,29,72,0.10); border: 1px solid rgba(225,29,72,0.30); color: var(--text-primary); }
.wr-fchip em { font-style: normal; font-size: 9.5px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); }
.wr-fchip:hover { border-color: var(--wr-red); }
.wr-scoped { font-size: 11.5px; color: var(--wr-warn); padding: 3px 10px; border-radius: 999px; border: 1px dashed rgba(245,158,11,0.45); }
.wr-count { font-size: 11.5px; color: var(--text-muted); margin-left: auto; }

/* ── stage + layout ── */
.wr-stage { transition: opacity 220ms; } .wr-stage.is-loading { opacity: 0.55; pointer-events: none; }
.wr-view { display: flex; flex-direction: column; gap: 14px; animation: wrIn 420ms cubic-bezier(0.16,1,0.3,1) both; }
@keyframes wrIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.wr-empty { padding: 60px 20px; text-align: center; color: var(--text-muted); font-size: 14px; display: flex; gap: 10px; align-items: center; justify-content: center; }
.wr-empty.sm { padding: 26px 10px; font-size: 12.5px; }
.wr-shim { background: linear-gradient(90deg, var(--wr-line) 0%, var(--wr-line-2) 50%, var(--wr-line) 100%); background-size: 200% 100%; animation: wrShim 1.3s linear infinite; }
@keyframes wrShim { from { background-position: 200% 0; } to { background-position: -200% 0; } }

/* ── cards ── */
.wr-card { position: relative; border-radius: 18px; background: var(--wr-glass), var(--bg-card); border: 1px solid var(--wr-line); box-shadow: var(--wr-shadow); min-width: 0; }
.wr-card::before { content: ''; position: absolute; left: 18px; right: 18px; top: 0; height: 1px; background: linear-gradient(90deg, transparent, rgba(233,196,106,0.55), transparent); opacity: 0.6; }
.wr-card[data-accent='red']::before { background: linear-gradient(90deg, transparent, rgba(225,29,72,0.8), transparent); opacity: 0.9; }
.wr-card[data-accent='violet']::before { background: linear-gradient(90deg, transparent, rgba(167,139,250,0.8), transparent); }
.wr-card-h { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; padding: 15px 18px 6px; flex-wrap: wrap; }
.wr-card-t { display: flex; gap: 10px; align-items: center; min-width: 0; }
.wr-card-t h3 { margin: 1px 0 0; font-family: var(--wr-num); font-size: 15px; font-weight: 800; letter-spacing: -0.01em; }
.wr-card-ic { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 9px; color: var(--wr-gold);
  background: rgba(233,196,106,0.10); border: 1px solid rgba(233,196,106,0.22); flex-shrink: 0; }
.wr-card-r { display: flex; align-items: center; gap: 8px; }
.wr-card-b { padding: 6px 18px 16px; }
.wr-eyebrow { font-size: 10px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-muted); display: flex; align-items: center; gap: 5px; }
.wr-vs { font-size: 11.5px; color: var(--text-muted); display: inline-flex; gap: 8px; align-items: center; }

/* ── hero tiles ── */
.wr-tiles { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
.wr-tile { position: relative; overflow: hidden; border-radius: 18px; padding: 15px 16px 14px; background: var(--wr-glass), var(--bg-card); border: 1px solid var(--wr-line); box-shadow: var(--wr-shadow); display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.wr-tile::after { content: ''; position: absolute; width: 180px; height: 180px; right: -70px; top: -90px; border-radius: 50%; background: radial-gradient(closest-side, var(--wr-tile-glow, rgba(225,29,72,0.20)), transparent); pointer-events: none; }
.wr-accent-red { --wr-tile-glow: rgba(225,29,72,0.22); } .wr-accent-gold { --wr-tile-glow: rgba(233,196,106,0.20); } .wr-accent-violet { --wr-tile-glow: rgba(167,139,250,0.20); }
.wr-accent-sky { --wr-tile-glow: rgba(96,165,250,0.18); } .wr-accent-mint { --wr-tile-glow: rgba(16,185,129,0.18); }
.wr-tile-h { display: flex; gap: 10px; align-items: center; }
.wr-tile-ic { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 9px; background: var(--wr-line); color: var(--wr-gold); border: 1px solid var(--wr-line-2); flex-shrink: 0; }
.wr-tile-t { font-family: var(--wr-num); font-weight: 800; font-size: 13.5px; }
.wr-tile-b { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.wr-tile-main { min-width: 0; display: flex; flex-direction: column; gap: 7px; }
.wr-tile-v { font-family: var(--wr-num); font-size: clamp(20px, 1.75vw, 28px); font-weight: 800; letter-spacing: -0.025em; line-height: 1; white-space: nowrap; }
.wr-tile-d { display: flex; gap: 6px; flex-wrap: wrap; }
.wr-tile-s { font-size: 11.5px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; } .wr-tile-s b { color: var(--text-primary); font-weight: 700; }
.wr-kgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; }
.wr-kgrid div { display: flex; flex-direction: column; gap: 3px; }
.wr-kgrid span { font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-muted); }
.wr-kgrid b { font-family: var(--wr-num); font-size: 16px; font-weight: 800; letter-spacing: -0.02em; }
.wr-health { display: flex; flex-direction: column; gap: 8px; }
.wr-health-bar { display: flex; height: 10px; border-radius: 999px; overflow: hidden; gap: 2px; }
.wr-health-bar i { cursor: pointer; transition: filter 150ms; } .wr-health-bar i:hover { filter: brightness(1.25); }
.wr-hb-Growth { background: var(--wr-pos); } .wr-hb-Stable { background: var(--wr-info); } .wr-hb-Soft { background: var(--wr-warn); } .wr-hb-Degrowth { background: #FB7185; }
.wr-hb-Critical { background: var(--wr-crit); } .wr-hb-New { background: var(--wr-violet); } .wr-hb-Closed, .wr-hb-Notopen { background: rgba(148,163,184,0.45); }
.wr-health-leg { display: flex; flex-wrap: wrap; gap: 4px 8px; }
.wr-health-leg button { display: inline-flex; gap: 4px; align-items: center; background: none; border: 0; padding: 0; cursor: pointer; font-size: 11px; }
.wr-prog { display: inline-block; width: 70px; height: 5px; border-radius: 999px; background: var(--wr-line-2); overflow: hidden; } .wr-prog i { display: block; height: 100%; background: linear-gradient(90deg, var(--wr-gold), var(--wr-pos)); }

/* ── delta chips, pills, rings, sparks ── */
.wr-delta { display: inline-flex; align-items: center; gap: 3px; height: 22px; padding: 0 7px; border-radius: 999px; font-size: 11.5px; font-weight: 700; white-space: nowrap; border: 1px solid transparent; }
.wr-delta-sm { height: 19px; padding: 0 6px; font-size: 10.5px; }
.wr-delta-lbl { font-size: 9.5px; font-weight: 800; letter-spacing: 0.06em; opacity: 0.75; margin-right: 2px; }
.wr-delta.wr-pos { color: var(--wr-pos); background: rgba(16,185,129,0.12); border-color: rgba(16,185,129,0.22); }
.wr-delta.wr-neg { color: var(--wr-neg); background: rgba(244,63,94,0.12); border-color: rgba(244,63,94,0.24); }
.wr-delta.wr-warn { color: var(--wr-warn); background: rgba(245,158,11,0.12); border-color: rgba(245,158,11,0.22); }
.wr-delta.wr-flat { color: var(--text-secondary); background: var(--wr-line); }
.wr-delta.wr-mute { color: var(--text-muted); background: transparent; }
.wr-pill { display: inline-flex; align-items: center; height: 22px; padding: 0 9px; border-radius: 999px; font-size: 11px; font-weight: 750; letter-spacing: 0.02em; white-space: nowrap; }
.wr-pill-sm { height: 19px; padding: 0 7px; font-size: 10px; }
.wr-pill-pos { color: var(--wr-pos); background: rgba(16,185,129,0.14); } .wr-pill-info { color: var(--wr-info); background: rgba(96,165,250,0.14); }
.wr-pill-warn { color: var(--wr-warn); background: rgba(245,158,11,0.15); } .wr-pill-neg { color: #FB7185; background: rgba(251,113,133,0.14); }
.wr-pill-crit { color: #fff; background: linear-gradient(135deg, #E11D48, #9F1239); box-shadow: 0 0 0 1px rgba(225,29,72,0.4), 0 4px 12px -4px rgba(225,29,72,0.7); }
.wr-pill-violet { color: var(--wr-violet); background: rgba(167,139,250,0.15); } .wr-pill-mute { color: var(--text-muted); background: var(--wr-line); }
.wr-spark { display: block; overflow: visible; }
.wr-spark-ly { stroke: var(--text-muted); opacity: 0.45; stroke-dasharray: 2 2; }
.wr-spark-ty { stroke: var(--wr-gold); } .wr-spark-area { fill: rgba(233,196,106,0.12); } .wr-spark-dot { fill: var(--wr-gold); }
.wr-spark.is-down .wr-spark-ty { stroke: var(--wr-neg); } .wr-spark.is-down .wr-spark-area { fill: rgba(244,63,94,0.10); } .wr-spark.is-down .wr-spark-dot { fill: var(--wr-neg); }
.wr-spark.is-up .wr-spark-ty { stroke: var(--wr-pos); } .wr-spark.is-up .wr-spark-area { fill: rgba(16,185,129,0.10); } .wr-spark.is-up .wr-spark-dot { fill: var(--wr-pos); }

/* ── brief ── */
.wr-brief { position: relative; padding: 14px 18px 14px 18px; border-radius: 16px; border: 1px solid rgba(233,196,106,0.28);
  background: linear-gradient(135deg, rgba(233,196,106,0.08), rgba(225,29,72,0.05) 60%, transparent), var(--bg-card); }
.wr-brief-mark { display: inline-flex; align-items: center; gap: 6px; font-size: 10px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; color: var(--wr-gold); margin-bottom: 6px; }
.wr-brief ul { margin: 0; padding-left: 18px; display: grid; gap: 4px; } .wr-brief li { font-size: 13px; line-height: 1.5; color: var(--text-secondary); }
.wr-brief li::marker { color: var(--wr-gold); }

/* ── period triptych ── */
.wr-tri { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.wr-period-hero { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 4px 0 12px; border-bottom: 1px solid var(--wr-line); }
.wr-hero-v { font-family: var(--wr-num); font-size: clamp(22px, 1.9vw, 30px); font-weight: 800; letter-spacing: -0.03em; line-height: 1.05; white-space: nowrap; }
.wr-hero-sub { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.wr-notgt { font-size: 10.5px; color: var(--text-muted); border: 1px dashed var(--wr-line-2); border-radius: 999px; padding: 4px 10px; }
.wr-ptable { display: flex; flex-direction: column; padding: 8px 0; }
.wr-prow { display: grid; grid-template-columns: minmax(0, 1.25fr) 1fr 1fr 74px; gap: 8px; align-items: center; padding: 6px 0; font-size: 12.5px; border-bottom: 1px dashed var(--wr-line); }
.wr-prow:last-child { border-bottom: 0; }
.wr-prow.head { font-size: 9.5px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-muted); border-bottom: 1px solid var(--wr-line); padding-top: 0; }
.wr-prow.head span:not(:first-child) { text-align: right; }
.wr-prow-l { color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wr-prow-ty { text-align: right; font-weight: 750; font-family: var(--wr-num); } .wr-prow-ly { text-align: right; color: var(--text-muted); } .wr-prow-g { text-align: right; }
.wr-prow.strong .wr-prow-ty { font-size: 13.5px; } .wr-prow.tgt { background: rgba(233,196,106,0.05); border-radius: 8px; padding: 6px 6px; margin: 2px -6px 0; border-bottom: 0; }
.wr-kq { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; padding-top: 10px; border-top: 1px solid var(--wr-line); }
.wr-kq-i { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; padding: 8px 9px; border-radius: 11px; background: var(--wr-line); }
.wr-kq-l { font-size: 9.5px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-muted); }
.wr-kq-i b { font-family: var(--wr-num); font-size: 14px; font-weight: 800; letter-spacing: -0.02em; white-space: nowrap; }

/* ── categories / stock / mix ── */
.wr-catgrid { display: grid; grid-template-columns: 1.15fr 1fr 1fr; gap: 12px; }
.wr-ctable { display: flex; flex-direction: column; }
.wr-crow { display: grid; grid-template-columns: minmax(0, 1.6fr) 0.9fr 0.9fr 64px 52px; gap: 8px; align-items: center; padding: 7px 0; border-bottom: 1px dashed var(--wr-line); font-size: 12.5px; }
.wr-crow > span:not(:first-child) { text-align: right; }
.wr-crow.head { font-size: 9.5px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-muted); border-bottom: 1px solid var(--wr-line); }
.wr-crow .b { font-weight: 750; font-family: var(--wr-num); }
.wr-crow-n { display: flex; flex-direction: column; gap: 5px; font-weight: 650; }
.wr-dbar { position: relative; height: 5px; border-radius: 999px; background: var(--wr-line); overflow: hidden; }
.wr-dbar-ly { position: absolute; left: 0; top: 0; bottom: 0; background: var(--wr-line-2); border-radius: 999px; }
.wr-dbar-ty { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 999px; background: var(--wr-gold); transition: width 600ms cubic-bezier(0.16,1,0.3,1); }
.wr-dbar-ty.wr-pos { background: var(--wr-pos); } .wr-dbar-ty.wr-neg { background: var(--wr-neg); } .wr-dbar-ty.wr-warn { background: var(--wr-warn); }

/* ── geography ── */
.wr-geo { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); gap: 12px; }
.wr-map { position: relative; max-width: 470px; margin: 0 auto; }
.wr-map-legend { display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 10.5px; color: var(--text-muted); margin-top: -6px; }
.wr-map-legend i { width: 70px; height: 7px; border-radius: 999px; background: linear-gradient(90deg, rgba(239,68,68,0.9), rgba(239,68,68,0.18)); }
.wr-map-legend i.g { background: linear-gradient(90deg, rgba(16,185,129,0.18), rgba(16,185,129,0.9)); }
.wr-map-tip { position: absolute; top: 8px; right: 8px; min-width: 170px; padding: 10px 12px; border-radius: 12px; background: var(--bg-elevated); border: 1px solid var(--wr-line-2); box-shadow: var(--wr-shadow); font-size: 12px; pointer-events: none; }
.wr-map-tip b { display: block; font-family: var(--wr-num); font-size: 13px; margin-bottom: 5px; }
.wr-map-tip div { display: flex; justify-content: space-between; gap: 12px; padding: 2px 0; color: var(--text-muted); } .wr-map-tip em { font-style: normal; color: var(--text-primary); font-weight: 700; }
.wr-rank { display: flex; flex-direction: column; max-height: 520px; overflow: auto; }
.wr-rank-r { display: grid; grid-template-columns: 24px minmax(0, 1.4fr) minmax(0, 1fr) 64px 46px; gap: 10px; align-items: center; padding: 8px 6px; border: 0; border-bottom: 1px dashed var(--wr-line); background: none; cursor: pointer; text-align: left; border-radius: 8px; }
.wr-rank-r:hover { background: var(--wr-line); }
.wr-rank-i { font-family: var(--wr-num); font-weight: 800; font-size: 11px; color: var(--text-muted); text-align: center; }
.wr-rank-n { display: flex; flex-direction: column; font-size: 12.5px; font-weight: 700; min-width: 0; } .wr-rank-n em { font-style: normal; font-weight: 500; font-size: 10.5px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wr-rank-bar { position: relative; height: 8px; border-radius: 999px; background: var(--wr-line); }
.wr-rank-bar::after { content: ''; position: absolute; left: 50%; top: -3px; bottom: -3px; width: 1px; background: var(--wr-line-2); }
.wr-rank-bar i { position: absolute; top: 0; bottom: 0; border-radius: 999px; } .wr-rank-bar i.pos { background: var(--wr-pos); } .wr-rank-bar i.neg { background: var(--wr-neg); }
.wr-rank-g { text-align: right; font-weight: 800; font-size: 12px; font-family: var(--wr-num); } .wr-rank-a { text-align: right; font-size: 11px; color: var(--text-muted); }

/* ── movers / attention ── */
.wr-movers { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 12px; }
.wr-mv { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.wr-mv-h { display: flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; margin-bottom: 4px; }
.wr-mv-r, .wr-att-r { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 10px; align-items: center; width: 100%; padding: 7px 6px; border: 0; border-bottom: 1px dashed var(--wr-line); background: none; cursor: pointer; text-align: left; border-radius: 8px; }
.wr-mv-r:hover, .wr-att-r:hover { background: var(--wr-line); }
.wr-att-r { grid-template-columns: auto minmax(0, 1fr) auto auto; }
.wr-mv-n { display: flex; flex-direction: column; font-size: 12.5px; font-weight: 700; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wr-mv-n em { font-style: normal; font-size: 10.5px; font-weight: 500; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; }
.wr-mv-v { display: flex; flex-direction: column; align-items: flex-end; } .wr-mv-v b { font-family: var(--wr-num); font-size: 12.5px; } .wr-mv-v em { font-style: normal; font-size: 10.5px; color: var(--text-muted); }
.wr-att-rev { font-size: 10.5px; font-weight: 700; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--wr-line-2); color: var(--text-muted); }
.wr-att-rev.on { color: var(--wr-pos); border-color: rgba(16,185,129,0.35); }

/* ── tables (league / snap) ── */
.wr-league-bar, .wr-snapbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.wr-search { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px; border-radius: 11px; background: var(--bg-input); border: 1px solid var(--wr-line-2); min-width: 280px; flex: 0 1 420px; }
.wr-search input { flex: 1; background: none; border: 0; outline: 0; color: var(--text-primary); font-size: 13px; }
.wr-search:focus-within { border-color: var(--wr-gold); }
.wr-tablewrap { overflow: auto; border-radius: 16px; border: 1px solid var(--wr-line); background: var(--bg-card); box-shadow: var(--wr-shadow); max-height: 72vh; }
.wr-card .wr-tablewrap { box-shadow: none; max-height: none; border-radius: 12px; }
.wr-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12.5px; }
/* header: fixed 48px so the sticky total row can sit exactly beneath it */
.wr-table th { position: sticky; top: 0; z-index: 3; height: 48px; box-sizing: border-box; vertical-align: middle; background: var(--bg-elevated); text-align: right; padding: 6px 10px; font-size: 10px; font-weight: 800; letter-spacing: 0.09em; text-transform: uppercase; color: var(--text-muted); border-bottom: 1px solid var(--wr-line-2); cursor: pointer; white-space: nowrap; user-select: none; }
.wr-table th span { display: inline-flex; align-items: center; gap: 3px; } .wr-table th em { display: block; font-style: normal; font-size: 9px; letter-spacing: 0.04em; text-transform: none; font-weight: 600; opacity: 0.75; }
.wr-table th.on { color: var(--wr-gold); }
.wr-table th:nth-child(-n+4), .wr-table td:nth-child(-n+4) { text-align: left; }
.wr-snap th:first-child, .wr-snap td:first-child { text-align: left; }
.wr-snap th:not(:first-child), .wr-snap td:not(:first-child) { text-align: right; }
.wr-table td { padding: 8px 10px; text-align: right; border-bottom: 1px solid var(--wr-line); white-space: nowrap; vertical-align: middle; }
.wr-table td b { font-weight: 750; font-family: var(--wr-num); } .wr-table td em { display: block; font-style: normal; font-size: 10.5px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
.wr-table td .wr-delta { margin-left: 4px; }
.wr-table tbody tr { cursor: pointer; transition: background 120ms; } .wr-table tbody tr:hover td { background: var(--wr-line); }
.wr-table tbody tr:focus-visible { outline: 2px solid var(--wr-gold); outline-offset: -2px; }
.wr-table tr.is-rev td:first-child { box-shadow: inset 3px 0 0 var(--wr-pos); }
.wr-table tr.wr-total td { position: sticky; top: 48px; z-index: 2; font-weight: 700; cursor: default;
  background: linear-gradient(rgba(233,196,106,0.10), rgba(233,196,106,0.10)), var(--bg-elevated);   /* opaque: rows never show through */
  border-bottom: 2px solid rgba(233,196,106,0.45); box-shadow: 0 10px 14px -12px rgba(0,0,0,0.55); }
.wr-table tbody tr.wr-total:hover td { background: linear-gradient(rgba(233,196,106,0.10), rgba(233,196,106,0.10)), var(--bg-elevated); }
.wr-snap tr.wr-total td { position: static; }
.wr-table td.c { text-align: center; } .wr-table td.wr-pos { color: var(--wr-pos); font-weight: 700; } .wr-table td.wr-neg { color: var(--wr-neg); font-weight: 700; } .wr-table td.wr-warn { color: var(--wr-warn); font-weight: 700; }
.wr-tag { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; background: var(--wr-line); border: 1px solid var(--wr-line-2); }

/* ── store view ── */
.wr-storenav { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.wr-storehero { position: relative; overflow: hidden; display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; padding: 20px 22px; border-radius: 20px;
  background: radial-gradient(600px 220px at 0% 0%, rgba(225,29,72,0.16), transparent 70%), radial-gradient(500px 200px at 100% 100%, rgba(233,196,106,0.12), transparent 70%), var(--bg-card);
  border: 1px solid rgba(233,196,106,0.28); box-shadow: var(--wr-shadow); }
.wr-storehero h2 { margin: 4px 0 8px; font-family: var(--wr-num); font-size: clamp(20px, 2.3vw, 28px); font-weight: 800; letter-spacing: -0.03em; }
.wr-storemeta { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: var(--text-secondary); } .wr-storemeta span { display: inline-flex; gap: 5px; align-items: center; }
.wr-storehero-r { display: flex; align-items: center; gap: 14px; }
.wr-rankbox { display: flex; align-items: center; gap: 14px; padding: 10px 14px; border-radius: 14px; background: var(--wr-line); border: 1px solid var(--wr-line-2); }
.wr-rankbox svg { color: var(--wr-gold); } .wr-rankbox div { display: flex; flex-direction: column; line-height: 1.1; }
.wr-rankbox b { font-family: var(--wr-num); font-size: 18px; font-weight: 800; } .wr-rankbox span { font-size: 10px; color: var(--text-muted); }
.wr-runrate { font-size: 12.5px; color: var(--text-secondary); padding: 10px 14px; border-radius: 12px; border: 1px dashed rgba(233,196,106,0.4); background: rgba(233,196,106,0.05); }
.wr-runrate b { color: var(--text-primary); }
.wr-store2 { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 12px; }
.wr-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 10px; }
.wr-field label { font-size: 10px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-muted); }
.wr-field input, .wr-field textarea { width: 100%; box-sizing: border-box; border-radius: 11px; padding: 9px 11px; font: inherit; font-size: 13px; color: var(--text-primary); background: var(--bg-input); border: 1px solid var(--wr-line-2); resize: vertical; transition: border-color 150ms, box-shadow 150ms; }
.wr-field input:focus, .wr-field textarea:focus { outline: 0; border-color: var(--wr-gold); box-shadow: 0 0 0 3px rgba(233,196,106,0.15); }
.wr-editor-a { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wr-hint { font-size: 11px; color: var(--text-muted); display: inline-flex; align-items: center; gap: 5px; margin-top: 4px; }
.wr-state { font-size: 11px; font-weight: 700; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--wr-line-2); color: var(--text-muted); }
.wr-state.saved { color: var(--wr-pos); border-color: rgba(16,185,129,0.35); } .wr-state.dirty { color: var(--wr-warn); border-color: rgba(245,158,11,0.4); }
.wr-prevnote { margin-top: 12px; padding: 10px 12px; border-radius: 12px; background: var(--wr-line); font-size: 12px; color: var(--text-secondary); }
.wr-prevnote p { margin: 5px 0 0; } .wr-prevnote b { font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-muted); margin-right: 4px; }
.wr-foot { font-size: 11px; text-align: right; }

/* ── toast ── */
.wr-toast { position: fixed; right: 22px; bottom: 22px; z-index: 60; max-width: 460px; padding: 12px 16px; border-radius: 14px; font-size: 13px; background: var(--bg-elevated); border: 1px solid rgba(16,185,129,0.4); box-shadow: var(--wr-shadow); animation: wrIn 300ms both; }

/* ── health toggles: picked = bold, the rest faded; click again to clear ── */
.wr-health-bar i, .wr-health-leg button { transition: opacity 200ms, filter 200ms, transform 200ms, box-shadow 200ms; }
.wr-health-bar.picking i.off, .wr-health-leg.picking button.off { opacity: 0.28; filter: saturate(0.4); }
.wr-health-bar.picking i.on { filter: brightness(0.85) saturate(1.3); box-shadow: inset 0 0 0 1.5px rgba(255,255,255,0.55); }
.wr-health-leg button { padding: 2px 4px; border-radius: 999px; }
.wr-health-leg button.on { box-shadow: 0 0 0 1.5px var(--wr-gold); transform: translateY(-1px); }
.wr-health-leg button.on .wr-pill { filter: brightness(0.82) saturate(1.35); font-weight: 900; }
.wr-health-leg button.on b { color: var(--wr-gold); }
.wr-health-leg button:hover { opacity: 1 !important; filter: none !important; }

/* ── signals ── */
.wr-signals { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; }
.wr-sig { display: flex; flex-direction: column; gap: 3px; align-items: flex-start; padding: 10px 12px; border-radius: 14px; text-align: left; cursor: default;
  background: var(--bg-card); border: 1px solid var(--wr-line); box-shadow: var(--wr-shadow); min-width: 0; }
.wr-sig:not(:disabled) { cursor: pointer; } .wr-sig:not(:disabled):hover { border-color: var(--wr-gold); }
.wr-sig em { font-style: normal; font-size: 9.5px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-muted); }
.wr-sig b { font-family: var(--wr-num); font-size: 13.5px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.wr-sig.wr-pos { box-shadow: inset 3px 0 0 var(--wr-pos), var(--wr-shadow); } .wr-sig.wr-neg { box-shadow: inset 3px 0 0 var(--wr-neg), var(--wr-shadow); }
.wr-sig.wr-crit { box-shadow: inset 3px 0 0 var(--wr-crit), var(--wr-shadow); } .wr-sig.wr-warn { box-shadow: inset 3px 0 0 var(--wr-warn), var(--wr-shadow); }
.wr-two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.wr-stack { display: flex; flex-direction: column; gap: 12px; min-width: 0; }

/* ── what moved sales ── */
.wr-drv { display: flex; flex-direction: column; }
.wr-drv-r { display: grid; grid-template-columns: 56px repeat(4, minmax(0, 1fr)); gap: 10px; align-items: center; padding: 10px 0; border-bottom: 1px dashed var(--wr-line); }
.wr-drv-r:last-child { border-bottom: 0; }
.wr-drv-r.head { font-size: 9.5px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-muted); padding-top: 0; border-bottom: 1px solid var(--wr-line); }
.wr-drv-l { font-family: var(--wr-num); font-weight: 800; font-size: 12.5px; }
.wr-drv-r > span { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.wr-drv-r b { font-family: var(--wr-num); font-size: 14px; font-weight: 800; } .wr-drv-r em { font-style: normal; font-size: 10.5px; color: var(--text-muted); white-space: nowrap; }
.wr-drv-c { position: relative; padding-top: 7px; }
.wr-drv-c i { position: absolute; top: 0; left: 0; height: 3px; border-radius: 999px; } .wr-drv-c i.pos { background: var(--wr-pos); } .wr-drv-c i.neg { background: var(--wr-neg); }

/* ── bridge ── */
.wr-bridge { display: flex; flex-direction: column; }
.wr-br-r { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.4fr) 92px 62px; gap: 10px; align-items: center; padding: 7px 6px; border: 0; border-bottom: 1px dashed var(--wr-line); background: none; text-align: left; border-radius: 8px; cursor: pointer; }
button.wr-br-r:hover { background: var(--wr-line); }
.wr-br-r.end { cursor: default; font-family: var(--wr-num); font-weight: 800; font-size: 12px; color: var(--text-secondary); background: var(--wr-line); }
.wr-br-r.end b { text-align: right; }
.wr-br-n { font-size: 12.5px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wr-br-bar { position: relative; height: 10px; border-radius: 999px; background: var(--wr-line); }
.wr-br-bar::after { content: ''; position: absolute; left: 50%; top: -3px; bottom: -3px; width: 1px; background: var(--wr-line-2); }
.wr-br-bar i { position: absolute; top: 0; bottom: 0; border-radius: 999px; transition: width 500ms cubic-bezier(0.16,1,0.3,1); } .wr-br-bar i.pos { background: var(--wr-pos); } .wr-br-bar i.neg { background: var(--wr-neg); }
.wr-br-r > b { text-align: right; font-family: var(--wr-num); font-size: 12.5px; } .wr-br-r > em { font-style: normal; text-align: right; font-size: 11px; color: var(--text-muted); }

/* ── quadrant ── */
.wr-quad-k { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; margin-bottom: 4px; }
.wr-quad-k span { display: flex; flex-direction: column; gap: 1px; padding: 7px 9px; border-radius: 10px; background: var(--wr-line); font-size: 10.5px; color: var(--text-muted); }
.wr-quad-k b { font-family: var(--wr-num); font-size: 15px; } .wr-quad-k em { font-style: normal; font-weight: 700; }
.wr-quad-k .neg b, .wr-quad-k .neg em { color: var(--wr-neg); } .wr-quad-k .pos b { color: var(--wr-pos); } .wr-quad-k .warn b { color: var(--wr-warn); } .wr-quad-k .info b { color: var(--wr-info); }
.wr-qtip { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; font-size: 11.5px; } .wr-qtip b { font-size: 12.5px; } .wr-qtip span { opacity: 0.8; }

/* ── streaks, attention, league ── */
.wr-streak { display: inline-flex; align-items: center; gap: 3px; font-weight: 800; }
.wr-streakbox { display: flex; align-items: center; gap: 6px; padding: 10px 12px; border-radius: 14px; border: 1px solid var(--wr-line-2); }
.wr-streakbox b { font-family: var(--wr-num); font-size: 18px; } .wr-streakbox span { font-size: 10px; color: var(--text-muted); max-width: 64px; line-height: 1.1; }
.wr-streakbox.neg { color: var(--wr-neg); border-color: rgba(244,63,94,0.35); } .wr-streakbox.warn { color: var(--wr-warn); border-color: rgba(245,158,11,0.35); }
.wr-att-r { grid-template-columns: auto minmax(0, 1fr) auto 40px 22px; }
.wr-att-k { display: inline-flex; align-items: center; gap: 2px; font-size: 11px; font-weight: 800; color: var(--wr-neg); }
.wr-att-rev { text-align: center; padding: 2px 0; }
.wr-league th:nth-child(-n+5), .wr-league td:nth-child(-n+5) { text-align: left; }
.wr-league td:nth-child(2) { font-weight: 800; font-size: 11.5px; }
.wr-table td.pos { color: var(--wr-pos); } .wr-table td.neg { color: var(--wr-neg); }
.wr-rankbox i { font-style: normal; font-size: 11px; margin-left: 2px; }

/* ── sales vs stock (mix) ── */
.wr-mix2 { display: flex; flex-direction: column; }
.wr-mix2-r { display: grid; grid-template-columns: minmax(84px, 0.9fr) minmax(0, 1.2fr) minmax(0, 1.2fr) minmax(118px, 1fr); gap: 12px; align-items: center; padding: 9px 0; border-bottom: 1px dashed var(--wr-line); }
.wr-mix2-r.head { font-size: 10px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-muted); border-bottom: 1px solid var(--wr-line-2); padding-top: 0; }
.wr-mix2-r.head span { display: inline-flex; align-items: center; gap: 6px; }
.wr-mix2-r.head i { display: inline-block; width: 12px; height: 8px; border-radius: 3px; } .wr-mix2-r.head i.s { background: #E11D48; } .wr-mix2-r.head i.k { background: var(--wr-gold); }
.wr-mix2-n { font-size: 13px; font-weight: 700; }
.wr-mix2-c { display: flex; flex-direction: column; gap: 4px; }
.wr-mix2-c b { font-family: var(--wr-num); font-size: 14px; font-weight: 800; }
.wr-mix2-c i { display: block; height: 8px; border-radius: 999px; min-width: 2px; transition: width 600ms cubic-bezier(0.16,1,0.3,1); }
.wr-mix2-c.s b { color: #FB7185; } .wr-mix2-c.s i { background: linear-gradient(90deg, #E11D48, #FB7185); }
.wr-mix2-c.k b { color: var(--wr-gold); } .wr-mix2-c.k i { background: linear-gradient(90deg, var(--wr-gold-2), var(--wr-gold)); }
.wr-mix2-g { display: grid; grid-template-columns: 16px auto; column-gap: 6px; align-items: center; }
.wr-mix2-g b { font-family: var(--wr-num); font-size: 13.5px; font-weight: 800; } .wr-mix2-g em { grid-column: 2; font-style: normal; font-size: 11px; font-weight: 600; opacity: 0.85; }
.wr-mix2-g.hot { color: #FB7185; } .wr-mix2-g.slow { color: var(--wr-info); } .wr-mix2-g.bal { color: var(--wr-pos); }

/* ── store picker (searchable) ── */
.wr-pick { position: relative; flex: 1 1 360px; max-width: 560px; }
.wr-pick-btn { display: flex; align-items: center; gap: 9px; width: 100%; height: 38px; padding: 0 12px; border-radius: 12px; cursor: pointer; text-align: left;
  background: var(--bg-input); border: 1px solid var(--wr-line-2); color: var(--text-primary); }
.wr-pick-btn:hover, .wr-pick-btn[aria-expanded='true'] { border-color: var(--wr-gold); }
.wr-pick-btn svg:first-child { color: var(--wr-gold); }
.wr-pick-v { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 13px; }
.wr-pick-v b { font-family: var(--wr-num); margin-right: 4px; } .wr-pick-v em { font-style: normal; color: var(--text-muted); margin-left: 8px; font-size: 11.5px; }
.wr-pick-pop { position: absolute; z-index: 40; top: 44px; left: 0; right: 0; border-radius: 14px; overflow: hidden; background: var(--bg-elevated); border: 1px solid rgba(233,196,106,0.35); box-shadow: 0 24px 50px -18px rgba(0,0,0,0.7); animation: wrIn 160ms both; }
.wr-pick-search { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--wr-line-2); color: var(--text-muted); }
.wr-pick-search input { flex: 1; background: none; border: 0; outline: 0; color: var(--text-primary); font-size: 13px; }
.wr-pick-search span { font-size: 11px; font-weight: 700; }
.wr-pick-list { max-height: 340px; overflow: auto; padding: 4px; }
.wr-pick-o { display: grid; grid-template-columns: 54px minmax(0, 1fr) 16px; gap: 8px; align-items: center; width: 100%; padding: 7px 8px; border: 0; border-radius: 9px; background: none; cursor: pointer; text-align: left; }
.wr-pick-o b { font-family: var(--wr-num); font-size: 12px; color: var(--text-muted); }
.wr-pick-o span { display: flex; flex-direction: column; min-width: 0; font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wr-pick-o em { font-style: normal; font-size: 11px; font-weight: 500; color: var(--text-muted); }
.wr-pick-o.hi { background: var(--wr-line-2); } .wr-pick-o.on b { color: var(--wr-gold); }
.wr-pick-none { padding: 16px; text-align: center; color: var(--text-muted); font-size: 12.5px; }

/* ── print: the board as a clean report ── */
@media print {
  .wr-cmd, .wr-chips .wr-chip, .wr-editor-a, .wr-storenav, .wr-iconbtn { display: none !important; }
  .wr { color: #000; } .wr-card, .wr-tile, .wr-sig { box-shadow: none !important; break-inside: avoid; border-color: #ccc; }
  .wr-tablewrap { max-height: none; overflow: visible; }
}

/* ── responsive ── */
@media (max-width: 1500px) { .wr-tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); } .wr-catgrid { grid-template-columns: 1fr 1fr; } .wr-contro { grid-column: 1 / -1; } .wr-signals { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 1180px) { .wr-tri, .wr-geo, .wr-movers, .wr-store2, .wr-two { grid-template-columns: minmax(0, 1fr); } .wr-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 720px) {
  .wr-tiles, .wr-catgrid, .wr-mv { grid-template-columns: minmax(0, 1fr); } .wr-signals, .wr-quad-k { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .wr-cmd { position: static; } .wr-cmd-r { margin-left: 0; } .wr-search { min-width: 0; flex: 1 1 100%; }
  .wr-kq { grid-template-columns: repeat(2, minmax(0, 1fr)); } .wr-prow { grid-template-columns: minmax(0, 1fr) 1fr 1fr 64px; font-size: 12px; }
}
@media (prefers-reduced-motion: reduce) { .wr *, .wr *::before, .wr *::after { animation: none !important; transition: none !important; } }
    `}</style>
  );
}
