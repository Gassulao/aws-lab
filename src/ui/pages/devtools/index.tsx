import React from 'react';
import './devtools.css';
import { Repos } from './Repos';
import { RepoDetail } from './RepoDetail';
import { Builds, BuildDetail } from './Builds';
import { Pipelines, PipelineDetail } from './Pipelines';
import { Deployments } from './Deployments';

export function DevtoolsPages({ path }: { path: string }) {
  const clean = path.split('?')[0];
  const rest = (p: string) => decodeURIComponent(clean.slice(p.length));
  if (clean.startsWith('/devtools/repo/')) return <RepoDetail key={clean} name={rest('/devtools/repo/')} />;
  if (clean.startsWith('/devtools/build/')) return <BuildDetail key={clean} id={rest('/devtools/build/')} />;
  if (clean.startsWith('/devtools/builds')) return <Builds />;
  if (clean.startsWith('/devtools/pipeline/')) return <PipelineDetail key={clean} name={rest('/devtools/pipeline/')} />;
  if (clean.startsWith('/devtools/pipelines')) return <Pipelines />;
  if (clean.startsWith('/devtools/deployments')) return <Deployments />;
  return <Repos />;
}
