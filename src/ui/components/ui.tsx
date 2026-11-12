import React, { useEffect, useState } from 'react';

export const nav = (to: string) => {
  location.hash = '#' + to;
};

const ICONS: Record<string, React.ReactNode> = {
  grid: <path d="M2 2h4v4H2zM8 2h4v4H8zM14 2h0M2 8h4v4H2zM8 8h4v4H8z" />,
  search: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></>,
  terminal: <><rect x="1.5" y="2.5" width="13" height="11" rx="1" /><path d="m4.5 6 2.5 2-2.5 2M8.5 10.5h3" /></>,
  globe: <><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" /></>,
  user: <><circle cx="8" cy="5.5" r="2.5" /><path d="M3 14c0-3 2-4.5 5-4.5s5 1.5 5 4.5" /></>,
  chevron: <path d="m4 6 4 4 4-4" />,
  chevronR: <path d="m6 4 4 4-4 4" />,
  chevronL: <path d="m10 4-4 4 4 4" />,
  menu: <path d="M2 4h12M2 8h12M2 12h12" />,
  close: <path d="m3.5 3.5 9 9M12.5 3.5l-9 9" />,
  star: <path d="m8 1.8 1.9 4 4.3.5-3.2 3 .9 4.3L8 11.4l-3.9 2.2.9-4.3-3.2-3 4.3-.5z" />,
  refresh: <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" />,
  settings: <><circle cx="8" cy="8" r="2.2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" /></>,
  help: <><circle cx="8" cy="8" r="6" /><path d="M6.2 6.2a1.9 1.9 0 1 1 2.6 1.8c-.5.3-.8.7-.8 1.3M8 11.6v.1" /></>,
  bell: <path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3zM6.5 14h3" />,
  home: <path d="M2 8 8 2.5 14 8M3.5 7v6.5h3.5v-4h2v4h3.5V7" />,
  sun: <><circle cx="8" cy="8" r="2.8" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1" /></>,
  moon: <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" />,
  auto: <><circle cx="8" cy="8" r="6" /><path d="M8 2v12" /><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" /></>,
};

/** Iconos propios en SVG (trazo de 1.5px, sin logotipos de terceros). */
export function Icon({ name, size = 16, className }: { name: keyof typeof ICONS | string; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ICONS[name]}
    </svg>
  );
}

export function Crumbs({ items }: { items: { label: string; to?: string }[] }) {
  return (
    <nav className="crumbs" aria-label="Migas de pan">
      {items.map((it, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="sep"><Icon name="chevronR" size={12} /></span>}
          {it.to ? <a href={'#' + it.to}>{it.label}</a> : <span aria-current="page">{it.label}</span>}
        </React.Fragment>
      ))}
    </nav>
  );
}

export function PageHead({ title, desc, children }: { title: React.ReactNode; desc?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="pagehead">
      <div>
        <h1>{title}</h1>
        {desc && <div className="desc">{desc}</div>}
      </div>
      <div className="actions">{children}</div>
    </div>
  );
}

