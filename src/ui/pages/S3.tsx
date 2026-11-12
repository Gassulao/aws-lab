import React from 'react';
import './s3/s3.css';
import { S3Buckets } from './s3/Buckets';
import { CreateBucket } from './s3/CreateBucket';
import { BucketDetail } from './s3/BucketDetail';
import { ObjectDetail } from './s3/ObjectDetail';

export function S3Pages({ path }: { path: string }) {
  const clean = path.split('?')[0];
  const parts = clean.split('/');
  if (clean.startsWith('/s3/create')) return <CreateBucket />;
  if (clean.startsWith('/s3/bucket/')) {
    const name = decodeURIComponent(parts[3] ?? '');
    if (parts[4] === 'object') return <ObjectDetail key={clean + location.hash} bucket={name} objKey={decodeURIComponent(parts.slice(5).join('/'))} />;
    return <BucketDetail key={name} name={name} />;
  }
  return <S3Buckets />;
}
