import React from 'react';
import { useCloud } from '../../session';
import { useProgress } from '../../academy/store';
import type { Progress } from '../../academy/progress';
import type { Difficulty, Exercise } from '../../academy/types';
import { xpOf } from '../../academy/progress';

type P = { size?: number; className?: string };
const svg = (path: React.ReactNode, vb = '0 0 16 16') => ({ size = 16, className }: P) => (
  <svg className={className} width={size} height={size} viewBox={vb} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{path}</svg>
);
export const IconLock = svg(<><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5 7V5a3 3 0 0 1 6 0v2" /></>);
export const IconCheck = svg(<path d="M3 8.5l3.2 3L13 4.5" />);
export const IconClock = svg(<><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.3 1.5" /></>);
export const IconBulb = svg(<><path d="M6 12h4M6.6 14h2.8" /><path d="M8 1.8a4.2 4.2 0 0 0-2.4 7.6c.5.4.8 1 .8 1.6h3.2c0-.6.3-1.2.8-1.6A4.2 4.2 0 0 0 8 1.8z" /></>);
export const IconReset = svg(<><path d="M2.5 8a5.5 5.5 0 1 0 1.8-4.1" /><path d="M2.5 2.5v3h3" /></>);
export const IconTerm = svg(<><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M4.5 6l2.2 2-2.2 2M8.5 10.5h3" /></>);
export const IconArrowR = svg(<path d="M3 8h10M9 4l4 4-4 4" />);
export const IconArrowL = svg(<path d="M13 8H3M7 4L3 8l4 4" />);
export const IconBook = svg(<><path d="M2.5 3.2c2-.7 3.9-.5 5.5.6v9c-1.6-1.1-3.5-1.3-5.5-.6z" /><path d="M13.5 3.2c-2-.7-3.9-.5-5.5.6v9c1.6-1.1 3.5-1.3 5.5-.6z" /></>);
export const IconFlask = svg(<><path d="M6 2h4M6.8 2v4.2L3 12.6A1.2 1.2 0 0 0 4 14.4h8a1.2 1.2 0 0 0 1-1.8L9.2 6.2V2" /><path d="M4.6 10.4h6.8" /></>);
export const IconQuiz = svg(<><circle cx="8" cy="8" r="6" /><path d="M6.2 6.3A1.9 1.9 0 1 1 8.9 8c-.6.4-.9.7-.9 1.4M8 11.3v.2" /></>);
export const IconStar = svg(<path d="M8 1.8l1.9 4 4.3.5-3.2 3 .9 4.3L8 11.4 4.1 13.6l.9-4.3-3.2-3 4.3-.5z" />);

/** Progreso para calcular desbloqueos: tiene en cuenta el «modo libre» de los ajustes de la nube. */
export function useProgressEff(): Progress {
  const s = useCloud();
  const p = useProgress();
  return s.settings.freeMode && !p.freeMode ? { ...p, freeMode: true } : p;
}

export const DIFF_CLASS: Record<Difficulty, string> = { 'Fácil': 'easy', 'Media': 'mid', 'Difícil': 'hard', 'Reto': 'boss' };

export function DiffBadge({ d }: { d: Difficulty }) {
  return <span className={`acad-diff ${DIFF_CLASS[d]}`}>{d}</span>;
}

export function Bar({ percent, label }: { percent: number; label?: string }) {
  return (
    <div className="acad-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={label}>
      <div style={{ width: Math.max(0, Math.min(100, percent)) + '%' }} />
    </div>
  );
}

export function ExMeta({ e }: { e: Exercise }) {
  return (
    <div className="acad-meta">
      <DiffBadge d={e.difficulty} />
      <span className="acad-chip"><IconClock size={13} /> {e.minutes} min</span>
      <span className="acad-chip acad-xp"><IconStar size={13} /> {xpOf(e)} XP</span>
    </div>
  );
}

export function SaaPills({ e }: { e: Exercise }) {
  const short = (x: string) => x.replace(/^Dominio (\d) · Diseño de arquitecturas /, 'SAA D$1 · ');
  return <>{e.saa?.map((x) => <span key={x} className="acad-saa" title={x}>{short(x)}</span>)}{e.tags?.map((t) => <span key={t} className="acad-tag">{t}</span>)}</>;
}
