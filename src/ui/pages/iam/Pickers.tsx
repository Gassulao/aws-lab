import React from 'react';
import { useCloud } from '../../session';
import { Table } from '../../components/ui';
import { policyKind } from './kit';

export function PolicyPicker({ selected, onChange, exclude = [] }: { selected: string[]; onChange: (arns: string[]) => void; exclude?: string[] }) {
  const s = useCloud();
  const rows = s.policies.filter((p) => !exclude.includes(p.arn));
  return (
    <Table
      rows={rows}
      id={(p) => p.arn}
      selected={selected}
      onSelect={onChange}
      filterPlaceholder="Filtrar políticas por propiedad o nombre de política y presione Intro"
      empty={{ title: 'No hay políticas' }}
      cols={[
        { head: 'Nombre de la política', cell: (p) => p.name, text: (p) => p.name },
        { head: 'Tipo', cell: (p) => policyKind(p.arn), text: (p) => policyKind(p.arn) },
        { head: 'Entidades adjuntas', cell: (p) => p.attachmentCount },
        { head: 'Descripción', cell: (p) => <span className="k-muted">{p.description ?? '-'}</span>, text: (p) => p.description ?? '' },
      ]}
    />
  );
}
