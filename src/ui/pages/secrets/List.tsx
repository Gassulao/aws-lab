import React, { useState } from 'react';
import { useCloud } from '../../session';
import { Btn, Card, Crumbs, Flash, PageHead, Table, nav, fmtDate } from '../../components/ui';
import { settleSecrets } from '../../../engine/services/secrets';
import { takeFlash } from '../iam/kit';

export function SecretsList() {
  const s = useCloud();
  const [flash, setFlash] = useState(takeFlash);
  settleSecrets(s);
  const rows = s.secrets.filter((x) => x.region === s.region);
  return (
    <>
      <Crumbs items={[{ label: 'AWS Secrets Manager', to: '/secretsmanager/secrets' }, { label: 'Secretos' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      <PageHead title="Secretos" desc="Almacene, rote y recupere credenciales, claves de API y otros secretos sin incluirlos en el código." />
      <Card title="Secretos" count={rows.length} flush actions={<Btn kind="primary" onClick={() => nav('/secretsmanager/create')}>Almacenar un secreto nuevo</Btn>}>
        <Table rows={rows} id={(x) => x.name} filterPlaceholder="Filtrar secretos por nombre, descripción, etiqueta…" empty={{ title: 'No hay secretos', desc: 'Todavía no ha almacenado ningún secreto en esta región.' }} cols={[
          { head: 'Nombre del secreto', cell: (x) => <a onClick={() => nav('/secretsmanager/secret/' + encodeURIComponent(x.name))}>{x.name}</a>, text: (x) => x.name },
          { head: 'Descripción', cell: (x) => x.description || '–', text: (x) => x.description ?? '' },
          { head: 'Rotación', cell: (x) => (x.rotation?.enabled ? `Cada ${x.rotation.days} días` : 'Deshabilitada') },
          { head: 'Último cambio', cell: (x) => fmtDate(x.changedAt), text: (x) => x.changedAt },
          { head: 'Estado', cell: (x) => (x.deletedAt ? <span className="k-badge warn">Eliminación programada</span> : <span className="k-badge ok">Activo</span>) },
        ]} />
      </Card>
    </>
  );
}
