import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Columns3, Download, Search } from 'lucide-react';

export interface Column<T> {
  key: string;
  header: string;
  /** cell renderer; defaults to the raw value */
  render?: (row: T) => ReactNode;
  /** value used for sorting, filtering and CSV; defaults to row[key] */
  value?: (row: T) => string | number | null | undefined;
  align?: 'left' | 'right';
  width?: number;
  sortable?: boolean;
  hidden?: boolean;     // hidden by default (user can enable)
  title?: string;
}

export interface DataTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  empty?: ReactNode;
  /** client mode (default): sort/search/paginate locally. server mode: parent controls them */
  server?: { page: number; pageSize: number; total: number; sort?: string; order?: 'asc' | 'desc'; onPage: (p: number) => void; onSort: (key: string, order: 'asc' | 'desc') => void; search?: string; onSearch?: (q: string) => void };
  searchable?: boolean;
  exportName?: string;
  toolbar?: ReactNode;
  pageSize?: number;
  /** virtualize when more rows than this (client mode) */
  virtualizeAbove?: number;
  maxHeight?: number | string;
  initialSort?: { key: string; order: 'asc' | 'desc' };
  dense?: boolean;
}

const getVal = <T,>(c: Column<T>, r: T) => (c.value ? c.value(r) : (r as any)[c.key]);

