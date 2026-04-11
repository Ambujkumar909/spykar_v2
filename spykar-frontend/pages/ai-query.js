import { useState, useRef, useEffect } from 'react';
import DashboardLayout from '../components/layout/DashboardLayout';
import { aiService } from '../lib/services';
import { formatDate, formatNumber } from '../lib/utils';
import { Bot, Send, Loader2, Sparkles, Clock, ChevronRight, RotateCcw, Table2, Copy } from 'lucide-react';
import dynamic from 'next/dynamic';
import toast from 'react-hot-toast';

const Chart = dynamic(() => import('react-apexcharts'), { ssr: false });

const CATEGORY_COLORS = {
  Distributors: '#10b981',
  'Stock Alerts': '#f43f5e',
  'Size Analysis': '#f59e0b',
  'Color Analysis': '#d946ef',
  Dispatch: '#f97316',
  Ageing: '#f43f5e',
  COCO: '#14b8a6',
  Warehouses: '#8b5cf6',
};

export default function AiQuery() {
  const [question, setQuestion]       = useState('');
  const [loading, setLoading]         = useState(false);
  const [result, setResult]           = useState(null);
  const [history, setHistory]         = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [histLoading, setHistLoading] = useState(true);
  const [viewMode, setViewMode]       = useState('table'); // 'table' | 'chart'
  const [displayAnswer, setDisplayAnswer] = useState('');
  const inputRef = useRef(null);
  const resultRef = useRef(null);

  useEffect(() => {
    fetchSuggestions();
    fetchHistory();
    inputRef.current?.focus();
  }, []);

  async function fetchSuggestions() {
    try {
      const res = await aiService.getSuggestedQueries();
      setSuggestions(res.data.data || []);
    } catch {}
  }

  async function fetchHistory() {
    setHistLoading(true);
    try {
      const res = await aiService.getHistory();
      setHistory(res.data.data || []);
    } catch {}
    finally { setHistLoading(false); }
  }

  async function submitQuery(q) {
    const text = (q || question).trim();
    if (!text) return;
    setQuestion(text);
    setLoading(true);
    setResult(null);

    try {
      const res = await aiService.query(text);
      setResult(res.data.data);
      setViewMode('table');
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
      fetchHistory(); // Refresh history
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Query failed. Please rephrase and try again.');
    } finally {
      setLoading(false);
    }
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitQuery(); }
  }

  // Group suggestions by category
  const grouped = suggestions.reduce((acc, s) => {
    (acc[s.category] = acc[s.category] || []).push(s);
    return acc;
  }, {});

  // Build chart from result rows if numeric columns exist
  const rows    = result?.rows || [];
  const cols    = rows.length ? Object.keys(rows[0]) : [];
  const numCols = cols.filter(c => typeof rows[0]?.[c] === 'number');
  const strCols = cols.filter(c => typeof rows[0]?.[c] === 'string');
  const canChart = numCols.length >= 1 && strCols.length >= 1 && rows.length > 1;

  const chartOptions = canChart ? {
    chart: { type: 'bar', background: 'transparent', toolbar: { show: false }, fontFamily: "'Inter', sans-serif" },
    plotOptions: { bar: { borderRadius: 4, columnWidth: '60%' } },
    colors: ['#6D28D9'],
    xaxis: {
      categories: rows.map(r => String(r[strCols[0]]).substring(0, 18)),
      labels: { style: { colors: '#94A3B8', fontSize: '11px' }, rotate: -30 },
      axisBorder: { show: false }, axisTicks: { show: false },
    },
    yaxis: { labels: { style: { colors: '#94A3B8', fontSize: '11px' } } },
    grid: { borderColor: 'rgba(15,23,42,0.06)', strokeDashArray: 4 },
    dataLabels: { enabled: false },
    tooltip: { theme: 'light' },
    theme: { mode: 'light' },
  } : null;

  const chartSeries = canChart
    ? [{ name: numCols[0], data: rows.map(r => Number(r[numCols[0]])) }]
    : [];

  useEffect(() => {
    const answer = result?.answer || '';
    setDisplayAnswer('');

    if (!answer) return undefined;

    let index = 0;
    const timer = setInterval(() => {
      index += 1;
      setDisplayAnswer(answer.slice(0, index));

      if (index >= answer.length) {
        clearInterval(timer);
      }
    }, 14);

    return () => clearInterval(timer);
  }, [result?.answer]);

  return (
    <DashboardLayout title="AI Query" subtitle="Ask any inventory question in plain English — powered by Gemini AI">

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 20, alignItems: 'start' }}>

        {/* Main query area */}
        <div>

          {/* Input box */}
          <div className="card" style={{ marginBottom: 20, borderColor: loading ? 'var(--accent-border)' : '', boxShadow: loading ? 'var(--shadow-accent)' : '' }}>
            <div className="card-body" style={{ padding: 20 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                <div style={{
                  width: 38, height: 38, flexShrink: 0,
                  background: 'linear-gradient(135deg, #6D28D9, #9333EA)',
                  borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Bot size={18} color="#fff" />
                </div>
                <textarea
                  ref={inputRef}
                  className="input"
                  style={{ resize: 'none', minHeight: 52, lineHeight: 1.5, paddingTop: 14 }}
                  placeholder="Ask anything… e.g. 'Show top 5 distributors for size 34 blue jeans in North zone'"
                  value={question}
                  onChange={e => setQuestion(e.target.value)}
                  onKeyDown={handleKey}
                  disabled={loading}
                  rows={2}
                />
                <button className="btn btn-primary" style={{ padding: '12px 16px', flexShrink: 0, height: 52 }}
                  onClick={() => submitQuery()} disabled={loading || !question.trim()}>
                  {loading ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={16} />}
                </button>
              </div>
              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 16 }}>
                <span>⏎ Enter to submit</span>
                <span>Shift+Enter for new line</span>
                <span style={{ marginLeft: 'auto' }}>Powered by Gemini AI</span>
              </div>
            </div>
          </div>

          {/* Loading state */}
          {loading && (
            <div className="card" style={{ marginBottom: 20 }}>
              <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: 16, padding: 24 }}>
                <div style={{
                  width: 36, height: 36,
                  border: '2px solid var(--border-default)',
                  borderTop: '2px solid var(--accent-primary)',
                  borderRadius: '50%',
                  animation: 'spin 0.8s linear infinite',
                }} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 3 }}>Querying inventory data...</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    <span className="gradient-text" style={{ fontWeight: 700 }}>Generating SQL</span>
                    {' '}&rarr; Executing &rarr; Formatting answer
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Result */}
          {result && !loading && (
            <div ref={resultRef}>
              {/* AI Answer */}
              <div className="card" style={{ marginBottom: 16, borderColor: 'var(--accent-border)', boxShadow: 'var(--shadow-accent)' }}>
                <div className="card-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Sparkles size={14} style={{ color: 'var(--accent-primary)' }} />
                    <span className="card-title">Summary</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{result.rowCount} records</span>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ padding: '4px 10px', fontSize: 12 }}
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(result.answer || '');
                          toast.success('Answer copied');
                        } catch {
                          toast.error('Unable to copy answer');
                        }
                      }}
                    >
                      <Copy size={12} />
                      Copy answer
                    </button>
                  </div>
                </div>
                <div className="card-body">
                  <p style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--text-primary)', marginBottom: 0 }}>
                    {displayAnswer}
                    {displayAnswer !== result.answer && <span style={{ color: 'var(--fuchsia)' }}>|</span>}
                  </p>
                </div>
              </div>

              {/* Data table / chart toggle */}
              {rows.length > 0 && (
                <div className="card">
                  <div className="card-header">
                    <span className="card-title">Query Results</span>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {canChart && (
                        <>
                          <button className={`btn ${viewMode === 'table' ? 'btn-primary' : 'btn-ghost'}`} style={{ padding: '4px 12px', fontSize: 12 }} onClick={() => setViewMode('table')}><Table2 size={13} /> Table</button>
                          <button className={`btn ${viewMode === 'chart' ? 'btn-primary' : 'btn-ghost'}`} style={{ padding: '4px 12px', fontSize: 12 }} onClick={() => setViewMode('chart')}><Sparkles size={13} /> Visualize as chart</button>
                        </>
                      )}
                      <button className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => { setResult(null); setQuestion(''); inputRef.current?.focus(); }}>
                        <RotateCcw size={12} /> New Query
                      </button>
                    </div>
                  </div>

                  {viewMode === 'chart' && canChart ? (
                    <div className="card-body">
                      <Chart options={chartOptions} series={chartSeries} type="bar" height={260} />
                    </div>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table className="data-table">
                        <thead>
                          <tr>{cols.map(c => <th key={c}>{c.replace(/_/g, ' ').toUpperCase()}</th>)}</tr>
                        </thead>
                        <tbody>
                          {rows.map((row, i) => (
                            <tr key={i}>
                              {cols.map(c => (
                                <td key={c} style={{
                                  color: typeof row[c] === 'number' ? 'var(--accent-primary)' : '',
                                  fontWeight: typeof row[c] === 'number' ? 600 : '',
                                  fontFamily: String(row[c])?.match(/^[A-Z]{2,}-/) ? 'monospace' : '',
                                  fontSize: String(row[c])?.match(/^[A-Z]{2,}-/) ? 12 : '',
                                }}>
                                  {typeof row[c] === 'number' ? formatNumber(row[c]) : (row[c] ?? '—')}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Empty state */}
          {!result && !loading && (
            <div style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--text-muted)' }}>
              <Bot size={48} style={{ opacity: 0.15, marginBottom: 12 }} />
              <p style={{ fontSize: 14 }}>Type a question above or pick a suggestion from the right panel</p>
            </div>
          )}
        </div>

        {/* Right panel — suggestions + history */}
        <div>

          {/* Suggested queries */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-header"><span className="card-title">Suggested Queries</span></div>
            <div style={{ padding: '8px 0', maxHeight: 400, overflowY: 'auto' }}>
              {Object.entries(grouped).map(([category, items]) => (
                <div key={category}>
                  <div style={{ padding: '6px 16px 2px', fontSize: 10, fontWeight: 700, color: CATEGORY_COLORS[category] || 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                    {category}
                  </div>
                  {items.map((s, i) => (
                    <button key={i} onClick={() => { setQuestion(s.query); submitQuery(s.query); }}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        width: '100%', padding: '8px 16px', background: 'none', border: 'none',
                        cursor: 'pointer', textAlign: 'left', gap: 8,
                        transition: 'background 0.15s',
                        fontSize: 12, color: 'var(--text-secondary)',
                        borderLeft: `2px solid ${CATEGORY_COLORS[category] || 'transparent'}`,
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'none'}
                    >
                      <span style={{ lineHeight: 1.4 }}>{s.query}</span>
                      <ChevronRight size={12} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* Query history */}
          <div className="card">
            <div className="card-header"><span className="card-title"><Clock size={13} style={{ display: 'inline', marginRight: 6 }} />Recent Queries</span></div>
            <div style={{ padding: '8px 0', maxHeight: 280, overflowY: 'auto' }}>
              {histLoading
                ? <div className="skeleton" style={{ height: 80, margin: 12 }} />
                : history.length === 0
                  ? <div style={{ padding: '20px 16px', textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>No query history yet</div>
                  : history.map((h, i) => (
                    <button key={i} onClick={() => { setQuestion(h.question); submitQuery(h.question); }}
                      style={{
                        display: 'block', width: '100%', padding: '10px 16px',
                        background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
                        borderBottom: '1px solid var(--border-subtle)',
                        transition: 'background 0.15s',
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-elevated)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'none'}
                    >
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.question}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{h.row_count} rows · {formatDate(h.created_at)}</div>
                    </button>
                  ))
              }
            </div>
          </div>
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </DashboardLayout>
  );
}

AiQuery.getLayout = (page) => page;