export function Btn({ children, onClick, kind, disabled, small, title }: { children: React.ReactNode; onClick?: () => void; kind?: 'primary' | 'danger' | 'link'; disabled?: boolean; small?: boolean; title?: string }) {
  return (
    <button className={`btn ${kind ?? ''} ${small ? 'small' : ''}`} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

export function Card({ title, count, actions, children, flush }: { title?: React.ReactNode; count?: number; actions?: React.ReactNode; children?: React.ReactNode; flush?: boolean }) {
  return (
    <div className="card">
      {title && (
        <div className="head">
          <h2>
            {title}
            {count !== undefined && <span className="count">({count})</span>}
          </h2>
          <div className="actions">{actions}</div>
        </div>
      )}
      {flush ? children : <div className="body2">{children}</div>}
    </div>
  );
}

export type Tone = 'ok' | 'err' | 'warn' | 'load' | '';
export const Status = ({ tone, children }: { tone: Tone; children: React.ReactNode }) => <span className={`status ${tone}`}>{children}</span>;

export interface Col<T> {
  head: string;
  cell: (r: T) => React.ReactNode;
  text?: (r: T) => string;
}

export function Table<T>({ cols, rows, id, selected, onSelect, empty, filterPlaceholder, toolbar, onOpen, pageSize = 20, onRefresh }: {
  cols: Col<T>[];
  rows: T[];
  id: (r: T) => string;
  selected?: string[];
  onSelect?: (ids: string[]) => void;
  empty: { title: string; desc?: string };
  filterPlaceholder?: string;
  toolbar?: React.ReactNode;
  onOpen?: (r: T) => void;
  pageSize?: number;
  onRefresh?: () => void;
}) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ head: string; dir: 1 | -1 } | null>(null);
  const textOf = (c: Col<T>, r: T) => (c.text ? c.text(r) : String(c.cell(r) ?? ''));
  const filtered = q.trim() ? rows.filter((r) => cols.some((c) => textOf(c, r).toLowerCase().includes(q.toLowerCase()))) : rows;
  const sc = sort ? cols.find((c) => c.head === sort.head && c.text) : undefined;
  const shown = sc && sort ? [...filtered].sort((x, y) => sc.text!(x).localeCompare(sc.text!(y), 'es', { numeric: true }) * sort.dir) : filtered;
  const pages = Math.max(1, Math.ceil(shown.length / pageSize));
  const cur = Math.min(page, pages);
  useEffect(() => { if (page > pages) setPage(pages); }, [page, pages]);
  const visible = shown.slice((cur - 1) * pageSize, cur * pageSize);
  const sel = selected ?? [];
  const toggle = (k: string) => onSelect?.(sel.includes(k) ? sel.filter((x) => x !== k) : [...sel, k]);
  const allOn = visible.length > 0 && visible.every((r) => sel.includes(id(r)));
  const toggleAll = () => onSelect?.(allOn ? sel.filter((k) => !visible.some((r) => id(r) === k)) : Array.from(new Set([...sel, ...visible.map(id)])));
  void onOpen;
  const pageNums: (number | '…')[] = [];
  for (let i = 1; i <= pages; i++) if (i === 1 || i === pages || Math.abs(i - cur) <= 1) pageNums.push(i); else if (pageNums[pageNums.length - 1] !== '…') pageNums.push('…');
  return (
    <>
      <div className="toolbar">
        <div className="filterbox">
          <Icon name="search" size={14} />
          <input className="filter" placeholder={filterPlaceholder ?? 'Buscar'} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} aria-label="Filtrar" />
        </div>
        {q.trim() && <span className="matches">{shown.length} {shown.length === 1 ? 'coincidencia' : 'coincidencias'}</span>}
        {toolbar}
        <div className="spacer" />
        {onRefresh && (
          <button className="iconbtn" onClick={onRefresh} title="Actualizar" aria-label="Actualizar">
            <Icon name="refresh" />
          </button>
        )}
        <div className="pager" role="navigation" aria-label="Paginación">
          <button className="iconbtn" disabled={cur <= 1} onClick={() => setPage(cur - 1)} aria-label="Página anterior">
            <Icon name="chevronL" />
          </button>
          {pageNums.map((n, i) => n === '…' ? <span key={'e' + i} className="ell">…</span> : (
            <button key={n} className={'pg ' + (n === cur ? 'on' : '')} onClick={() => setPage(n)} aria-current={n === cur ? 'page' : undefined}>{n}</button>
          ))}
          <button className="iconbtn" disabled={cur >= pages} onClick={() => setPage(cur + 1)} aria-label="Página siguiente">
            <Icon name="chevronR" />
          </button>
        </div>
      </div>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              {onSelect && (
                <th style={{ width: 36 }}>
                  <input type="checkbox" checked={allOn} onChange={toggleAll} aria-label="Seleccionar todo" disabled={visible.length === 0} />
                </th>
              )}
              {cols.map((c) => (
                <th key={c.head} className={c.text ? 'sortable' : ''} onClick={c.text ? () => setSort(sort?.head === c.head ? (sort.dir === 1 ? { head: c.head, dir: -1 } : null) : { head: c.head, dir: 1 }) : undefined} aria-sort={sort?.head === c.head ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
                  {c.head}
                  {sort?.head === c.head && <span className="sortarrow">{sort.dir === 1 ? '▲' : '▼'}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td className="empty" colSpan={cols.length + (onSelect ? 1 : 0)}>
                  <b>{rows.length === 0 ? empty.title : 'No se encontraron coincidencias'}</b>
                  {rows.length === 0 ? empty.desc : 'Prueba con otro filtro.'}
                </td>
              </tr>
            )}
            {visible.map((r) => (
              <tr key={id(r)} className={sel.includes(id(r)) ? 'sel' : ''}>
                {onSelect && (
                  <td>
                    <input type="checkbox" checked={sel.includes(id(r))} onChange={() => toggle(id(r))} aria-label={'Seleccionar ' + id(r)} />
                  </td>
                )}
                {cols.map((c) => (
                  <td key={c.head}>{c.cell(r)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="tablefoot">
        {shown.length === 0 ? '0 elementos' : `${(cur - 1) * pageSize + 1}-${Math.min(cur * pageSize, shown.length)} de ${shown.length}`} · Página {cur} de {pages}
      </div>
    </>
  );
}

export function Flash({ kind, title, children, onClose }: { kind: 'ok' | 'err' | 'info'; title?: string; children?: React.ReactNode; onClose?: () => void }) {
  return (
    <div className={`flash ${kind}`} role={kind === 'err' ? 'alert' : 'status'}>
      <span className="ficon" aria-hidden="true" />
      <div className="fbody">
        {title && <b>{title}</b>}
        {children}
      </div>
      {onClose && (
        <button onClick={onClose} aria-label="Cerrar">
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  );
}

export function Modal({ title, children, footer, onClose }: { title: string; children: React.ReactNode; footer?: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const f = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', f);
    return () => removeEventListener('keydown', f);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="mh">{title}</div>
        <div className="mb">{children}</div>
        <div className="mf">{footer}</div>
      </div>
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {hint && <div className="hint">{hint}</div>}
      {children}
      {error && <div className="err">{error}</div>}
    </div>
  );
}

/** Comando de CLI equivalente a lo que hace la consola. */
export function CliEquivalent({ cmd }: { cmd: string }) {
  return (
    <div className="cli">
      <b>$</b> {cmd}
    </div>
  );
}

export const fmtDate = (iso?: string) => {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString('es-ES', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
};
