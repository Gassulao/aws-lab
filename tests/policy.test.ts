import { describe, it, expect } from 'vitest';
import { evaluate, validatePolicyDocument, trustAllows, cidrContains } from '../src/engine/policy';
import type { PolicyDocument } from '../src/engine/types';

const allowS3Read: PolicyDocument = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: ['s3:GetObject', 's3:ListBucket'], Resource: ['arn:aws:s3:::datos', 'arn:aws:s3:::datos/*'] }],
};

describe('evaluación de políticas IAM', () => {
  it('permite lo que la política concede', () => {
    const r = evaluate({ action: 's3:GetObject', resource: 'arn:aws:s3:::datos/a.txt', identity: [allowS3Read] });
    expect(r.decision).toBe('Allow');
  });
  it('deniega implícitamente lo que no se concede', () => {
    const r = evaluate({ action: 's3:PutObject', resource: 'arn:aws:s3:::datos/a.txt', identity: [allowS3Read] });
    expect(r.decision).toBe('ImplicitDeny');
  });
  it('el Deny explícito gana siempre', () => {
    const deny: PolicyDocument = { Statement: [{ Effect: 'Deny', Action: 's3:*', Resource: '*' }] };
    const r = evaluate({ action: 's3:GetObject', resource: 'arn:aws:s3:::datos/a.txt', identity: [allowS3Read, deny] });
    expect(r.decision).toBe('ExplicitDeny');
  });
  it('NotAction permite todo salvo lo listado', () => {
    const doc: PolicyDocument = { Statement: [{ Effect: 'Allow', NotAction: 'iam:*', Resource: '*' }] };
    expect(evaluate({ action: 'ec2:RunInstances', resource: '*', identity: [doc] }).decision).toBe('Allow');
    expect(evaluate({ action: 'iam:CreateUser', resource: '*', identity: [doc] }).decision).toBe('ImplicitDeny');
  });
  it('el límite de permisos recorta los permisos de identidad', () => {
    const admin: PolicyDocument = { Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] };
    const boundary: PolicyDocument = { Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }] };
    expect(evaluate({ action: 's3:ListBucket', resource: '*', identity: [admin], boundary }).decision).toBe('Allow');
    expect(evaluate({ action: 'ec2:StopInstances', resource: '*', identity: [admin], boundary }).decision).toBe('ImplicitDeny');
  });
  it('las condiciones de MFA se evalúan', () => {
    const doc: PolicyDocument = {
      Statement: [{ Effect: 'Allow', Action: 'ec2:StopInstances', Resource: '*', Condition: { Bool: { 'aws:MultiFactorAuthPresent': 'true' } } }],
    };
    expect(evaluate({ action: 'ec2:StopInstances', resource: '*', identity: [doc], context: { 'aws:MultiFactorAuthPresent': 'false' } }).decision).toBe('ImplicitDeny');
    expect(evaluate({ action: 'ec2:StopInstances', resource: '*', identity: [doc], context: { 'aws:MultiFactorAuthPresent': 'true' } }).decision).toBe('Allow');
  });
  it('soporta variables de política como ${aws:username}', () => {
    const doc: PolicyDocument = { Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: 'arn:aws:s3:::casa/${aws:username}/*' }] };
    const ctx = { 'aws:username': 'ana' };
    expect(evaluate({ action: 's3:GetObject', resource: 'arn:aws:s3:::casa/ana/x', identity: [doc], context: ctx }).decision).toBe('Allow');
    expect(evaluate({ action: 's3:GetObject', resource: 'arn:aws:s3:::casa/luis/x', identity: [doc], context: ctx }).decision).toBe('ImplicitDeny');
  });
  it('una política de recurso que nombra al principal basta en la misma cuenta', () => {
    const bucketPolicy: PolicyDocument = {
      Statement: [{ Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::111122223333:user/ana' }, Action: 's3:GetObject', Resource: 'arn:aws:s3:::datos/*' }],
    };
    const r = evaluate({ action: 's3:GetObject', resource: 'arn:aws:s3:::datos/x', identity: [], resourcePolicy: bucketPolicy, principalArn: 'arn:aws:iam::111122223333:user/ana' });
    expect(r.decision).toBe('Allow');
  });
  it('entre cuentas hacen falta ambos permisos', () => {
    const bucketPolicy: PolicyDocument = { Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: '*' }] };
    const r = evaluate({ action: 's3:GetObject', resource: 'arn:aws:s3:::x/y', identity: [], resourcePolicy: bucketPolicy, principalArn: 'arn:aws:iam::999999999999:user/z', sameAccount: false });
    expect(r.decision).toBe('ImplicitDeny');
  });
  it('trustAllows reconoce principales de la cuenta', () => {
    const trust: PolicyDocument = { Statement: [{ Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::111122223333:root' }, Action: 'sts:AssumeRole' }] };
    expect(trustAllows(trust, 'arn:aws:iam::111122223333:user/ana', {})).toBe(true);
    expect(trustAllows(trust, 'arn:aws:iam::444455556666:user/ana', {})).toBe(false);
  });
  it('trustAllows respeta la condición de MFA', () => {
    const trust: PolicyDocument = {
      Statement: [{ Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::111122223333:root' }, Action: 'sts:AssumeRole', Condition: { Bool: { 'aws:MultiFactorAuthPresent': 'true' } } }],
    };
    const who = 'arn:aws:iam::111122223333:user/ana';
    expect(trustAllows(trust, who, { 'aws:MultiFactorAuthPresent': 'false' })).toBe(false);
    expect(trustAllows(trust, who, { 'aws:MultiFactorAuthPresent': 'true' })).toBe(true);
  });
});

describe('validación de documentos', () => {
  it('rechaza una política de identidad sin Resource', () => {
    expect(() => validatePolicyDocument({ Statement: [{ Effect: 'Allow', Action: 's3:*' }] })).toThrow(/resources/);
  });
  it('rechaza una trust policy sin Principal', () => {
    expect(() => validatePolicyDocument({ Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole' }] }, 'trust')).toThrow(/Principal/);
  });
  it('rechaza acciones sin servicio', () => {
    expect(() => validatePolicyDocument({ Statement: [{ Effect: 'Allow', Action: 'GetObject', Resource: '*' }] })).toThrow(/vendor/);
  });
});

describe('CIDR', () => {
  it('contiene', () => {
    expect(cidrContains('10.0.0.0/16', '10.0.5.9')).toBe(true);
    expect(cidrContains('10.0.0.0/16', '10.1.0.1')).toBe(false);
    expect(cidrContains('0.0.0.0/0', '8.8.8.8')).toBe(true);
  });
});
