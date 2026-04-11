function buildPageItems(currentPage, totalPages) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const pages = new Set([1, totalPages, currentPage, currentPage - 1, currentPage + 1]);
  const sortedPages = Array.from(pages)
    .filter((page) => page >= 1 && page <= totalPages)
    .sort((a, b) => a - b);

  const items = [];

  for (let i = 0; i < sortedPages.length; i += 1) {
    const page = sortedPages[i];
    const prev = sortedPages[i - 1];

    if (i > 0 && page - prev > 1) {
      items.push(`ellipsis-${prev}`);
    }

    items.push(page);
  }

  return items;
}

export default function Pagination({ page, totalPages, onPageChange }) {
  if (!totalPages || totalPages <= 1) {
    return null;
  }

  const items = buildPageItems(page, totalPages);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => onPageChange(page - 1)}
        disabled={page === 1}
        style={{ padding: '6px 12px', minWidth: 78 }}
      >
        Prev
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {items.map((item) =>
          typeof item === 'number' ? (
            <button
              key={item}
              type="button"
              className={`btn ${item === page ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => onPageChange(item)}
              style={{ minWidth: 38, padding: '6px 10px' }}
            >
              {item}
            </button>
          ) : (
            <span key={item} style={{ color: 'var(--text-muted)', fontSize: 12, padding: '0 2px' }}>
              ...
            </span>
          )
        )}
      </div>

      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => onPageChange(page + 1)}
        disabled={page === totalPages}
        style={{ padding: '6px 12px', minWidth: 78 }}
      >
        Next
      </button>
    </div>
  );
}
