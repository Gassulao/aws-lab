import React, { useEffect, useState } from 'react';
import { Status, type Tone } from '../../components/ui';
import { settleCfn } from '../../../engine/services/cloudformation';
import { useCloud } from '../../session';

export const toneOf = (s: string): Tone => (/FAILED|ROLLBACK/.test(s) && !/ROLLBACK_COMPLETE$/.test(s) ? 'err' : /ROLLBACK_COMPLETE/.test(s) ? 'warn' : /IN_PROGRESS|PENDING/.test(s) ? 'load' : /COMPLETE/.test(s) && s !== 'DELETE_COMPLETE' ? 'ok' : s === 'DELETE_SKIPPED' ? 'warn' : '');
export const StackStatusBadge = ({ s }: { s: string }) => <Status tone={toneOf(s)}>{s}</Status>;

/** Estado de la nube con las transiciones de CloudFormation ya aplicadas; se refresca cada segundo. */
export function useCfn() {
  const s = useCloud();
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  settleCfn(s);
  return s;
}

export const SAMPLE = `AWSTemplateFormatVersion: '2010-09-09'
Description: Bucket de ejemplo con una salida
Parameters:
  Entorno:
    Type: String
    Default: dev
    AllowedValues: [dev, prod]
Resources:
  Datos:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub 'datos-\${AWS::AccountId}-\${Entorno}'
Outputs:
  Cubo:
    Value: !Ref Datos
`;
