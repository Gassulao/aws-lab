import React, { useEffect, useState } from 'react';
import { useCloud } from '../session';
import { CATEGORIES, SERVICES, svcOf } from '../services';
import { Btn, Modal, nav } from '../components/ui';
import { mutate } from '../../engine/store';
import { settle } from '../../engine/services/ec2';
import { ServiceIcon, CIcon, Grip, Kebab, ResizeGlyph } from './home/icons';
import { estimateCost, usd } from './home/cost';
import './home/home.css';

// ---------------------------------------------------------------- «Visitado recientemente»
// Se registra cada servicio al que se navega (escucha global del hash); queda en `s.recent` y se guarda con el estado.
const SHELL = { id: 'cloudshell', name: 'CloudShell', color: '#232f3e', desc: 'Terminal de línea de comandos en el navegador', home: '/cloudshell' };
const idOfHash = (): string | null => {
  const p = '/' + location.hash.replace(/^#\/?/, '').split('?')[0];
  if (p === '/cloudshell' || p.startsWith('/cloudshell/')) return 'cloudshell';
  return svcOf(p)?.id ?? null;
};
function recordVisit() {
  const id = idOfHash();
  if (!id) return;
  mutate((s) => {
    if (s.recent?.[0] === id) return;
    s.recent = [id, ...(s.recent ?? []).filter((x) => x !== id)].slice(0, 8);
  });
}
if (typeof window !== 'undefined') {
  addEventListener('hashchange', recordVisit);
  setTimeout(recordVisit, 1500);
}

const entry = (id: string) => (id === 'cloudshell' ? SHELL : SERVICES.find((x) => x.id === id));

// ---------------------------------------------------------------- Diseño de widgets (orden y ocultos, persistentes)
type WId = 'recent' | 'welcome' | 'health' | 'cost' | 'summary' | 'apps' | 'all';
const DEFAULT_ORDER: WId[] = ['recent', 'welcome', 'health', 'cost', 'summary', 'apps', 'all'];
const LAYOUT_KEY = 'awslab.home.layout';
interface Layout { order: WId[]; hidden: WId[] }
const loadLayout = (): Layout => {
  try {
    const l = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null') as Layout | null;
    if (l && Array.isArray(l.order) && Array.isArray(l.hidden)) {
      const order = [...l.order.filter((x) => DEFAULT_ORDER.includes(x)), ...DEFAULT_ORDER.filter((x) => !l.order.includes(x))];
      return { order, hidden: l.hidden.filter((x) => DEFAULT_ORDER.includes(x)) };
    }
  } catch { /* sin almacenamiento */ }
  return { order: DEFAULT_ORDER, hidden: [] };
};
const saveLayout = (l: Layout) => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(l)); } catch { /* sin almacenamiento */ } };

const META: Record<WId, { title: string; span: 1 | 2 | 4; tall?: boolean; info: string }> = {
  recent: { title: 'Visitados recientemente', span: 2, tall: true, info: 'Muestra los servicios que ha abierto últimamente en el simulador, del más reciente al más antiguo.' },
  welcome: { title: 'Le damos la bienvenida a AWS', span: 1, tall: true, info: 'Recursos para empezar: introducción, formación y comunidad de creadores.' },
  health: { title: 'AWS Health', span: 1, tall: true, info: 'Resumen del estado de su cuenta. En el simulador nunca hay incidencias reales.' },
  cost: { title: 'Costos y uso', span: 2, info: 'Estimación simulada del costo del mes a partir de las instancias EC2 de la cuenta.' },
  summary: { title: 'Resumen de la cuenta', span: 1, info: 'Recuento de los recursos principales de su cuenta simulada.' },
  apps: { title: 'Aplicaciones', span: 1, info: 'Las aplicaciones agrupan los recursos de una carga de trabajo.' },
  all: { title: 'Todos los servicios', span: 4, info: 'Catálogo de los servicios disponibles en el simulador.' },
};

