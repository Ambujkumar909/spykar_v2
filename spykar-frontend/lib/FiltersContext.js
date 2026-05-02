// ─── FiltersContext — shared filter state between the page + the navbar bar ──
// The page (sales / network / etc.) stays the OWNER of the useFilters
// instance; we just publish that instance through React Context so the
// PremiumFilterBar mounted inside <DashboardLayout> can reach it.
//
// Why context (not just two parallel useFilters):  useFilters reads the URL
// only on first mount, so two parallel instances would fall out of sync the
// moment one of them called router.replace().  A single owner + a context
// channel keeps the lens identical from header to page table.
//
// Pages opt in by wrapping their return in <FiltersProvider value={api}>.
// Routes that don't wrap stay invisible to the FilterBar — useSharedFilters()
// returns null, and the FilterBar renders nothing.

import { createContext, useContext } from 'react';

const FiltersContext = createContext(null);

export function FiltersProvider({ value, children }) {
  return (
    <FiltersContext.Provider value={value}>
      {children}
    </FiltersContext.Provider>
  );
}

export function useSharedFilters() {
  return useContext(FiltersContext);
}
