import React, { useState } from 'react';
import { useCloud } from '../../session';
import { Btn, Card, Crumbs, PageHead, Table, nav, Flash } from '../../components/ui';
import { settleKms } from '../../../engine/services/kms';
import { aliasesOf, keyStatus } from './common';
import { takeFlash } from '../iam/kit';

export function KmsKeys({ managed }: { managed: 'AWS' | 'CUSTOMER' }) {
  const s = useCloud();
  const [flash, setFlash] = useState(takeFlash);
  settleKms(s);
  const rows = s.kmsKeys.filter((k) => k.manager === managed && k.region === s.region);
  return (
    <>
      <Crumbs items={[{ label: 'Key Management Service (KMS)', to: '/kms/keys' }, { label: managed === 'AWS' ? 'Claves administradas por AWS' : 'Claves administradas por el cliente' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      <PageHead title={managed === 'AWS' ? 'Claves administradas por AWS' : 'Claves administradas por el cliente'} desc={managed === 'AWS' ? 'AWS crea estas claves en su cuenta la primera vez que usa un servicio integrado con KMS (por ejemplo, S3 o Secrets Manager con cifrado predeterminado).' : 'Las claves administradas por el cliente son claves de KMS que usted crea, posee y administra.'} />
      <Card title={managed === 'AWS' ? 'Claves administradas por AWS' : 'Claves administradas por el cliente'} count={rows.length} flush actions={managed === 'CUSTOMER' ? <Btn kind="primary" onClick={() => nav('/kms/create')}>Crear clave</Btn> : undefined}>
        <Table rows={rows} id={(k) => k.id} filterPlaceholder="Filtrar claves por propiedades o etiquetas" empty={{ title: managed === 'AWS' ? 'Aún no hay claves administradas por AWS' : 'No hay claves', desc: managed === 'AWS' ? 'Se crean automáticamente cuando un servicio las necesita.' : 'No tiene claves administradas por el cliente en esta región. Cree una para cifrar sus datos.' }} cols={[
          { head: 'Alias', cell: (k) => (aliasesOf(s, k).length ? <a onClick={() => nav('/kms/key/' + k.id)}>{aliasesOf(s, k).join(', ')}</a> : <span className="k-muted">–</span>), text: (k) => aliasesOf(s, k).join(', ') },
          { head: 'ID de clave', cell: (k) => <a onClick={() => nav('/kms/key/' + k.id)}>{k.id}</a>, text: (k) => k.id },
          { head: 'Estado', cell: keyStatus, text: (k) => k.state },
          { head: 'Tipo de clave', cell: () => 'Simétrica' },
          { head: 'Uso de claves', cell: () => 'Cifrar y descifrar' },
          { head: 'Regionalidad', cell: () => 'Región única' },
        ]} />
      </Card>
    </>
  );
}
