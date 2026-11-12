import React from 'react';
import './cloudformation/cfn.css';
import { StacksList } from './cloudformation/Stacks';
import { CreateStack } from './cloudformation/Create';
import { StackDetail } from './cloudformation/Detail';

export function CloudFormationPages({ path }: { path: string }) {
  const clean = path.split('?')[0];
  if (clean.startsWith('/cloudformation/create')) return <CreateStack />;
  if (clean.startsWith('/cloudformation/stack/')) return <StackDetail key={clean} name={decodeURIComponent(clean.slice('/cloudformation/stack/'.length))} />;
  return <StacksList />;
}