export function DataTable<T>({
  rows, columns, rowKey, onRowClick, loading, empty, server, searchable = true, exportName, toolbar, pageSize = 50, virtualizeAbove = 300, maxHeight = 640, initialSort,
}: DataTableProps<T>) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: string; order: 'asc' | 'desc' } | null>(initialSort ?? null);
  const [page, setPage] = useState(1);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(columns.filter((c) => c.hidden).map((c) => c.key)));
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [colMenu, setColMenu] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const visible = columns.filter((c) => !hidden.has(c.key));

  const processed = useMemo(() => {
    if (server) return rows;
    let out = rows;
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      out = out.filter((r) => columns.some((c) => String(getVal(c, r) ?? '').toLowerCase().includes(needle)));
    }
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col) {
        out = [...out].sort((a, b) => {
          const x = getVal(col, a), y = getVal(col, b);
          if (x == null && y == null) return 0;
          if (x == null) return 1;
          if (y == null) return -1;
          const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
          return sort.order === 'asc' ? r : -r;
        });
      }
    }
    return out;
  }, [rows, q, sort, columns, server]);

  const virtual = !server && processed.length > virtualizeAbove;
  const totalPages = server ? Math.max(1, Math.ceil(server.total / server.pageSize)) : virtual ? 1 : Math.max(1, Math.ceil(processed.length / pageSize));
  const curPage = server ? server.page : Math.min(page, totalPages);
  const pageRows = server || virtual ? processed : processed.slice((curPage - 1) * pageSize, curPage * pageSize);

  const rv = useVirtualizer({ count: virtual ? pageRows.length : 0, getScrollElement: () => scrollRef.current, estimateSize: () => 31, overscan: 20 });

  const toggleSort = (c: Column<T>) => {
    if (c.sortable === false) return;
    const cur = server ? (server.sort === c.key ? { key: c.key, order: server.order ?? 'desc' } : null) : sort?.key === c.key ? sort : null;
    const order: 'asc' | 'desc' = cur && cur.order === 'desc' ? 'asc' : 'desc';
    if (server) server.onSort(c.key, order);
    else setSort({ key: c.key, order });
  };
  const sortState = server ? (server.sort ? { key: server.sort, order: server.order ?? 'desc' } : null) : sort;

  const exportCsv = () => {
    const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [visible.map((c) => esc(c.header)).join(','), ...processed.map((r) => visible.map((c) => esc(getVal(c, r))).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${exportName ?? 'export'}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const startResize = (key: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.target as HTMLElement).parentElement!;
    const startX = e.clientX;
    const startW = th.getBoundingClientRect().width;
    const move = (ev: MouseEvent) => setWidths((w) => ({ ...w, [key]: Math.max(50, startW + ev.clientX - startX) }));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const renderRow = (r: T, style?: React.CSSProperties) => (
    <tr key={rowKey(r)} className={onRowClick ? 'clickable' : ''} onClick={onRowClick ? () => onRowClick(r) : undefined} style={style}
      tabIndex={onRowClick ? 0 : undefined} onKeyDown={onRowClick ? (e) => e.key === 'Enter' && onRowClick(r) : undefined}>
      {visible.map((c) => (
        <td key={c.key} className={c.align === 'right' ? 'r num' : ''} style={widths[c.key] ? { maxWidth: widths[c.key], overflow: 'hidden', textOverflow: 'ellipsis' } : undefined}>
          {c.render ? c.render(r) : (getVal(c, r) ?? '—') as ReactNode}
        </td>
      ))}
    </tr>
  );

  return (
    <div className="dt">
      <div className="dt-toolbar">
        {searchable && (
          <div className="dt-search">
            <Search size={13} />
            <input className="input" placeholder="Search…" value={server ? server.search ?? '' : q}
              onChange={(e) => { if (server?.onSearch) server.onSearch(e.target.value); else { setQ(e.target.value); setPage(1); } }} aria-label="Search table" />
          </div>
        )}
        {toolbar}
        <div className="spacer" />
        <span className="muted">{server ? `${server.total.toLocaleString()} rows` : `${processed.length.toLocaleString()}${processed.length !== rows.length ? ` of ${rows.length.toLocaleString()}` : ''} rows`}</span>
        <div style={{ position: 'relative' }}>
          <button className="btn btn-sm btn-ghost" onClick={() => setColMenu((v) => !v)} title="Columns" aria-label="Choose columns"><Columns3 size={14} /></button>
          {colMenu && (
            <div className="dt-menu" onMouseLeave={() => setColMenu(false)}>
              {columns.map((c) => (
                <label key={c.key} className="dt-menu-item">
                  <input type="checkbox" checked={!hidden.has(c.key)} onChange={() => setHidden((h) => { const n = new Set(h); n.has(c.key) ? n.delete(c.key) : n.add(c.key); return n; })} />
                  {c.header}
                </label>
              ))}
            </div>
          )}
        </div>
        <button className="btn btn-sm btn-ghost" onClick={exportCsv} title="Export CSV" aria-label="Export CSV"><Download size={14} /></button>
      </div>
      <div className="table-wrap" ref={scrollRef} style={{ maxHeight }}>
        <table className="table">
          <thead>
            <tr>
              {visible.map((c) => (
                <th key={c.key} className={`${c.sortable === false ? '' : 'sortable'} ${c.align === 'right' ? 'r' : ''}`} style={{ width: widths[c.key] ?? c.width, position: 'sticky' }}
                  onClick={() => toggleSort(c)} title={c.title} aria-sort={sortState?.key === c.key ? (sortState.order === 'asc' ? 'ascending' : 'descending') : undefined}>
                  {c.header}{sortState?.key === c.key ? (sortState.order === 'desc' ? ' ↓' : ' ↑') : ''}
                  <span className="dt-resizer" onMouseDown={(e) => startResize(c.key, e)} onClick={(e) => e.stopPropagation()} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && !rows.length && Array.from({ length: 5 }).map((_, i) => <tr key={i}><td colSpan={visible.length}><div className="skeleton" style={{ height: 14 }} /></td></tr>)}
            {!loading && !pageRows.length && <tr><td colSpan={visible.length}><div className="empty">{empty ?? 'No data'}</div></td></tr>}
            {virtual ? (
              <>
                {rv.getVirtualItems()[0]?.start ? <tr style={{ height: rv.getVirtualItems()[0].start }} /> : null}
                {rv.getVirtualItems().map((vi) => renderRow(pageRows[vi.index]))}
                <tr style={{ height: rv.getTotalSize() - (rv.getVirtualItems().at(-1)?.end ?? 0) }} />
              </>
            ) : pageRows.map((r) => renderRow(r))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="dt-pager">
          <button className="btn btn-sm" disabled={curPage <= 1} onClick={() => (server ? server.onPage(curPage - 1) : setPage(curPage - 1))}>Previous</button>
          <span className="muted">Page {curPage} of {totalPages}</span>
          <button className="btn btn-sm" disabled={curPage >= totalPages} onClick={() => (server ? server.onPage(curPage + 1) : setPage(curPage + 1))}>Next</button>
        </div>
      )}
    </div>
  );
}