const Ext = () => <span className="hm-ext"><CIcon name="ext" size={15} sw={2} /></span>;
const Illus = ({ kind }: { kind: 'rocket' | 'cert' | 'hub' | 'cli' }) => (
  <svg className="hm-illus" width="84" height="84" viewBox="0 0 84 84" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'rocket' && <g stroke="currentColor" strokeWidth="2"><path d="M60 14c-14 2-26 12-33 27l16 16c15-7 25-19 27-33 .3-4.5-.5-8.5-1-10-2-.5-6-1-9-.5z" /><circle cx="53" cy="31" r="5" /><path d="m27 41-10-1 5-9 12-2M43 57l1 10 9-5 2-12M30 54l-9 9" /><path d="M13 69l8-3M10 63l6-2" stroke="#4e7cff" /></g>}
    {kind === 'cert' && <g stroke="currentColor" strokeWidth="2"><path d="M20 12h30l10 10v44H20z" /><path d="M50 12v10h10M27 26h12M27 33h8M27 40h6" /><circle cx="52" cy="54" r="12" stroke="#4e7cff" /><circle cx="52" cy="54" r="7" stroke="#4e7cff" /><path d="m46 64-3 11 9-4 9 4-3-11" stroke="#4e7cff" /></g>}
    {kind === 'hub' && <g><defs><linearGradient id="hmg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#3d6bff" /><stop offset=".5" stopColor="#d85bff" /><stop offset="1" stopColor="#ffb0e8" /></linearGradient></defs><rect x="22" y="22" width="40" height="40" fill="url(#hmg)" stroke="none" /><g stroke="currentColor" strokeWidth="2.5"><path d="M16 22h52M16 62h52M22 16v52M62 16v52" /></g></g>}
    {kind === 'cli' && <g stroke="currentColor" strokeWidth="2"><rect x="12" y="18" width="60" height="48" rx="4" /><path d="M12 30h60" /><path d="m22 42 8 6-8 6M36 54h14" stroke="#4e7cff" /></g>}
  </svg>
);

const URL_TRAIN = 'https://aws.amazon.com/es/training/';
const URL_BUILDER = 'https://aws.amazon.com/es/developer/community/';

