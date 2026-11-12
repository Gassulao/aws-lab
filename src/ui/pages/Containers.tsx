import React from 'react';
import { EcrRepos, EcrRepo } from './containers/Ecr';
import { EcsClusters, EcsCluster, EcsService } from './containers/Ecs';
import { EksClusters, EksCluster } from './containers/Eks';

const seg = (path: string, n: number) => decodeURIComponent(path.split('?')[0].split('/')[n] ?? '');

export function EcrPages({ path }: { path: string }) {
  if (path.startsWith('/ecr/repo/')) return <EcrRepo key={path} name={seg(path, 3)} />;
  return <EcrRepos />;
}
export function EcsPages({ path }: { path: string }) {
  if (path.startsWith('/ecs/cluster/') && seg(path, 4) === 'service') return <EcsService key={path} cluster={seg(path, 3)} name={seg(path, 5)} />;
  if (path.startsWith('/ecs/cluster/')) return <EcsCluster key={path} name={seg(path, 3)} />;
  return <EcsClusters />;
}
export function EksPages({ path }: { path: string }) {
  if (path.startsWith('/eks/cluster/')) return <EksCluster key={path} name={seg(path, 3)} />;
  return <EksClusters />;
}
