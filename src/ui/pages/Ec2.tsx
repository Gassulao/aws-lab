import React from 'react';
import './ec2/ec2.css';
import { Instances, Detail, Connect } from './ec2/Instances';
import { Launch, Launched } from './ec2/Launch';
import { Dashboard, SecurityGroups, SgDetail, Keys } from './ec2/Network';
import { LoadBalancers, LbDetail, TargetGroups, TgDetail, LaunchTemplates, Asgs, AsgDetail } from './ec2/Ha';
export { InstState } from './ec2/common';

export function Ec2Pages({ path }: { path: string }) {
  const p = path.split('?')[0];
  const seg = p.split('/');
  if (p.startsWith('/ec2/launch/done/')) return <Launched ids={seg[4] ?? ''} />;
  if (p.startsWith('/ec2/launch')) return <Launch />;
  if (p.startsWith('/ec2/lb/')) return <LbDetail key={seg[3]} name={seg[3]} />;
  if (p.startsWith('/ec2/lbs')) return <LoadBalancers />;
  if (p.startsWith('/ec2/tg/')) return <TgDetail key={seg[3]} name={seg[3]} />;
  if (p.startsWith('/ec2/tgs')) return <TargetGroups />;
  if (p.startsWith('/ec2/lts')) return <LaunchTemplates />;
  if (p.startsWith('/ec2/asg/')) return <AsgDetail key={seg[3]} name={seg[3]} />;
  if (p.startsWith('/ec2/asgs')) return <Asgs />;
  if (p.startsWith('/ec2/sg/')) return <SgDetail key={seg[3]} id={seg[3]} />;
  if (p.startsWith('/ec2/sg')) return <SecurityGroups />;
  if (p.startsWith('/ec2/keys')) return <Keys />;
  if (p.startsWith('/ec2/instance/') && seg[4] === 'connect') return <Connect key={seg[3]} id={seg[3]} />;
  if (p.startsWith('/ec2/instance/')) return <Detail key={seg[3]} id={seg[3]} />;
  if (p === '/ec2') return <Dashboard />;
  return <Instances />;
}
