import React from 'react';

export interface Bpa { BlockPublicAcls: boolean; IgnorePublicAcls: boolean; BlockPublicPolicy: boolean; RestrictPublicBuckets: boolean }
export const ALL_BLOCKED: Bpa = { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true };
export const allBlocked = (b: Bpa) => Object.values(b).every(Boolean);
export const noneBlocked = (b: Bpa) => !Object.values(b).some(Boolean);

const ROWS: [keyof Bpa, string, string][] = [
  ['BlockPublicAcls', 'Bloquear el acceso público a buckets y objetos concedido a través de nuevas listas de control de acceso (ACL)', 'S3 bloqueará los permisos de acceso público aplicados a buckets u objetos agregados recientemente e impedirá la creación de nuevas ACL de acceso público para buckets y objetos existentes.'],
  ['IgnorePublicAcls', 'Bloquear el acceso público a buckets y objetos concedido a través de cualquier lista de control de acceso (ACL)', 'S3 ignorará todas las ACL que concedan acceso público a buckets y objetos.'],
  ['BlockPublicPolicy', 'Bloquear el acceso público a buckets y objetos concedido a través de nuevas políticas de bucket y de puntos de acceso públicas', 'S3 bloqueará las nuevas políticas de bucket y de puntos de acceso que concedan acceso público a buckets y objetos.'],
  ['RestrictPublicBuckets', 'Bloquear el acceso público y entre cuentas a buckets y objetos a través de cualquier política de bucket y de punto de acceso pública', 'S3 ignorará el acceso público y entre cuentas en el caso de buckets o puntos de acceso con políticas que concedan acceso público a buckets y objetos.'],
];

export function BpaEditor({ value, onChange }: { value: Bpa; onChange: (v: Bpa) => void }) {
  return (
    <div className="s3-bpa">
      <label className="row">
        <input type="checkbox" checked={allBlocked(value)} onChange={(e) => onChange({ BlockPublicAcls: e.target.checked, IgnorePublicAcls: e.target.checked, BlockPublicPolicy: e.target.checked, RestrictPublicBuckets: e.target.checked })} />
        <div><b>Bloquear <i>todo</i> el acceso público</b><small>Al activar esta configuración se activan también las cuatro opciones siguientes. Cada una es independiente de las demás.</small></div>
      </label>
      {ROWS.map(([k, t, d]) => (
        <label className="row sub" key={k}>
          <input type="checkbox" checked={value[k]} onChange={(e) => onChange({ ...value, [k]: e.target.checked })} />
          <div><b>{t}</b><small>{d}</small></div>
        </label>
      ))}
    </div>
  );
}

export const bpaArg = (b: Bpa) => `BlockPublicAcls=${b.BlockPublicAcls},IgnorePublicAcls=${b.IgnorePublicAcls},BlockPublicPolicy=${b.BlockPublicPolicy},RestrictPublicBuckets=${b.RestrictPublicBuckets}`;
