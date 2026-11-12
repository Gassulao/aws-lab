import React, { useEffect, useState } from 'react';
import { SERVICES } from '../services';
import { ServiceIcon, CIcon } from '../pages/home/icons';
import { nav } from './ui';

/** Logotipo propio «aws»: texto estilizado con una sonrisa naranja (no es el logotipo real). */
export function AwsMark() {
  return (
    <svg className="awsmark" width="46" height="30" viewBox="0 0 46 30" role="img" aria-label="aws">
      <text x="1" y="17" fill="currentColor" fontFamily="'Inter','Helvetica Neue',Arial,sans-serif" fontWeight="800" fontSize="20" letterSpacing="-1.2">aws</text>
      <path d="M4 22.5c8 4.2 20 4.4 30-.8" fill="none" stroke="#ff9900" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M31.5 19.2l4.3 2.2-2.6 3.6" fill="none" stroke="#ff9900" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const DEFAULT_FAVS = ['iam', 'cloudshell', 'ec2', 's3'];
const readFavs = (): string[] => { try { const f = JSON.parse(localStorage.getItem('awslab.favs') ?? '[]'); return Array.isArray(f) && f.length ? f : DEFAULT_FAVS; } catch { return DEFAULT_FAVS; } };

/** Barra de favoritos (iconos de color + texto en negrita). Lee los favoritos del menú de servicios. */
export function FavBar() {
  const [favs, setFavs] = useState<string[]>(readFavs);
  useEffect(() => {
    const f = () => setFavs(readFavs());
    addEventListener('awslab-favs', f);
    addEventListener('storage', f);
    return () => { removeEventListener('awslab-favs', f); removeEventListener('storage', f); };
  }, []);
  const items = favs.map((id) => (id === 'cloudshell' ? { id, name: 'CloudShell', color: '#4a2fd0', home: '/cloudshell' } : SERVICES.find((x) => x.id === id))).filter(Boolean) as { id: string; name: string; color: string; home: string }[];
  return (
    <nav className="favbar" aria-label="Favoritos">
      {items.map((x) => (
        <a key={x.id} href={'#' + x.home} onClick={(e) => { e.preventDefault(); nav(x.home); }}>
          <ServiceIcon id={x.id} color={x.color} size={22} /> <b>{x.name}</b>
        </a>
      ))}
    </nav>
  );
}

/** Pie fijo de la consola. */
export function ConsoleFooter() {
  return (
    <footer className="consfoot">
      <span className="fl">
        <a href="#/cloudshell"><CIcon name="cloudshell" size={16} /> CloudShell</a>
        <a href="#/academy"><CIcon name="kit" size={16} /> Kit de herramientas de agentes para AWS</a>
        <a href="#/academy">Comentarios</a>
        <a href="#/"><CIcon name="mobile" size={16} /> Aplicación móvil de la consola</a>
      </span>
      <span className="fr">
        <span className="copy">© 2026, Amazon Web Services, Inc. o sus filiales.</span>
        <a href="https://aws.amazon.com/es/privacy/" target="_blank" rel="noreferrer"><b>Privacidad</b></a>
        <a href="https://aws.amazon.com/es/terms/" target="_blank" rel="noreferrer"><b>Términos</b></a>
        <a href="https://aws.amazon.com/es/privacy/" target="_blank" rel="noreferrer">Preferencias de cookies</a>
      </span>
    </footer>
  );
}

/** Nombre de región tal como lo muestra la consola real (el catálogo del motor usa «EE. UU.»). */
export const regionLabel = (n: string) => n.replace('EE. UU. Este (Virginia del Norte)', 'Estados Unidos (Norte de Virginia)').replace('EE. UU. Oeste (Oregón)', 'Estados Unidos (Oregón)').replace(/^EE\. UU\. /, 'Estados Unidos ');
