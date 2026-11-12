import React, { useEffect, useState } from 'react';
import { SERVICES } from '../services';
import { ServiceIcon, CIcon } from '../pages/home/icons';
import { nav } from './ui';

/** Marca propia «aws-lab»: nube naranja + texto. No imita el logotipo oficial de AWS. */
export function AwsMark() {
  return (
    <svg className="awsmark" width="92" height="30" viewBox="0 0 92 30" role="img" aria-label="aws-lab">
      <path d="M9 23h11a5 5 0 0 0 .6-9.96A6.5 6.5 0 0 0 8.2 11.6 5.7 5.7 0 0 0 9 23z" fill="#ff9900" />
      <text x="29" y="21" fill="currentColor" fontFamily="'Inter','Helvetica Neue',Arial,sans-serif" fontWeight="700" fontSize="16" letterSpacing="-0.4">aws-lab</text>
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
