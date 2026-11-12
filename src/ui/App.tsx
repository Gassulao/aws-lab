import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useCloud } from './session';
import { CATEGORIES, SERVICES, isActive, isKnownRoute, searchIndex, svcOf, type SearchEntry } from './services';
import { Icon, nav } from './components/ui';
import { AwsMark, FavBar, ConsoleFooter, regionLabel } from './components/chrome';
import { CIcon, Caret } from './pages/home/icons';
import { REGIONS } from '../engine/catalog';
import { mutate, resetCloud } from '../engine/store';
import { Home } from './pages/Home';
import { Ec2Pages } from './pages/Ec2';
import { IamPages } from './pages/Iam';
import { S3Pages } from './pages/S3';
import { VpcPages } from './pages/Vpc';
import { TrailPage } from './pages/Trail';
import { KmsPages } from './pages/Kms';
import { EcrPages, EcsPages, EksPages } from './pages/Containers';
import { SecretsPages } from './pages/Secrets';
import { DevtoolsPages } from './pages/devtools';
import { CloudFormationPages } from './pages/CloudFormation';
import { CloudwatchPages } from './pages/Cloudwatch';
import { SnsPages } from './pages/Sns';
import { Route53Pages } from './pages/Route53';
import { AcademyPages } from './pages/Academy';
import { CloudShell } from './pages/CloudShell';
import { GovernancePages } from './pages/governance';
import { ServerlessPages } from './pages/serverless';
import { RdsPages } from './pages/rds';

