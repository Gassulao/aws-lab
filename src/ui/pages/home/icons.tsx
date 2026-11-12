import React from 'react';

// Iconos propios (trazo simple, sin logotipos reales de AWS). Cada servicio usa un glifo en una rejilla de 24x24.
const G: Record<string, React.ReactNode> = {
  ec2: <><rect x="4" y="4" width="16" height="6" rx="1" /><rect x="4" y="14" width="16" height="6" rx="1" /><path d="M7.5 7h.01M7.5 17h.01M12 7h5M12 17h5" /></>,
  iam: <><path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z" /><circle cx="12" cy="10" r="2" /><path d="M12 12v4" /></>,
  s3: <><path d="M5 7c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3z" /><path d="M5 7l1.5 11c.2 1.2 2.8 2 5.5 2s5.3-.8 5.5-2L19 7" /></>,
  vpc: <><path d="M7 18a4 4 0 0 1-.6-7.9A5.5 5.5 0 0 1 17 9a3.5 3.5 0 0 1 .5 7" /><path d="M12 13v7M9 20h6M8 16h8" /></>,
  cloudtrail: <><path d="M4 5h16v14H4z" /><path d="M8 9h8M8 12h8M8 15h5" /></>,
  academy: <><path d="m2.5 9 9.5-4.5L21.5 9 12 13.5z" /><path d="M6 11.5V16c0 1.2 2.7 2.5 6 2.5s6-1.3 6-2.5v-4.5M21.5 9v5" /></>,
  cloudshell: <><rect x="3" y="4" width="18" height="16" rx="1.5" /><path d="m7 9 3 3-3 3M12.5 15H17" /></>,
  ecr: <><path d="M12 3 4 7.5v9L12 21l8-4.5v-9z" /><path d="M4 7.5 12 12l8-4.5M12 12v9" /></>,
  ecs: <><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /><rect x="13" y="13" width="7" height="7" rx="1" /></>,
  eks: <><path d="M12 3 20 7v10l-8 4-8-4V7z" /><path d="M12 8v8M8.5 10l7 4M15.5 10l-7 4" /></>,
  kms: <><circle cx="8.5" cy="12" r="3.5" /><path d="M12 12h8M17 12v3M20 12v2" /></>,
  cloudwatch: <><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3.5 2" /></>,
  route53: <><circle cx="12" cy="12" r="8" /><path d="M4 12h16M12 4c3 3 3 13 0 16M12 4c-3 3-3 13 0 16" /></>,
  sns: <><path d="M5 17V9l11-4v14z" /><path d="M16 9h3v6h-3M8 17l1 3h2l-1-3.5" /></>,
  secretsmanager: <><rect x="5" y="10" width="14" height="10" rx="1.5" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
  cloudformation: <><path d="M5 4h14v16H5z" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
  devtools: <><path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5.5l-3 13" /></>,
  default: <><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></>,
};

export function ServiceIcon({ id, color, size = 32 }: { id: string; color: string; size?: number }) {
  return (
    <span className="hm-ico" style={{ background: color, width: size, height: size }} aria-hidden="true">
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{G[id] ?? G.default}</svg>
    </span>
  );
}

/** Iconos de la «cromada» de la consola (cabecera, barra de favoritos, widgets). Rejilla 24x24, trazo = currentColor. */
const C: Record<string, React.ReactNode> = {
  sparkle: <path d="M12 3c.6 4.6 2.4 6.4 7 7-4.6.6-6.4 2.4-7 7-.6-4.6-2.4-6.4-7-7 4.6-.6 6.4-2.4 7-7zM19 3v3M17.5 4.5h3" />,
  grid: <><rect x="4" y="4" width="3.2" height="3.2" /><rect x="10.4" y="4" width="3.2" height="3.2" /><rect x="16.8" y="4" width="3.2" height="3.2" /><rect x="4" y="10.4" width="3.2" height="3.2" /><rect x="10.4" y="10.4" width="3.2" height="3.2" /><rect x="16.8" y="10.4" width="3.2" height="3.2" /><rect x="4" y="16.8" width="3.2" height="3.2" /><rect x="10.4" y="16.8" width="3.2" height="3.2" /><rect x="16.8" y="16.8" width="3.2" height="3.2" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5" /></>,
  cloudshell: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9.5 3 2.5-3 2.5M12.5 15H17" /></>,
  bell: <path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15zM10 21h4" />,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.3 9.5a2.8 2.8 0 1 1 3.9 2.6c-.8.4-1.2 1-1.2 1.9M12 17.2v.1" /></>,
  gear: <><circle cx="12" cy="12" r="8.2" strokeWidth="3.4" strokeDasharray="3.1 2.45" /><circle cx="12" cy="12" r="6.2" /><circle cx="12" cy="12" r="2.6" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.2v.1" /></>,
  panel: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M9 5v14" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  ext: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  mobile: <><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M11 18h2" /></>,
  kit: <><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M9 6V4h6v2M3 12h18" /></>,
};
export function CIcon({ name, size = 20, sw = 1.8 }: { name: string; size?: number; sw?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{C[name]}</svg>;
}
/** Asa de arrastre (⋮⋮), menú (⋮) y asa de redimensionado: glifos rellenos/trazo propios. */
export const Grip = () => <svg width="12" height="20" viewBox="0 0 12 20" fill="currentColor" aria-hidden="true">{[3, 8, 13].map((y) => <React.Fragment key={y}><circle cx="3" cy={y + 1} r="1.4" /><circle cx="9" cy={y + 1} r="1.4" /></React.Fragment>)}</svg>;
export const Kebab = () => <svg width="16" height="20" viewBox="0 0 16 20" fill="currentColor" aria-hidden="true"><circle cx="8" cy="4" r="1.7" /><circle cx="8" cy="10" r="1.7" /><circle cx="8" cy="16" r="1.7" /></svg>;
export const ResizeGlyph = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M14 3 3 14M14 8l-6 6" /></svg>;
export const Caret = () => <svg width="10" height="8" viewBox="0 0 10 8" fill="currentColor" aria-hidden="true"><path d="M0 0h10L5 8z" /></svg>;
