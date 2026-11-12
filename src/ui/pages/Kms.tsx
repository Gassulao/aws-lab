import React from 'react';
import './kms/kms.css';
import { KmsKeys } from './kms/Keys';
import { CreateKey } from './kms/CreateKey';
import { KeyDetail } from './kms/KeyDetail';

export function KmsPages({ path }: { path: string }) {
  const clean = path.split('?')[0];
  if (clean.startsWith('/kms/create')) return <CreateKey />;
  if (clean.startsWith('/kms/key/')) return <KeyDetail key={clean} id={decodeURIComponent(clean.split('/')[3] ?? '')} />;
  if (clean.startsWith('/kms/aws-keys')) return <KmsKeys managed="AWS" />;
  return <KmsKeys managed="CUSTOMER" />;
}
