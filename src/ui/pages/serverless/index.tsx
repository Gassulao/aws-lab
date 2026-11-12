import React from 'react';
import { LambdaList, LambdaCreate, LambdaDetail } from './Lambda';
import { SqsList, SqsDetail } from './Sqs';
import { ApiList, ApiDetail } from './ApiGw';
import { DdbList, DdbDetail } from './Dynamo';

const seg = (path: string, n: number) => decodeURIComponent(path.split('?')[0].split('/')[n] ?? '');

export function ServerlessPages({ svc, path }: { svc: string; path: string }) {
  if (svc === 'lambda') {
    if (path.startsWith('/lambda/function/')) return <LambdaDetail key={path} name={seg(path, 3)} />;
    if (path === '/lambda/create') return <LambdaCreate />;
    return <LambdaList />;
  }
  if (svc === 'sqs') return path.startsWith('/sqs/queue/') ? <SqsDetail key={path} name={seg(path, 3)} /> : <SqsList />;
  if (svc === 'apigateway') return path.startsWith('/apigateway/api/') ? <ApiDetail key={path} kind={seg(path, 3)} id={seg(path, 4)} /> : <ApiList />;
  return path.startsWith('/dynamodb/table/') ? <DdbDetail key={path} name={seg(path, 3)} /> : <DdbList />;
}
