import React from 'react';
import './cloudwatch/cw.css';
import { AlarmDetail, AlarmsList, CreateAlarm } from './cloudwatch/Alarms';
import { LogGroupDetail, LogGroups } from './cloudwatch/Logs';
import { MetricsPage } from './cloudwatch/Metrics';

export function CloudwatchPages({ path }: { path: string }) {
  const parts = path.split('?')[0].split('/').map((x) => decodeURIComponent(x));
  if (parts[2] === 'alarm-create') return <CreateAlarm />;
  if (parts[2] === 'alarm') return <AlarmDetail key={parts[3]} name={parts[3] ?? ''} />;
  if (parts[2] === 'logs') return <LogGroups />;
  if (parts[2] === 'log-group') return <LogGroupDetail key={parts[3] + '/' + parts[4]} name={parts[3] ?? ''} stream={parts[4]} />;
  if (parts[2] === 'metrics') return <MetricsPage />;
  return <AlarmsList />;
}
