import React from 'react';
import { Status } from '../../components/ui';
import type { KmsKey, CloudState } from '../../../engine/types';

export const keyStatus = (k: KmsKey) =>
  k.state === 'Enabled' ? <Status tone="ok">Habilitada</Status> : k.state === 'Disabled' ? <Status tone="">Deshabilitada</Status> : <Status tone="warn">Pendiente de eliminación</Status>;

export const aliasesOf = (s: CloudState, k: KmsKey) => s.kmsAliases.filter((a) => a.keyId === k.id && a.region === k.region).map((a) => a.name);

/** Principales de IAM para los selectores de permisos de la clave. */
export function principals(s: CloudState): { arn: string; label: string; kind: string }[] {
  return [
    ...s.users.map((u) => ({ arn: u.arn, label: u.name, kind: 'Usuario' })),
    ...s.roles.map((r) => ({ arn: r.arn, label: r.name, kind: 'Rol' })),
  ];
}
