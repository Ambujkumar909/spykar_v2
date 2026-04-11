import { useState, useEffect, useCallback } from 'react';
import DashboardLayout from '../components/layout/DashboardLayout';
import Pagination from '../components/ui/Pagination';
import { locationService, inventoryService } from '../lib/services';
import { formatNumber, formatCurrency } from '../lib/utils';
import { MapPin, Search, X, Users, TrendingUp, Package, Globe } from 'lucide-react';
import toast from 'react-hot-toast';

const PALETTE = ['#C0392B','#0284C7','#059669','#D97706','#DC2626','#0D9488','#E74C3C','#EA580C'];

export default function Network() {
  const [locations, setLocations]       = useState([]);
  const [pagination, setPagination]     = useState(null);
  const [groupSummary, setGroupSummary] = useState([]);
  const [networkSummary, setNetworkSummary] = useState(null);
  const [stateOptions, setStateOptions] = useState([]);
  const [cityOptions, setCityOptions]   = useState([]);
  const [selected, setSelected]         = useState(null);
  const [locInventory, setLocInv]       = useState([]);
  const [locSummary, setLocSummary]     = useState(null);
  const [groupFilter, setGroupFilter]   = useState('');
  const [stateFilter, setStateFilter]   = useState('');
  const [cityFilter, setCityFilter]     = useState('');
  const [search, setSearch]             = useState('');
  const [loading, setLoading]           = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [page, setPage]                 = useState(1);

  const fetchLocations = useCallback(async () => {
    setLoading(true);
    try {
      const res = await locationService.list({
        limit: 100,
        page,
        group_name: groupFilter || undefined,
        state:      stateFilter || undefined,
        city:       cityFilter  || undefined,
        search:     search      || undefined,
      });
      setLocations(res.data.data || []);
      setPagination(res.data.pagination || null);
      setGroupSummary(res.data.groups || []);
      setNetworkSummary(res.data.summary || null);
      setStateOptions(res.data.states || []);
      setCityOptions(res.data.cities || []);
    } catch { toast.error('Failed to load network'); }
    finally  { setLoading(false); }
  }, [page, groupFilter, stateFilter, cityFilter, search]);

  useEffect(() => { fetchLocations(); }, [fetchLocations]);

  function clearSelection() { setSelected(null); setLocInv([]); setLocSummary(null); }

  function updateFilters(fn) { clearSelection(); setPage(1); fn(); }

  async function selectLocation(loc) {
    if (selected?.id === loc.id) { clearSelection(); return; }
    setSelected(loc); setLocInv([]); setLocSummary(null); setDetailLoading(true);
    try {
      const [invRes, sumRes] = await Promise.allSettled([
        inventoryService.getLocationInventory(loc.id, { limit: 50 }),
        locationService.getSummary(loc.id),
      ]);
      if (invRes.status === 'fulfilled') setLocInv(invRes.value.data.data?.inventory || []);
      if (sumRes.status === 'fulfilled') setLocSummary(sumRes.value.data.data);
    } catch { toast.error('Failed to load store details'); }
    finally  { setDetailLoading(false); }
  }

  const totalLocations = Number(networkSummary?.total_locations || pagination?.total || locations.length || 0);
  const totalPages     = Number(pagination?.totalPages || 1);
  const currentPage    = Number(pagination?.page || page || 1);
  const availableGroups = groupSummary.map(g => g.group_name).filter(Boolean);
  const totalNetworkStock = groupSummary.reduce((s, g) => s + Number(g.stock || 0), 0);

  return (
    <DashboardLayout title="Network" subtitle="Retail network overview — inventory positions across all locations &amp; channels">

      {/* ── Group KPI Cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(groupSummary.length || 3, 6)}, 1fr)`, gap: 14, marginBottom: 24 }}>
        {loading
          ? [1,2,3,4].map(i => <div key={i} className="kpi-card"><div className="skeleton" style={{ height: 80 }} /></div>)
          : groupSummary.map((group, i) => {
            const color = PALETTE[i % PALETTE.length];
            const pct = totalNetworkStock > 0 ? Math.round((Number(group.stock) / totalNetworkStock) * 100) : 0;
            return (
              <div
                key={group.group_name || i}
                className="kpi-card"
                style={{ cursor: 'pointer', borderColor: groupFilter === group.group_name ? color : '', borderWidth: groupFilter === group.group_name ? 2 : 1 }}
                onClick={() => updateFilters(() => setGroupFilter(groupFilter === group.group_name ? '' : group.group_name))}
              >
                <div className="kpi-icon" style={{ background: `${color}18`, color }}><Users size={17} /></div>
                <div className="kpi-label" style={{ fontSize: 10 }}>{group.group_name || 'Unknown'}</div>
                <div className="kpi-value" style={{ fontSize: 22 }}>{formatNumber(Number(group.stock || 0))}</div>
                <div className="kpi-sub" style={{ fontSize: 11 }}>{formatNumber(Number(group.count || 0))} locations · {pct}%</div>
                <div className="kpi-bar"><div className="kpi-bar-fill" style={{ width: `${pct}%`, background: color }} /></div>
              </div>
            );
          })
        }
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 390px' : '1fr', gap: 20 }}>

        {/* ── Main Table ── */}
        <div className="card">
          <div className="card-header" style={{ flexWrap: 'wrap', gap: 10 }}>
            <span className="card-title">
              <Globe size={13} style={{ display: 'inline', marginRight: 6, color: 'var(--accent-primary)' }} />
              Retail Network — All Locations ({formatNumber(totalLocations)})
            </span>
            <div className="filter-bar" style={{ flexWrap: 'wrap' }}>
              {/* Group filter */}
              <select className="input" style={{ width: 180 }} value={groupFilter} onChange={e => updateFilters(() => setGroupFilter(e.target.value))}>
                <option value="">All Channels</option>
                {availableGroups.map(g => <option key={g} value={g}>{g}</option>)}
              </select>

              {/* State filter */}
              <select className="input" style={{ width: 160 }} value={stateFilter} onChange={e => updateFilters(() => { setStateFilter(e.target.value); setCityFilter(''); })}>
                <option value="">All States</option>
                {stateOptions.map(s => <option key={s} value={s}>{s}</option>)}
              </select>

              {/* City filter */}
              <select className="input" style={{ width: 160 }} value={cityFilter} onChange={e => updateFilters(() => setCityFilter(e.target.value))}>
                <option value="">All Cities</option>
                {cityOptions.map(c => <option key={c} value={c}>{c}</option>)}
              </select>

              {/* Search */}
              <div style={{ position: 'relative' }}>
                <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
                <input
                  className="input"
                  style={{ paddingLeft: 30, width: 220 }}
                  placeholder="Search store name, code, city…"
                  value={search}
                  onChange={e => updateFilters(() => setSearch(e.target.value))}
                />
              </div>

              {/* Clear filters */}
              {(groupFilter || stateFilter || cityFilter || search) && (
                <button className="btn btn-ghost" style={{ padding: '7px 10px', fontSize: 12 }}
                  onClick={() => updateFilters(() => { setGroupFilter(''); setStateFilter(''); setCityFilter(''); setSearch(''); })}>
                  <X size={12} /> Clear
                </button>
              )}
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Channel</th>
                  <th>Location</th>
                  <th>City</th>
                  <th>State</th>
                  <th style={{ textAlign: 'right' }}>Qty On Hand</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: 10 }).map((_, i) => (
                    <tr key={i}>{Array.from({ length: 7 }).map((_, j) => (
                      <td key={j}><div className="skeleton" style={{ height: 13, width: j === 5 ? '60%' : '85%' }} /></td>
                    ))}</tr>
                  ))
                  : locations.map((loc) => {
                    const isActive = selected?.id === loc.id;
                    const groupIdx = groupSummary.findIndex(g => g.group_name === loc.group_name);
                    const color    = PALETTE[Math.max(groupIdx, 0) % PALETTE.length];
                    return (
                      <tr
                        key={loc.id}
                        style={{ cursor: 'pointer', background: isActive ? 'var(--lavender-glow)' : '' }}
                        onClick={() => selectLocation(loc)}
                      >
                        <td style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text-muted)' }}>
                          {loc.code?.replace(/^[A-Za-z]+-/, '') || '—'}
                        </td>
                        <td>
                          <span className="badge badge-neutral" style={{ fontSize: 10, borderColor: `${color}40`, color }}>
                            {loc.group_name || '—'}
                          </span>
                        </td>
                        <td style={{ fontWeight: 600 }}>{loc.name}</td>
                        <td style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{loc.city || '—'}</td>
                        <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{loc.state || '—'}</td>
                        <td style={{ textAlign: 'right' }}>
                          <span style={{ fontWeight: 700, color: 'var(--accent-primary)', fontFamily: 'var(--font-display)', fontSize: 14 }}>
                            {formatNumber(loc.total_stock)}
                          </span>
                        </td>
                        <td style={{ color: 'var(--accent-primary)', fontSize: 14 }}>→</td>
                      </tr>
                    );
                  })
                }
                {!loading && !locations.length && (
                  <tr><td colSpan={7}>
                    <div className="empty-state"><MapPin size={32} /><p>No stores found for selected filters</p></div>
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>

          {!loading && totalPages > 1 && (
            <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Page {currentPage} of {totalPages} · {formatNumber(totalLocations)} locations total
              </span>
              <Pagination page={currentPage} totalPages={totalPages} onPageChange={setPage} />
            </div>
          )}
        </div>

        {/* ── Store Detail Panel ── */}
        {selected && (
          <div className="card" style={{ height: 'fit-content', position: 'sticky', top: 100 }}>
            <div className="card-header">
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace', marginBottom: 3 }}>
                  LOC {selected.code?.replace(/^[A-Za-z]+-/, '')}
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'var(--font-display)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {selected.name}
                </div>
              </div>
              <button type="button" onClick={clearSelection} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', borderRadius: 10, cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600, flexShrink: 0 }}>
                <X size={14} /> Close
              </button>
            </div>

            <div className="card-body" style={{ padding: '14px 18px' }}>
              {/* Location */}
              <div style={{ padding: '10px 12px', background: 'var(--bg-elevated)', borderRadius: 8, marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Location</div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{selected.city}{selected.state ? `, ${selected.state}` : ''}</div>
                {selected.pincode && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>PIN {selected.pincode}</div>}
              </div>

              {/* Channel */}
              <div style={{ padding: '10px 12px', background: 'var(--bg-elevated)', borderRadius: 8, marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Channel</div>
                <span className="badge badge-neutral">{selected.group_name || selected.type || '—'}</span>
              </div>

              {/* Summary stats */}
              {detailLoading ? (
                <div className="skeleton" style={{ height: 140, marginBottom: 12 }} />
              ) : locSummary ? (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
                  {[
                    { label: 'Total Stock',  value: formatNumber(locSummary.total_stock) },
                    { label: 'Available',    value: formatNumber(locSummary.available) },
                    { label: 'In Transit',   value: formatNumber(locSummary.in_transit) },
                    { label: 'SKU Count',    value: formatNumber(locSummary.sku_count) },
                    { label: 'Stock Value',  value: formatCurrency(locSummary.stock_value), span: 2 },
                    { label: 'Low Stock Alerts', value: locSummary.alerts, color: locSummary.alerts > 0 ? '#DC2626' : '#059669', span: 2 },
                  ].map((item, idx) => (
                    <div key={idx} style={{ gridColumn: item.span ? `span ${item.span}` : '', padding: '9px 12px', background: 'var(--bg-elevated)', borderRadius: 8 }}>
                      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>{item.label}</div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: item.color || 'var(--text-primary)', fontFamily: 'var(--font-display)' }}>{item.value}</div>
                    </div>
                  ))}
                </div>
              ) : null}

              {/* Contact */}
              {selected.contact_name && (
                <div style={{ padding: '10px 12px', background: 'var(--bg-elevated)', borderRadius: 8, marginBottom: 14 }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Contact</div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{selected.contact_name}</div>
                  {selected.contact_phone && <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{selected.contact_phone}</div>}
                </div>
              )}

              {/* Top SKUs */}
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8, fontWeight: 600 }}>
                Top SKUs — This Location
              </div>
              {detailLoading
                ? <div className="skeleton" style={{ height: 120 }} />
                : locInventory.length === 0
                  ? <div style={{ color: 'var(--text-muted)', fontSize: 12, textAlign: 'center', padding: 20 }}>No inventory data</div>
                  : locInventory.slice(0, 8).map((inv, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                      <div>
                        <div style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--text-primary)', fontWeight: 500 }}>{inv.sku_code}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{inv.color_name} · Size {inv.size}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 14, fontWeight: 700, fontFamily: 'var(--font-display)', color: 'var(--text-primary)' }}>{formatNumber(inv.qty_on_hand)}</div>
                        {inv.is_below_safety && <div style={{ fontSize: 10, color: '#DC2626', fontWeight: 600 }}>Low Stock</div>}
                      </div>
                    </div>
                  ))
              }
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

Network.getLayout = (page) => page;
