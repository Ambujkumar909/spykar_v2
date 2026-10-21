// War Room maths that must never drift: period windows, target phasing, categories, store type.
const { periodsFor, catOf, _test } = require('../warRoom');
const { minusYear, storeType } = _test;

test('periods: week to date, PW and LY on the same weekdays, MTD / YTD calendar-aligned', () => {
  const { P, weekStart, weeks } = periodsFor('2026-06-06');          // a Saturday
  expect(weekStart).toBe('2026-06-01');
  expect(P.cw).toEqual(['2026-06-01', '2026-06-06']);
  expect(P.pw).toEqual(['2026-05-25', '2026-05-30']);
  expect(P.ly).toEqual(['2025-06-02', '2025-06-07']);              // 364 days back: Mon–Sat again
  expect(P.pwly).toEqual(['2025-05-26', '2025-05-31']);
  expect(P.mtdly).toEqual(['2025-06-01', '2025-06-06']);
  expect(P.ytd).toEqual(['2026-04-01', '2026-06-06']);
  expect(P.ytdly).toEqual(['2025-04-01', '2025-06-06']);
  expect(weeks).toHaveLength(13);
  expect(weeks[12].ty).toEqual(['2026-06-01', '2026-06-06']);
  expect(weeks[11].ty).toEqual(['2026-05-25', '2026-05-31']);
  expect(periodsFor('2026-03-31').P.ytd[0]).toBe('2025-04-01');
  expect(minusYear('2028-02-29')).toBe('2027-02-28');
});

test('categories follow the workbook\'s six men\'s lines, the rest by range', () => {
  expect(catOf('MENS', 'DENIM', 'JEANS')).toBe('Jeans');
  expect(catOf('MENS', 'DENIM', 'EP JEANS')).toBe('Jeans');
  expect(catOf('MENS', 'KNITS', 'T-SHIRTS')).toBe('T-Shirts');
  expect(catOf('MENS', 'NON DENIM', 'TROUSERS')).toBe('Non-Denim');
  expect(catOf('MENS', 'KNITS', 'SWEATSHIRT')).toBe('Winter Wear');
  expect(catOf('MENS', 'KNITS', 'KNIT TRACK PANTS')).toBe('Other Men');
  expect(catOf('WOMENS', 'DENIM', 'JEANS')).toBe('Women');
  expect(catOf('MENS', 'UNDERJEANS', 'TRUNK - UJ')).toBe('Underjeans');
  expect(catOf('MENS', 'GROOMING', 'DEO')).toBe('Grooming');
});

test('store type from what the database knows: closed flag + first sale day', () => {
  const { P } = periodsFor('2026-06-06');
  expect(storeType({ closed: true, first: '2024-01-01' }, P)).toBe('Closed');
  expect(storeType({ first: '2024-01-01' }, P)).toBe('L2L');
  expect(storeType({ first: '2025-04-01' }, P)).toBe('L2L');          // traded the whole of last FY
  expect(storeType({ first: '2025-08-10' }, P)).toBe('Annualised');
  expect(storeType({ first: '2026-05-02' }, P)).toBe('New');
});
