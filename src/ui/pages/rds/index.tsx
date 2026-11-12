import React from 'react';
import { RdsList, RdsCreate, RdsDetail, RdsSnapshots, RdsSubnetGroups } from './Rds';

const seg = (path: string, n: number) => decodeURIComponent(path.split('?')[0].split('/')[n] ?? '');

export function RdsPages({ path }: { path: string }) {
  if (path.startsWith('/rds/database/')) return <RdsDetail key={path} id={seg(path, 3)} />;
  if (path === '/rds/create') return <RdsCreate />;
  if (path === '/rds/snapshots') return <RdsSnapshots />;
  if (path === '/rds/subnetgroups') return <RdsSubnetGroups />;
  return <RdsList />;
}