export function Home() {
  const s = useCloud();
  settle(s);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  const [cat, setCat] = useState('Todos');
  const [appModal, setAppModal] = useState(false);
  const [layout, setLayout] = useState<Layout>(loadLayout);
  const [menuFor, setMenuFor] = useState<WId | null>(null);
  const [infoFor, setInfoFor] = useState<WId | 'page' | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [dragId, setDragId] = useState<WId | null>(null);
  const [overId, setOverId] = useState<WId | null>(null);
  const update = (l: Layout) => { setLayout(l); saveLayout(l); };
  useEffect(() => {
    if (!menuFor) return;
    const f = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.wd-menu')) setMenuFor(null); };
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setMenuFor(null);
    addEventListener('mousedown', f); addEventListener('keydown', k);
    return () => { removeEventListener('mousedown', f); removeEventListener('keydown', k); };
  }, [menuFor]);
  const cost = estimateCost(s);
  const recent = (s.recent ?? []).map(entry).filter(Boolean) as { id: string; name: string; color: string; desc: string; home: string }[];
  const all = cat === 'Todos' ? SERVICES : SERVICES.filter((x) => x.cat === cat);
  const monthName = new Date().toLocaleString('es-ES', { month: 'long', year: 'numeric' });
  const go = (to: string) => (e: React.MouseEvent) => { e.preventDefault(); nav(to); };
  const drop = (to: WId) => {
    if (dragId && dragId !== to) {
      const order = layout.order.filter((x) => x !== dragId);
      order.splice(order.indexOf(to), 0, dragId);
      update({ ...layout, order });
    }
    setDragId(null); setOverId(null);
  };

  const render: Record<WId, { body: React.ReactNode; actions?: React.ReactNode; foot?: React.ReactNode }> = {
    recent: {
      actions: <button className="hm-btn sm" onClick={() => document.getElementById('hm-all')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>All services</button>,
      body: recent.length === 0 ? (
        <div className="hm-empty"><b>Aún no ha visitado ningún servicio</b>Los servicios que abra aparecerán aquí.</div>
      ) : (
        <div className="hm-list">
          {recent.map((x) => (
            <div key={x.id} className="hm-row">
              <ServiceIcon id={x.id} color={x.color} size={30} />
              <a href={'#' + x.home} onClick={go(x.home)}>{x.name}</a>
            </div>
          ))}
        </div>
      ),
    },
    welcome: {
      body: (
        <div className="hm-welcome">
          <div className="it"><Illus kind="rocket" /><div><a href="#/academy" onClick={go('/academy')}>Introducción a AWS</a><p>Conozca los aspectos fundamentales y encuentre información valiosa para sacar el máximo provecho de AWS.</p></div></div>
          <div className="it"><Illus kind="cert" /><div><a href={URL_TRAIN} target="_blank" rel="noreferrer">Formación y <span className="nw">certificación <Ext /></span></a><p>Aprenda de expertos de AWS, mejore sus habilidades y aumente sus conocimientos.</p></div></div>
          <div className="it"><Illus kind="hub" /><div><a href={URL_BUILDER} target="_blank" rel="noreferrer">Centro de creador en <span className="nw">AWS <Ext /></span></a><p>Aprenda, cree y conéctese con los creadores de la comunidad de AWS.</p></div></div>
          <div className="it"><Illus kind="cli" /><div><a href="#/cloudshell" onClick={go('/cloudshell')}>Pruebe el AWS CLI en CloudShell</a><p>Terminal ya autenticada con su usuario, lista para practicar.</p></div></div>
        </div>
      ),
    },
    health: {
      body: (
        <div className="hm-health">
          <div><div className="lb">Problemas abiertos</div><div className="vl"><span>0</span><small>Últimos 7 días</small></div></div>
          <div><div className="lb">Cambios programados</div><div className="vl"><span>0</span><small>Próximos 7 días y últimos 7 días</small></div></div>
          <div><div className="lb">Otras notificaciones</div><div className="vl"><span>0</span><small>Últimos 7 días</small></div></div>
        </div>
      ),
      foot: <a href="https://health.aws.amazon.com/health/status" target="_blank" rel="noreferrer">Vaya a AWS Health</a>,
    },
    cost: {
      actions: <span className="hm-muted">Simulado</span>,
      body: (
        <>
          <div className="hm-muted">Costo del mes hasta la fecha ({monthName})</div>
          <div className="hm-big" aria-label="Costo del mes hasta la fecha">{usd(cost.total)}</div>
          <div className="hm-muted" style={{ marginTop: 4 }}>
            {cost.running} instancia{cost.running === 1 ? '' : 's'} en ejecución · {usd(cost.hourly)}/hora · previsión mensual {usd(cost.monthly)}
          </div>
          <table className="hm-cost"><tbody>{cost.lines.map((l) => <tr key={l.label}><td>{l.label}</td><td>{usd(l.usd)}</td></tr>)}</tbody></table>
          <p style={{ margin: '10px 0 0' }}><a href="#/ec2/instances" onClick={go('/ec2/instances')}>Ver instancias</a></p>
        </>
      ),
    },
    summary: {
      body: (
        <div className="kv" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div><div className="k">Instancias en ejecución</div><div className="v"><a href="#/ec2/instances" onClick={go('/ec2/instances')}>{cost.running}</a></div></div>
          <div><div className="k">Buckets de S3</div><div className="v"><a href="#/s3/buckets" onClick={go('/s3/buckets')}>{s.buckets.length}</a></div></div>
          <div><div className="k">Usuarios de IAM</div><div className="v"><a href="#/iam/users" onClick={go('/iam/users')}>{s.users.length}</a></div></div>
          <div><div className="k">VPC (región actual)</div><div className="v"><a href="#/vpc/vpcs" onClick={go('/vpc/vpcs')}>{s.vpcs.filter((v) => v.region === s.region).length}</a></div></div>
          <div><div className="k">Región</div><div className="v">{s.region}</div></div>
          <div><div className="k">Eventos en CloudTrail</div><div className="v"><a href="#/cloudtrail/events" onClick={go('/cloudtrail/events')}>{s.trail.length}</a></div></div>
        </div>
      ),
    },
    apps: {
      actions: <button className="hm-btn sm" onClick={() => setAppModal(true)}>Crear aplicación</button>,
      body: (
        <>
          <div className="hm-muted" style={{ marginBottom: 6 }}>Región: {s.region}</div>
          <div className="hm-empty"><b>No hay aplicaciones</b>Las aplicaciones agrupan los recursos de una carga de trabajo para administrarlos juntos.</div>
        </>
      ),
    },
    all: {
      body: (
        <>
          <div className="hm-chips">
            {['Todos', ...CATEGORIES].map((c) => <button key={c} className={c === cat ? 'on' : ''} onClick={() => setCat(c)}>{c}</button>)}
          </div>
          <div className="hm-grid">
            {all.map((x) => (
              <a key={x.id} className="hm-tile" href={'#' + x.home} onClick={go(x.home)}>
                <ServiceIcon id={x.id} color={x.color} />
                <div><b>{x.name}</b><small>{x.desc}</small></div>
              </a>
            ))}
            {(cat === 'Todos' || cat === 'Administración y gobernanza') && (
              <a className="hm-tile" href="#/cloudshell" onClick={go('/cloudshell')}>
                <ServiceIcon id="cloudshell" color={SHELL.color} />
                <div><b>CloudShell</b><small>{SHELL.desc}</small></div>
              </a>
            )}
          </div>
          {all.length === 0 && <div className="hm-empty">No hay servicios en esta categoría.</div>}
        </>
      ),
    },
  };
  const visible = layout.order.filter((x) => !layout.hidden.includes(x));

  return (
    <div className="hm-wrap">
      <div className="hm-bar">
        <button className="hm-ib" title="Panel lateral" aria-label="Panel lateral" onClick={() => document.getElementById('hm-all')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}><CIcon name="panel" size={22} /></button>
        <span className="sp" />
        <button className="hm-ib" title="Información" aria-label="Información" onClick={() => setInfoFor('page')}><CIcon name="info" size={22} /></button>
      </div>
      <div className="hm-page">
        <div className="hm-title">
          <h1>Página de inicio de la Consola <a href="#info" className="hm-info" onClick={(e) => { e.preventDefault(); setInfoFor('page'); }}>Información</a></h1>
          <div className="acts">
            <button className="hm-btn" onClick={() => update({ order: DEFAULT_ORDER, hidden: [] })}>Restablecer al diseño predeterminado</button>
            <button className="hm-btn primary" onClick={() => setAddOpen(true)}><CIcon name="plus" size={18} sw={2} /> Agregar widgets</button>
          </div>
        </div>
        <div className="hm-grid-w">
          {visible.map((id) => {
            const m = META[id]; const r = render[id];
            return (
              <section key={id} id={id === 'all' ? 'hm-all' : undefined} className={`wd span${m.span}${m.tall ? ' tall' : ''}${dragId === id ? ' dragging' : ''}${overId === id && dragId !== id ? ' over' : ''}`}
                onDragOver={(e) => { if (dragId) { e.preventDefault(); setOverId(id); } }} onDrop={(e) => { e.preventDefault(); drop(id); }}>
                <header className="wd-head">
                  <span className="grip" draggable title="Arrastrar para mover" aria-label={`Mover widget ${m.title}`}
                    onDragStart={(e) => { setDragId(id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); const c = (e.currentTarget as HTMLElement).closest('.wd'); if (c) e.dataTransfer.setDragImage(c, 20, 20); }}
                    onDragEnd={() => { setDragId(null); setOverId(null); }}><Grip /></span>
                  <h2>{m.title} {id !== 'welcome' && <a href="#info" className="hm-info" onClick={(e) => { e.preventDefault(); setInfoFor(id); }}>Información</a>}</h2>
                  <span className="sp" />
                  {r.actions}
                  <span className="wd-menu">
                    <button className="hm-ib" aria-label={`Opciones de ${m.title}`} aria-expanded={menuFor === id} onClick={() => setMenuFor(menuFor === id ? null : id)}><Kebab /></button>
                    {menuFor === id && (
                      <div className="dropdown" role="menu">
                        <div role="menuitem" onClick={() => { update({ ...layout, hidden: [...layout.hidden, id] }); setMenuFor(null); }}>Quitar widget</div>
                        <div role="menuitem" onClick={() => { setInfoFor(id); setMenuFor(null); }}>Información</div>
                      </div>
                    )}
                  </span>
                </header>
                <div className="wd-body">{r.body}</div>
                {r.foot && <div className="wd-foot">{r.foot}</div>}
                <span className="rs" aria-hidden="true"><ResizeGlyph /></span>
              </section>
            );
          })}
        </div>
        {visible.length === 0 && <div className="hm-empty" style={{ padding: 60 }}><b>No hay widgets en la página</b>Utilice «Agregar widgets» para volver a mostrarlos.</div>}
      </div>
      {appModal && (
        <Modal title="Crear aplicación" onClose={() => setAppModal(false)} footer={<><Btn onClick={() => setAppModal(false)}>Cerrar</Btn><Btn kind="primary" onClick={() => { setAppModal(false); nav('/academy'); }}>Ir a la Academia</Btn></>}>
          <p style={{ marginTop: 0 }}>La gestión de aplicaciones no está disponible en este simulador. Puede practicar la organización de recursos con etiquetas (por ejemplo, <code>Name</code>) en VPC y EC2 desde la Academia.</p>
        </Modal>
      )}
      {infoFor && (
        <Modal title={infoFor === 'page' ? 'Página de inicio de la Consola' : META[infoFor].title} onClose={() => setInfoFor(null)} footer={<Btn kind="primary" onClick={() => setInfoFor(null)}>Cerrar</Btn>}>
          <p style={{ margin: 0 }}>{infoFor === 'page' ? 'Personalice su página de inicio: arrastre los widgets por su asa (⋮⋮) para reordenarlos, quítelos desde su menú (⋮) o vuelva a mostrarlos con «Agregar widgets».' : META[infoFor].info}</p>
        </Modal>
      )}
      {addOpen && (
        <Modal title="Agregar widgets" onClose={() => setAddOpen(false)} footer={<Btn kind="primary" onClick={() => setAddOpen(false)}>Listo</Btn>}>
          {DEFAULT_ORDER.map((id) => (
            <label key={id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 0' }}>
              <input type="checkbox" checked={!layout.hidden.includes(id)} onChange={(e) => update({ ...layout, hidden: e.target.checked ? layout.hidden.filter((x) => x !== id) : [...layout.hidden, id] })} />
              <span><b>{META[id].title}</b><br /><span className="hm-muted">{META[id].info}</span></span>
            </label>
          ))}
        </Modal>
      )}
    </div>
  );
}