const normalize = (h: string) => {
  let p = h.replace(/^#/, '').split('?')[0];
  if (!p.startsWith('/')) p = '/' + p;
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p || '/';
};

function useRoute() {
  const [p, setP] = useState(() => normalize(location.hash));
  useEffect(() => {
    const f = () => setP(normalize(location.hash));
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return p;
}

function useMedia(q: string) {
  const [m, setM] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const f = () => setM(mq.matches);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, [q]);
  return m;
}

const lsGet = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };

function useFavs(): [string[], (id: string) => void] {
  const [favs, setFavs] = useState<string[]>(() => { try { return JSON.parse(lsGet('awslab.favs') ?? '[]'); } catch { return []; } });
  const toggle = (id: string) => setFavs((f) => { const n = f.includes(id) ? f.filter((x) => x !== id) : [...f, id]; lsSet('awslab.favs', JSON.stringify(n)); setTimeout(() => dispatchEvent(new Event('awslab-favs'))); return n; });
  return [favs, toggle];
}

type Theme = 'light' | 'dark' | 'auto';

function ServicesMenu({ onGo }: { onGo: (to: string) => void }) {
  const [favs, toggleFav] = useFavs();
  const [cat, setCat] = useState<string>(favs.length ? 'Favoritos' : 'Todos');
  const list = cat === 'Favoritos' ? SERVICES.filter((x) => favs.includes(x.id)) : cat === 'Todos' ? SERVICES : SERVICES.filter((x) => x.cat === cat);
  return (
    <div className="svc-panel" role="menu">
      <div className="cats">
        {['Favoritos', 'Todos', ...CATEGORIES].map((c) => (
          <button key={c} className={c === cat ? 'on' : ''} onClick={() => setCat(c)}>{c}</button>
        ))}
      </div>
      <div className="list">
        <div className="lh">{cat === 'Todos' ? 'Todos los servicios' : cat}</div>
        {list.length === 0 && <div className="none">Aún no tienes favoritos. Marca un servicio con la estrella para añadirlo.</div>}
        {list.map((x) => (
          <div key={x.id} className="row">
            <a href={'#' + x.home} onClick={() => onGo(x.home)} role="menuitem">
              <span className="ico sm" style={{ background: x.color }}>{x.short}</span>
              <span><b>{x.name}</b><small>{x.desc}</small></span>
            </a>
            <button className={'star ' + (favs.includes(x.id) ? 'on' : '')} onClick={() => toggleFav(x.id)} aria-label={favs.includes(x.id) ? 'Quitar de favoritos' : 'Añadir a favoritos'} title={favs.includes(x.id) ? 'Quitar de favoritos' : 'Añadir a favoritos'}>
              <Icon name="star" size={16} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function SearchBox({ path }: { path: string }) {
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const [focus, setFocus] = useState(false);
  const index = useMemo(searchIndex, []);
  const ref = useRef<HTMLDivElement>(null);
  const norm = (x: string) => x.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const found: SearchEntry[] = useMemo(() => {
    const n = norm(q.trim());
    if (!n) return [];
    const score = (e: SearchEntry) => {
      const t = norm(e.title);
      return t === n ? 0 : t.startsWith(n) ? 1 : t.includes(n) ? 2 : norm(e.parent ?? '').includes(n) ? 3 : norm(e.desc).includes(n) ? 4 : 9;
    };
    return index.map((e) => [e, score(e)] as const).filter(([, s]) => s < 9).sort((a, b) => a[1] - b[1]).map(([e]) => e).slice(0, 10);
  }, [q, index]);
  useEffect(() => { setQ(''); setHi(0); }, [path]);
  useEffect(() => setHi(0), [q]);
  useEffect(() => {
    const f = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setFocus(false);
    addEventListener('mousedown', f);
    return () => removeEventListener('mousedown', f);
  }, []);
  // Atajo "/" para enfocar el buscador, como en la consola real.
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if ((e.key === '/' || (e.altKey && e.key.toLowerCase() === 's')) && !/INPUT|TEXTAREA|SELECT/.test(t.tagName) && !t.isContentEditable) { e.preventDefault(); ref.current?.querySelector('input')?.focus(); }
    };
    addEventListener('keydown', f);
    return () => removeEventListener('keydown', f);
  }, []);
  const go = (e: SearchEntry) => { nav(e.to); setQ(''); setFocus(false); (document.activeElement as HTMLElement | null)?.blur?.(); };
  const open = focus && q.trim().length > 0;
  return (
    <div className="search" ref={ref} role="search">
      <CIcon name="search" size={18} />
      <input
        placeholder="Buscar"
        aria-label="Buscar"
        value={q}
        onFocus={() => setFocus(true)}
        onChange={(e) => { setQ(e.target.value); setFocus(true); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, found.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === 'Enter' && found[hi]) go(found[hi]);
          else if (e.key === 'Escape') { setQ(''); setFocus(false); (e.target as HTMLElement).blur(); }
        }}
      />
      <kbd>[Alt+S] <CIcon name="sparkle" size={18} sw={1.6} /></kbd>
      {open && (
        <div className="results" role="listbox">
          {found.length === 0 && <div className="noresult">No se encontraron resultados para «{q}»</div>}
          {found.map((x, i) => (
            <div key={x.key} role="option" aria-selected={i === hi} className={i === hi ? 'on' : ''} onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); go(x); }}>
              <span className="ico sm" style={{ background: x.color }}>{x.short}</span>
              <span className="rt"><b>{x.title}</b>{x.parent && <span className="par"> · {x.parent}</span>}<small>{x.desc}</small></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const THEMES: { id: Theme; label: string; icon: string }[] = [
  { id: 'light', label: 'Claro', icon: 'sun' },
  { id: 'dark', label: 'Oscuro', icon: 'moon' },
  { id: 'auto', label: 'Automático', icon: 'auto' },
];

function TopBar({ path }: { path: string }) {
  const s = useCloud();
  const [open, setOpen] = useState<'region' | 'user' | 'svc' | 'bell' | 'help' | 'settings' | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setOpen(null), [path]);
  useEffect(() => {
    const f = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(null);
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    addEventListener('mousedown', f);
    addEventListener('keydown', k);
    return () => { removeEventListener('mousedown', f); removeEventListener('keydown', k); };
  }, []);
  const region = REGIONS.find((r) => r.code === s.region);
  const acct = s.account.id.replace(/(\d{4})(\d{4})(\d{4})/, '$1-$2-$3');
  const theme = (s.settings.theme ?? 'light') as Theme;
  const toggle = (k: 'region' | 'user' | 'svc' | 'bell' | 'help' | 'settings') => setOpen(open === k ? null : k);
  return (
    <>
    <header className="topbar" ref={ref}>
      <a className="brand" href="#/" title="Ir a la página de inicio de la consola" aria-label="Inicio"><AwsMark /></a>
      <button className="tb-ico" onClick={() => nav('/academy')} title="Asistente" aria-label="Asistente"><CIcon name="sparkle" size={22} /></button>
      <span className="tb-div" />
      <div className="menu">
        <button className={'tb-ico ' + (open === 'svc' ? 'open' : '')} onClick={() => toggle('svc')} aria-expanded={open === 'svc'} aria-haspopup="menu" title="Servicios" aria-label="Servicios">
          <CIcon name="grid" size={24} sw={2} />
        </button>
        {open === 'svc' && <ServicesMenu onGo={() => setOpen(null)} />}
      </div>
      <SearchBox path={path} />
      <div className="spacer" />
      <button className="tb-ico sep" onClick={() => nav('/cloudshell')} title="CloudShell" aria-label="CloudShell"><CIcon name="cloudshell" size={22} /></button>
      <div className="menu">
        <button className="tb-ico sep" onClick={() => toggle('bell')} aria-expanded={open === 'bell'} title="Notificaciones" aria-label="Notificaciones"><CIcon name="bell" size={22} /></button>
        {open === 'bell' && <div className="dropdown" role="menu"><div className="dh">Notificaciones</div><div className="acct"><small>No hay notificaciones nuevas.</small></div></div>}
      </div>
      <div className="menu">
        <button className="tb-ico sep" onClick={() => toggle('help')} aria-expanded={open === 'help'} title="Soporte" aria-label="Soporte"><CIcon name="help" size={22} /></button>
        {open === 'help' && (
          <div className="dropdown" role="menu">
            <div className="dh">Ayuda</div>
            <div role="menuitem" onClick={() => { nav('/academy'); setOpen(null); }}>Academia del simulador</div>
            <div role="menuitem" onClick={() => { window.open('https://docs.aws.amazon.com/es_es/', '_blank', 'noopener'); setOpen(null); }}>Documentación de AWS</div>
          </div>
        )}
      </div>
      <div className="menu">
        <button className="tb-ico sep" onClick={() => toggle('settings')} aria-expanded={open === 'settings'} title="Configuración" aria-label="Configuración"><CIcon name="gear" size={22} /></button>
        {open === 'settings' && (
          <div className="dropdown wide" role="menu">
            <div className="dh">Tema visual</div>
            <div className="seg" role="radiogroup" aria-label="Tema visual">
              {THEMES.map((t) => (
                <button key={t.id} role="radio" aria-checked={theme === t.id} className={theme === t.id ? 'on' : ''} onClick={() => mutate((st) => { st.settings.theme = t.id; })}>
                  <Icon name={t.icon} size={14} /> {t.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="menu region">
        <button onClick={() => toggle('region')} aria-expanded={open === 'region'} aria-haspopup="menu" className="txtbtn">
          <span>{regionLabel(region?.name ?? s.region)}</span> <Caret />
        </button>
        {open === 'region' && (
          <div className="dropdown" role="menu">
            <div className="dh">Región</div>
            {REGIONS.map((r) => (
              <div key={r.code} role="menuitemradio" aria-checked={r.code === s.region} className={r.code === s.region ? 'sel' : ''} onClick={() => { mutate((st) => { st.region = r.code; }); setOpen(null); }}>
                <span className="rad" /> {regionLabel(r.name)} <small style={{ color: 'var(--muted)' }}>{r.code}</small>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="menu acctmenu">
        <button onClick={() => toggle('user')} aria-expanded={open === 'user'} aria-haspopup="menu" className="txtbtn acctbtn">
          <span className="hide-sm">{s.settings.userDisplayName} ({acct})</span> <Caret />
        </button>
        <span className="acctname hide-sm">{s.settings.userDisplayName}</span>
        {open === 'user' && (
          <div className="dropdown wide" role="menu">
            <div className="acct">
              <b>{s.me.userName}</b>
              <small>ID de cuenta: {acct}</small>
              <small>{s.settings.userDisplayName}</small>
            </div>
            <hr />
            <div role="menuitem" onClick={() => { nav('/'); setOpen(null); }}>Página de inicio de la consola</div>
            <div role="menuitem" onClick={() => { if (confirm('¿Reiniciar toda la cuenta simulada? Se borrará el progreso de recursos.')) resetCloud(); setOpen(null); }}>Reiniciar la cuenta simulada</div>
          </div>
        )}
      </div>
    </header>
    <FavBar />
    </>
  );
}

function SideNav({ path, open, setOpen }: { path: string; open: boolean; setOpen: (o: boolean) => void }) {
  const svc = svcOf(path);
  if (!svc) return null;
  if (!open) {
    return (
      <nav className="sidenav closed" aria-label="Navegación de servicio">
        <button className="iconbtn" onClick={() => setOpen(true)} aria-label="Abrir navegación" title="Abrir navegación">
          <Icon name="menu" size={18} />
        </button>
      </nav>
    );
  }
  return (
    <nav className="sidenav" aria-label="Navegación de servicio">
      <div className="navhead">
        <a className="title" href={'#' + svc.home}>{svc.name}</a>
        <button className="iconbtn" onClick={() => setOpen(false)} aria-label="Cerrar navegación" title="Cerrar navegación">
          <Icon name="chevronL" size={16} />
        </button>
      </div>
      {svc.nav.map((n, i) =>
        'sep' in n ? <hr key={i} /> : 'group' in n ? <div key={i} className="group">{n.group}</div> : (
          <a key={i} href={'#' + n.to} className={isActive(path, svc, n) ? 'on' : ''} aria-current={isActive(path, svc, n) ? 'page' : undefined}>{n.label}</a>
        ),
      )}
    </nav>
  );
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error('Error de render en la página:', error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="notfound">
        <div className="flash err" role="alert">
          <span className="ficon" aria-hidden="true" />
          <div className="fbody">
            <b>Algo ha fallado al mostrar esta página</b>
            Se ha producido un error inesperado en el simulador. Tu cuenta simulada no se ha modificado.
            <pre className="errmsg">{String(this.state.error.message || this.state.error)}</pre>
          </div>
        </div>
        <button className="btn primary" onClick={() => { this.setState({ error: null }); nav('/'); }}>Volver al inicio</button>
      </div>
    );
  }
}

function NotFound({ path }: { path: string }) {
  return (
    <div className="notfound">
      <h1>No se encuentra la página</h1>
      <p>La dirección <code>{path}</code> no existe en la consola del simulador. Es posible que el enlace esté obsoleto o que lo hayas escrito mal.</p>
      <a className="btn primary" href="#/">Ir a la página de inicio de la consola</a>
    </div>
  );
}

export function App() {
  const path = useRoute();
  const s = useCloud();
  const dark = useMedia('(prefers-color-scheme: dark)');
  const narrow = useMedia('(max-width: 1100px)');
  const [navPref, setNavPref] = useState(() => lsGet('awslab.nav') !== 'closed');
  const [navNarrow, setNavNarrow] = useState(true);
  const mainRef = useRef<HTMLDivElement>(null);
  const theme = (s.settings.theme ?? 'light') as Theme;
  const resolved = theme === 'auto' ? (dark ? 'dark' : 'light') : theme;
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);
  // En pantallas estrechas el menú se pliega solo; el usuario puede abrirlo manualmente.
  useEffect(() => setNavNarrow(true), [narrow, path]);
  const navOpen = narrow ? !navNarrow : navPref;
  const setNavOpen = (o: boolean) => {
    if (narrow) setNavNarrow(!o);
    else { setNavPref(o); lsSet('awslab.nav', o ? 'open' : 'closed'); }
  };
  const svc = svcOf(path);
  useEffect(() => {
    mainRef.current?.scrollTo(0, 0);
    window.scrollTo(0, 0);
    document.title = (path === '/' ? 'Consola' : svc ? svc.name : 'AWS Lab') + ' | AWS Lab';
  }, [path, svc]);
  // Accesibilidad: los enlaces sin href de las páginas se pueden enfocar y activar con el teclado.
  useEffect(() => {
    const fix = () => document.querySelectorAll('a:not([href])').forEach((a) => { if (!a.hasAttribute('tabindex')) { a.setAttribute('tabindex', '0'); a.setAttribute('role', 'link'); } });
    fix();
    const mo = new MutationObserver(fix);
    mo.observe(document.body, { childList: true, subtree: true });
    const k = (e: KeyboardEvent) => { const t = e.target as HTMLElement; if (e.key === 'Enter' && t.tagName === 'A' && !t.hasAttribute('href')) t.click(); };
    addEventListener('keydown', k);
    return () => { mo.disconnect(); removeEventListener('keydown', k); };
  }, []);
  let page: React.ReactNode;
  if (!isKnownRoute(path)) page = <NotFound path={path} />;
  else if (path === '/') page = <Home />;
  else if (path.startsWith('/cloudshell')) page = <CloudShell />;
  else if (svc?.id === 'ec2') page = <Ec2Pages path={path} />;
  else if (svc?.id === 'iam') page = <IamPages path={path} />;
  else if (svc?.id === 's3') page = <S3Pages path={path} />;
  else if (svc?.id === 'vpc') page = <VpcPages path={path} />;
  else if (svc?.id === 'kms') page = <KmsPages path={path} />;
  else if (svc && ['organizations', 'config', 'billing', 'trustedadvisor'].includes(svc.id)) page = <GovernancePages svc={svc.id} path={path} />;
  else if (svc && ['lambda', 'apigateway', 'sqs', 'dynamodb'].includes(svc.id)) page = <ServerlessPages svc={svc.id} path={path} />;
  else if (svc?.id === 'rds') page = <RdsPages path={path} />;
  else if (svc?.id === 'ecr') page = <EcrPages path={path} />;
  else if (svc?.id === 'ecs') page = <EcsPages path={path} />;
  else if (svc?.id === 'eks') page = <EksPages path={path} />;
  else if (svc?.id === 'secretsmanager') page = <SecretsPages path={path} />;
  else if (svc?.id === 'cloudformation') page = <CloudFormationPages path={path} />;
  else if (svc?.id === 'devtools') page = <DevtoolsPages path={path} />;
  else if (svc?.id === 'cloudwatch') page = <CloudwatchPages path={path} />;
  else if (svc?.id === 'sns') page = <SnsPages path={path} />;
  else if (svc?.id === 'route53') page = <Route53Pages path={path} />;
  else if (svc?.id === 'cloudtrail') page = <TrailPage />;
  else if (svc?.id === 'academy') page = <AcademyPages path={path} />;
  else page = <NotFound path={path} />;
  return (
    <div className="app">
      <a className="skip" href="#/" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>Saltar al contenido principal</a>
      <TopBar path={path} />
      <div className="body">
        <SideNav path={path} open={navOpen} setOpen={setNavOpen} />
        {narrow && svc && navOpen && <div className="scrim" onClick={() => setNavOpen(false)} />}
        <main className="main" ref={mainRef} tabIndex={-1}>
          <ErrorBoundary key={path}>{page}</ErrorBoundary>
        </main>
      </div>
      <ConsoleFooter />
    </div>
  );
}
