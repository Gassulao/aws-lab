import React from 'react';
import './secrets/secrets.css';
import { SecretsList } from './secrets/List';
import { CreateSecret } from './secrets/Create';
import { SecretDetail } from './secrets/Detail';

export function SecretsPages({ path }: { path: string }) {
  const clean = path.split('?')[0];
  if (clean.startsWith('/secretsmanager/create')) return <CreateSecret />;
  if (clean.startsWith('/secretsmanager/secret/')) return <SecretDetail key={clean} name={decodeURIComponent(clean.slice('/secretsmanager/secret/'.length))} />;
  return <SecretsList />;
}
