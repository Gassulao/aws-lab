// AWS KMS: claves administradas por el cliente y por AWS, alias, rotación, políticas de clave, grants y un
// cifrado SIMULADO y reversible (no es criptografía real: solo garantiza que únicamente la clave correcta descifra).
import type { KmsAlias, KmsGrant, KmsKey, PolicyDocument, PolicyStatement, Tags } from '../types';
import { AwsError } from '../errors';
import { trailed, identityPolicies, requestContext, getRole, type Ctx } from '../api';
import { evaluate, statements, validatePolicyDocument } from '../policy';
import { ids } from '../ids';
import { nowIso, now, guid, hex, wildcardMatch } from '../util';
import { fakeSignature } from './s3Extra';
import { setKmsLookup } from './kmsLookup';

const SRC = 'kms.amazonaws.com';
const DAY = 86_400_000;

export const keyArn = (ctx: Ctx, id: string) => `arn:aws:kms:${ctx.region}:${ctx.s.account.id}:key/${id}`;
const aliasArn = (ctx: Ctx, name: string) => `arn:aws:kms:${ctx.region}:${ctx.s.account.id}:${name}`;
const asArr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// ------------------------------------------------------------------ ciclo de vida de la eliminación

/** Elimina las claves cuya ventana de eliminación ha vencido (usa el reloj inyectable). */
export function settleKms(s: Ctx['s']) {
  const t = now();
  const gone = s.kmsKeys.filter((k) => k.state === 'PendingDeletion' && k.deletionDate && new Date(k.deletionDate).getTime() <= t);
  if (!gone.length) return;
  s.kmsKeys = s.kmsKeys.filter((k) => !gone.includes(k));
  s.kmsAliases = s.kmsAliases.filter((a) => !gone.some((k) => k.id === a.keyId && k.region === a.region));
}

// ------------------------------------------------------------------ resolución de claves

export function defaultKeyPolicy(account: string): PolicyDocument {
  return {
    Version: '2012-10-17',
    Id: 'key-default-1',
    Statement: [{ Sid: 'Enable IAM User Permissions', Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${account}:root` }, Action: 'kms:*', Resource: '*' }],
  } as PolicyDocument;
}

function notFoundKey(ctx: Ctx, id: string): AwsError {
  return new AwsError('NotFoundException', `Key '${id.startsWith('arn:') ? id : keyArn(ctx, id)}' does not exist`, 400);
}

/** Resuelve id, ARN, alias/nombre o ARN de alias. Lanza NotFoundException como KMS. */
export function resolveKey(ctx: Ctx, ref: string): KmsKey {
  settleKms(ctx.s);
  let id = ref;
  if (ref.startsWith('arn:')) {
    const m = /^arn:aws:kms:([^:]*):(\d{12}):(key|alias)\/(.+)$/.exec(ref);
    if (!m) throw new AwsError('InvalidArnException', `${ref} is not a valid arn`, 400);
    if (m[1] !== ctx.region) throw notFoundKey(ctx, ref);
    id = m[3] === 'alias' ? `alias/${m[4]}` : m[4];
  }
  if (id.startsWith('alias/')) {
    const m = /^alias\/aws\/(s3|secretsmanager|ebs|rds)$/.exec(id);
    if (m) awsManagedKey(ctx, m[1] as 's3'); // las claves de AWS se crean la primera vez que se nombran
    const a = ctx.s.kmsAliases.find((x) => x.name === id && x.region === ctx.region);
    if (!a) throw new AwsError('NotFoundException', `Alias ${aliasArn(ctx, id)} is not found.`, 400);
    id = a.keyId;
  }
  const k = ctx.s.kmsKeys.find((x) => x.id === id && x.region === ctx.region);
  if (!k) throw notFoundKey(ctx, ref);
  return k;
}

export function getKmsKeyOrNullImpl(ctx: Ctx, ref: string): { keyId: string; arn: string } | null {
  try {
    const k = resolveKey(ctx, ref);
    return { keyId: k.id, arn: k.arn };
  } catch {
    return null;
  }
}
setKmsLookup(getKmsKeyOrNullImpl);

/** Clave administrada por AWS (aws/s3, aws/secretsmanager...). Se crea la primera vez que se usa, como en AWS. */
export function awsManagedKey(ctx: Ctx, svc: 's3' | 'secretsmanager' | 'ebs' | 'rds'): KmsKey {
  const name = `aws/${svc}`;
  let k = ctx.s.kmsKeys.find((x) => x.awsAlias === name && x.region === ctx.region);
  if (k) return k;
  const id = guid();
  const desc: Record<string, string> = { s3: 'Default key that protects my S3 objects when no other key is defined', secretsmanager: 'Default key that protects my Secrets Manager data when no other key is defined', ebs: 'Default key that protects my EBS volumes when no other key is defined', rds: 'Default key that protects my RDS database volumes when no other key is defined' };
  k = {
    id, arn: keyArn(ctx, id), region: ctx.region, description: desc[svc], manager: 'AWS', awsAlias: name, state: 'Enabled', usage: 'ENCRYPT_DECRYPT', spec: 'SYMMETRIC_DEFAULT',
    createdAt: nowIso(), rotation: true, rotationDays: 365, grants: [], tags: {}, material: hex(32),
    policy: {
      Version: '2012-10-17', Id: `auto-${svc}`,
      Statement: [{ Sid: 'Allow access through service for all principals in the account that are authorized to use the service', Effect: 'Allow', Principal: { AWS: '*' }, Action: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:CreateGrant', 'kms:DescribeKey'], Resource: '*', Condition: { StringEquals: { 'kms:CallerAccount': ctx.s.account.id, 'kms:ViaService': `${svc}.${ctx.region}.amazonaws.com` } } }],
    } as PolicyDocument,
  };
  ctx.s.kmsKeys.push(k);
  ctx.s.kmsAliases.push({ name: `alias/${name}`, keyId: id, region: ctx.region, createdAt: nowIso(), updatedAt: nowIso() });
  return k;
}

// ------------------------------------------------------------------ autorización (política de clave + IAM + grants)

function principalOf(ctx: Ctx): string {
  const c = ctx.caller;
  if (c.type === 'AssumedRole') return getRole(ctx.s, c.roleName!)?.arn ?? c.arn;
  return c.arn;
}

const principalsOf = (st: PolicyStatement): string[] => {
  if (st.Principal === '*') return ['*'];
  return Object.values<any>(st.Principal ?? {}).flatMap((v) => asArr<string>(v));
};

function opName(action: string) {
  return action.replace(/^kms:/, '');
}

export interface KmsAuthOpts {
  via?: string;
}

/** Devuelve null si está permitido, o el motivo de la denegación (texto de AWS tras "because"/"with"). */
export function kmsDenial(ctx: Ctx, key: KmsKey, action: string, opts: KmsAuthOpts = {}): string | null {
  if (ctx.caller.type === 'Root') return null;
  const acct = ctx.s.account.id;
  const principal = principalOf(ctx);
  const context = requestContext(ctx.caller, { 'kms:CallerAccount': acct, ...(opts.via ? { 'kms:ViaService': opts.via } : {}) });
  const { docs, boundary, session, scp } = identityPolicies(ctx.s, ctx.caller);
  const stmts = statements(key.policy);
  const isRoot = (x: string) => x === `arn:aws:iam::${acct}:root` || x === acct;
  const denies = stmts.filter((s) => s.Effect === 'Deny');
  const mk = (list: PolicyStatement[]): PolicyDocument => ({ Version: '2012-10-17', Statement: list });

  // 1. Denegaciones explícitas en identidad o en la política de clave.
  const first = evaluate({ action, resource: key.arn, identity: docs, boundary, session, scp, principalArn: principal, context });
  if (first.decision === 'ExplicitDeny') return first.via === 'scp' ? 'with an explicit deny in a service control policy' : 'with an explicit deny in an identity-based policy';
  if (denies.length && evaluate({ action, resource: key.arn, identity: [], resourcePolicy: mk(denies), principalArn: principal, context }).decision === 'ExplicitDeny') return 'with an explicit deny in a resource-based policy';

  // 2. La política de clave nombra al principal (o a todos con '*').
  const direct = stmts.filter((s) => s.Effect === 'Allow' && principalsOf(s).some((p) => p === '*' || p === principal || p === ctx.caller.arn));
  if (direct.length && evaluate({ action, resource: key.arn, identity: [], resourcePolicy: mk(direct), principalArn: principal, context }).decision === 'Allow') return null;

  // 3. Grants.
  const op = opName(action);
  const g = key.grants.find((x) => (x.granteePrincipal === principal || x.granteePrincipal === ctx.caller.arn) && x.operations.some((o) => o === op || (o === 'ReEncryptFrom' && op === 'ReEncryptFrom') || (o === 'GenerateDataKey' && op === 'GenerateDataKeyWithoutPlaintext')));
  if (g) return null;

  // 4. La política de clave delega en IAM (statement para la raíz) y IAM lo permite.
  const rootStmts = stmts.filter((s) => s.Effect === 'Allow' && principalsOf(s).some(isRoot));
  const delegates = rootStmts.length > 0 && evaluate({ action, resource: key.arn, identity: [], resourcePolicy: mk(rootStmts), principalArn: `arn:aws:iam::${acct}:root`, context }).decision === 'Allow';
  if (delegates) {
    if (evaluate({ action, resource: key.arn, identity: docs, boundary, session, scp, principalArn: principal, context }).decision === 'Allow') return null;
    return `because no identity-based policy allows the ${action} action`;
  }
  return `because no resource-based policy allows the ${action} action`;
}

export function kmsAuthorize(ctx: Ctx, key: KmsKey, action: string, opts: KmsAuthOpts = {}): void {
  const why = kmsDenial(ctx, key, action, opts);
  if (why) throw new AwsError('AccessDeniedException', `User: ${ctx.caller.arn} is not authorized to perform: ${action} on resource: ${key.arn} ${why}`, 400);
}

function stateCheck(key: KmsKey, allowDisabled = false) {
  if (key.state === 'PendingDeletion') throw new AwsError('KMSInvalidStateException', `${key.arn} is pending deletion.`, 400);
  if (key.state === 'Disabled' && !allowDisabled) throw new AwsError('DisabledException', `${key.arn} is disabled.`, 400);
}

// ------------------------------------------------------------------ administración de claves

function validTags(tags?: { TagKey: string; TagValue: string }[]): Tags {
  const out: Tags = {};
  for (const t of tags ?? []) {
    if (!t.TagKey) throw new AwsError('ValidationException', "1 validation error detected: Value '' at 'tags.1.member.tagKey' failed to satisfy constraint: Member must have length greater than or equal to 1");
    out[t.TagKey] = t.TagValue ?? '';
  }
  return out;
}

function lockoutSafe(ctx: Ctx, doc: PolicyDocument): boolean {
  const acct = ctx.s.account.id;
  const me = principalOf(ctx);
  return statements(doc).some((s) => {
    if (s.Effect !== 'Allow') return false;
    const acts = asArr(s.Action).map((a) => a.toLowerCase());
    if (!acts.some((a) => wildcardMatch(a, 'kms:putkeypolicy'))) return false;
    return principalsOf(s).some((p) => p === '*' || p === me || p === ctx.caller.arn || p === `arn:aws:iam::${acct}:root` || p === acct);
  });
}

function parsePolicy(ctx: Ctx, policy: string | PolicyDocument, bypass?: boolean): PolicyDocument {
  let obj: any = policy;
  if (typeof policy === 'string') {
    try {
      obj = JSON.parse(policy);
    } catch {
      throw new AwsError('MalformedPolicyDocumentException', 'Syntax errors in policy.', 400);
    }
  }
  let doc: PolicyDocument;
  try {
    doc = validatePolicyDocument(obj, 'resource');
  } catch (e) {
    throw new AwsError('MalformedPolicyDocumentException', (e as Error).message, 400);
  }
  if (!bypass && !lockoutSafe(ctx, doc)) throw new AwsError('MalformedPolicyDocumentException', 'The new key policy will not allow you to update the key policy in the future.', 400);
  return doc;
}

export function createKey(ctx: Ctx, p: { Description?: string; Policy?: string | PolicyDocument; Tags?: { TagKey: string; TagValue: string }[]; KeyUsage?: string; KeySpec?: string; BypassPolicyLockoutSafetyCheck?: boolean }): KmsKey {
  return trailed(ctx, SRC, 'CreateKey', [], { Description: p.Description }, () => {
    settleKms(ctx.s);
    const id = guid();
    const res = `arn:aws:kms:${ctx.region}:${ctx.s.account.id}:key/${id}`;
    // Se autoriza antes con la identidad (la clave aún no existe, no hay política de clave).
    const { docs, boundary, session } = identityPolicies(ctx.s, ctx.caller);
    if (ctx.caller.type !== 'Root' && evaluate({ action: 'kms:CreateKey', resource: '*', identity: docs, boundary, session, principalArn: ctx.caller.arn, context: requestContext(ctx.caller) }).decision !== 'Allow') {
      throw new AwsError('AccessDeniedException', `User: ${ctx.caller.arn} is not authorized to perform: kms:CreateKey on resource: * because no identity-based policy allows the kms:CreateKey action`, 400);
    }
    if (p.KeyUsage && p.KeyUsage !== 'ENCRYPT_DECRYPT') throw new AwsError('UnsupportedOperationException', 'Este simulador solo admite claves simétricas ENCRYPT_DECRYPT.', 400);
    if (p.KeySpec && p.KeySpec !== 'SYMMETRIC_DEFAULT') throw new AwsError('UnsupportedOperationException', 'Este simulador solo admite KeySpec SYMMETRIC_DEFAULT.', 400);
    const policy = p.Policy ? parsePolicy(ctx, p.Policy, p.BypassPolicyLockoutSafetyCheck) : defaultKeyPolicy(ctx.s.account.id);
    const k: KmsKey = {
      id, arn: res, region: ctx.region, description: p.Description ?? '', manager: 'CUSTOMER', state: 'Enabled', usage: 'ENCRYPT_DECRYPT', spec: 'SYMMETRIC_DEFAULT',
      createdAt: nowIso(), policy, rotation: false, rotationDays: 365, grants: [], tags: validTags(p.Tags), material: hex(32),
    };
    ctx.s.kmsKeys.push(k);
    return k;
  });
}

export function describeKey(ctx: Ctx, p: { KeyId: string }): KmsKey {
  return trailed(ctx, SRC, 'DescribeKey', [], p, () => {
    const k = resolveKey(ctx, p.KeyId);
    if (k.manager === 'AWS') return k;
    kmsAuthorize(ctx, k, 'kms:DescribeKey');
    return k;
  });
}

function listAuth(ctx: Ctx, action: string) {
  const { docs, boundary, session } = identityPolicies(ctx.s, ctx.caller);
  if (ctx.caller.type !== 'Root' && evaluate({ action, resource: '*', identity: docs, boundary, session, principalArn: ctx.caller.arn, context: requestContext(ctx.caller) }).decision !== 'Allow') {
    throw new AwsError('AccessDeniedException', `User: ${ctx.caller.arn} is not authorized to perform: ${action} on resource: * because no identity-based policy allows the ${action} action`, 400);
  }
}

export function listKeys(ctx: Ctx): KmsKey[] {
  return trailed(ctx, SRC, 'ListKeys', [], {}, () => {
    settleKms(ctx.s);
    listAuth(ctx, 'kms:ListKeys');
    return ctx.s.kmsKeys.filter((k) => k.region === ctx.region);
  });
}

export function listAliases(ctx: Ctx, p: { KeyId?: string } = {}): KmsAlias[] {
  return trailed(ctx, SRC, 'ListAliases', [], p, () => {
    settleKms(ctx.s);
    listAuth(ctx, 'kms:ListAliases');
    const k = p.KeyId ? resolveKey(ctx, p.KeyId) : null;
    return ctx.s.kmsAliases.filter((a) => a.region === ctx.region && (!k || a.keyId === k.id));
  });
}

function checkAliasName(ctx: Ctx, name: string) {
  if (!name.startsWith('alias/')) throw new AwsError('InvalidAliasNameException', `Alias must start with the prefix "alias/". Please see https://docs.aws.amazon.com/kms/latest/developerguide/kms-alias.html`, 400);
  if (name.startsWith('alias/aws/')) throw new AwsError('InvalidAliasNameException', `Alias ${aliasArn(ctx, name)} is reserved for Amazon Web Services managed keys`, 400);
  if (!/^alias\/[a-zA-Z0-9/_-]{1,250}$/.test(name)) throw new AwsError('ValidationException', `1 validation error detected: Value '${name}' at 'aliasName' failed to satisfy constraint: Member must satisfy regular expression pattern: ^alias/[a-zA-Z0-9/_-]+$`, 400);
}

export function createAlias(ctx: Ctx, p: { AliasName: string; TargetKeyId: string }): void {
  trailed(ctx, SRC, 'CreateAlias', [], p, () => {
    checkAliasName(ctx, p.AliasName);
    const k = resolveKey(ctx, p.TargetKeyId);
    kmsAuthorize(ctx, k, 'kms:CreateAlias');
    if (ctx.s.kmsAliases.some((a) => a.name === p.AliasName && a.region === ctx.region)) throw new AwsError('AlreadyExistsException', `An alias with the name ${aliasArn(ctx, p.AliasName)} already exists`, 400);
    stateCheck(k, true);
    ctx.s.kmsAliases.push({ name: p.AliasName, keyId: k.id, region: ctx.region, createdAt: nowIso(), updatedAt: nowIso() });
  });
}
export function updateAlias(ctx: Ctx, p: { AliasName: string; TargetKeyId: string }): void {
  trailed(ctx, SRC, 'UpdateAlias', [], p, () => {
    const a = ctx.s.kmsAliases.find((x) => x.name === p.AliasName && x.region === ctx.region);
    if (!a) throw new AwsError('NotFoundException', `Alias ${aliasArn(ctx, p.AliasName)} is not found.`, 400);
    const k = resolveKey(ctx, p.TargetKeyId);
    kmsAuthorize(ctx, k, 'kms:UpdateAlias');
    a.keyId = k.id;
    a.updatedAt = nowIso();
  });
}
export function deleteAlias(ctx: Ctx, p: { AliasName: string }): void {
  trailed(ctx, SRC, 'DeleteAlias', [], p, () => {
    if (p.AliasName.startsWith('alias/aws/')) throw new AwsError('NotAuthorizedException', 'Aliases of managed keys cannot be deleted.', 400);
    const a = ctx.s.kmsAliases.find((x) => x.name === p.AliasName && x.region === ctx.region);
    if (!a) throw new AwsError('NotFoundException', `Alias ${aliasArn(ctx, p.AliasName)} is not found.`, 400);
    const k = ctx.s.kmsKeys.find((x) => x.id === a.keyId);
    if (k) kmsAuthorize(ctx, k, 'kms:DeleteAlias');
    ctx.s.kmsAliases = ctx.s.kmsAliases.filter((x) => x !== a);
  });
}

export function setKeyEnabled(ctx: Ctx, p: { KeyId: string }, enable: boolean): void {
  trailed(ctx, SRC, enable ? 'EnableKey' : 'DisableKey', [], p, () => {
    const k = resolveKey(ctx, p.KeyId);
    kmsAuthorize(ctx, k, enable ? 'kms:EnableKey' : 'kms:DisableKey');
    if (k.manager === 'AWS') throw new AwsError('AccessDeniedException', `${k.arn} is an AWS managed key and cannot be modified.`, 400);
    stateCheck(k, true);
    k.state = enable ? 'Enabled' : 'Disabled';
  });
}

export function scheduleKeyDeletion(ctx: Ctx, p: { KeyId: string; PendingWindowInDays?: number }) {
  return trailed(ctx, SRC, 'ScheduleKeyDeletion', [], p, () => {
    const k = resolveKey(ctx, p.KeyId);
    kmsAuthorize(ctx, k, 'kms:ScheduleKeyDeletion');
    const days = p.PendingWindowInDays ?? 30;
    if (days < 7) throw new AwsError('ValidationException', `1 validation error detected: Value '${days}' at 'pendingWindowInDays' failed to satisfy constraint: Member must have value greater than or equal to 7`, 400);
    if (days > 30) throw new AwsError('ValidationException', `1 validation error detected: Value '${days}' at 'pendingWindowInDays' failed to satisfy constraint: Member must have value less than or equal to 30`, 400);
    if (k.manager === 'AWS') throw new AwsError('AccessDeniedException', `${k.arn} is an AWS managed key and cannot be modified.`, 400);
    if (k.state === 'PendingDeletion') throw new AwsError('KMSInvalidStateException', `${k.arn} is pending deletion.`, 400);
    k.state = 'PendingDeletion';
    k.pendingWindowDays = days;
    k.deletionDate = new Date(now() + days * DAY).toISOString();
    return { KeyId: k.arn, DeletionDate: k.deletionDate, KeyState: 'PendingDeletion', PendingWindowInDays: days };
  });
}

export function cancelKeyDeletion(ctx: Ctx, p: { KeyId: string }): string {
  return trailed(ctx, SRC, 'CancelKeyDeletion', [], p, () => {
    const k = resolveKey(ctx, p.KeyId);
    kmsAuthorize(ctx, k, 'kms:CancelKeyDeletion');
    if (k.state !== 'PendingDeletion') throw new AwsError('KMSInvalidStateException', `${k.arn} is not pending deletion.`, 400);
    k.state = 'Disabled'; // igual que en AWS: tras cancelar queda deshabilitada
    delete k.deletionDate;
    delete k.pendingWindowDays;
    return k.arn;
  });
}

export function setRotation(ctx: Ctx, p: { KeyId: string; RotationPeriodInDays?: number }, enable: boolean): void {
  trailed(ctx, SRC, enable ? 'EnableKeyRotation' : 'DisableKeyRotation', [], p, () => {
    const k = resolveKey(ctx, p.KeyId);
    kmsAuthorize(ctx, k, enable ? 'kms:EnableKeyRotation' : 'kms:DisableKeyRotation');
    if (k.manager === 'AWS') throw new AwsError('UnsupportedOperationException', `${k.arn} is managed by AWS and rotation cannot be changed.`, 400);
    stateCheck(k, enable ? false : true);
    if (enable) {
      const d = p.RotationPeriodInDays ?? 365;
      if (d < 90 || d > 2560) throw new AwsError('ValidationException', `1 validation error detected: Value '${d}' at 'rotationPeriodInDays' failed to satisfy constraint: Member must have value ${d < 90 ? 'greater' : 'less'} than or equal to ${d < 90 ? 90 : 2560}`, 400);
      k.rotation = true;
      k.rotationDays = d;
      k.rotationEnabledAt = nowIso();
    } else k.rotation = false;
  });
}

export function getRotationStatus(ctx: Ctx, p: { KeyId: string }) {
  return trailed(ctx, SRC, 'GetKeyRotationStatus', [], p, () => {
    const k = resolveKey(ctx, p.KeyId);
    kmsAuthorize(ctx, k, 'kms:GetKeyRotationStatus');
    const next = k.rotation ? new Date(new Date(k.rotationEnabledAt ?? k.createdAt).getTime() + k.rotationDays * DAY).toISOString() : undefined;
    return { KeyRotationEnabled: k.rotation, KeyId: k.id, RotationPeriodInDays: k.rotation ? k.rotationDays : undefined, NextRotationDate: next };
  });
}

export function getKeyPolicy(ctx: Ctx, p: { KeyId: string; PolicyName?: string }): PolicyDocument {
  return trailed(ctx, SRC, 'GetKeyPolicy', [], p, () => {
    const k = resolveKey(ctx, p.KeyId);
    kmsAuthorize(ctx, k, 'kms:GetKeyPolicy');
    if (p.PolicyName && p.PolicyName !== 'default') throw new AwsError('NotFoundException', 'No such policy exists. The only valid policy name is default.', 400);
    return k.policy;
  });
}
export function putKeyPolicy(ctx: Ctx, p: { KeyId: string; PolicyName?: string; Policy: string | PolicyDocument; BypassPolicyLockoutSafetyCheck?: boolean }): void {
  trailed(ctx, SRC, 'PutKeyPolicy', [], { KeyId: p.KeyId, PolicyName: p.PolicyName }, () => {
    const k = resolveKey(ctx, p.KeyId);
    kmsAuthorize(ctx, k, 'kms:PutKeyPolicy');
    if (p.PolicyName && p.PolicyName !== 'default') throw new AwsError('NotFoundException', 'No such policy exists. The only valid policy name is default.', 400);
    stateCheck(k, true);
    k.policy = parsePolicy(ctx, p.Policy, p.BypassPolicyLockoutSafetyCheck);
  });
}

export function tagResource(ctx: Ctx, p: { KeyId: string; Tags: { TagKey: string; TagValue: string }[] }): void {
  trailed(ctx, SRC, 'TagResource', [], p, () => {
    const k = resolveKey(ctx, p.KeyId);
    kmsAuthorize(ctx, k, 'kms:TagResource');
    Object.assign(k.tags, validTags(p.Tags));
  });
}
export function untagResource(ctx: Ctx, p: { KeyId: string; TagKeys: string[] }): void {
  trailed(ctx, SRC, 'UntagResource', [], p, () => {
    const k = resolveKey(ctx, p.KeyId);
    kmsAuthorize(ctx, k, 'kms:UntagResource');
    p.TagKeys.forEach((t) => delete k.tags[t]);
  });
}
export function listResourceTags(ctx: Ctx, p: { KeyId: string }): Tags {
  return trailed(ctx, SRC, 'ListResourceTags', [], p, () => {
    const k = resolveKey(ctx, p.KeyId);
    kmsAuthorize(ctx, k, 'kms:ListResourceTags');
    return k.tags;
  });
}

// ------------------------------------------------------------------ grants

const GRANT_OPS = ['Decrypt', 'Encrypt', 'GenerateDataKey', 'GenerateDataKeyWithoutPlaintext', 'ReEncryptFrom', 'ReEncryptTo', 'Sign', 'Verify', 'GetPublicKey', 'CreateGrant', 'RetireGrant', 'DescribeKey', 'GenerateDataKeyPair', 'GenerateDataKeyPairWithoutPlaintext', 'GenerateMac', 'VerifyMac'];
export function createGrant(ctx: Ctx, p: { KeyId: string; GranteePrincipal: string; Operations: string[]; RetiringPrincipal?: string; Name?: string }) {
  return trailed(ctx, SRC, 'CreateGrant', [], p, () => {
    const k = resolveKey(ctx, p.KeyId);
    kmsAuthorize(ctx, k, 'kms:CreateGrant');
    stateCheck(k);
    const bad = p.Operations.find((o) => !GRANT_OPS.includes(o));
    if (bad) throw new AwsError('ValidationException', `1 validation error detected: Value '[${bad}]' at 'operations' failed to satisfy constraint: Member must satisfy constraint: [Member must satisfy enum value set: [${GRANT_OPS.join(', ')}]]`, 400);
    if (!/^arn:aws:iam::\d{12}:(user|role|root)/.test(p.GranteePrincipal) && !/^arn:aws:sts::/.test(p.GranteePrincipal)) throw new AwsError('InvalidGrantTokenException', `Invalid grantee principal ${p.GranteePrincipal}`, 400);
    if (p.Name && k.grants.some((g) => g.name === p.Name)) {
      const g = k.grants.find((x) => x.name === p.Name)!;
      return g;
    }
    const g: KmsGrant = { id: hex(64), token: `AQpA${hex(60)}`, name: p.Name, granteePrincipal: p.GranteePrincipal, retiringPrincipal: p.RetiringPrincipal, operations: p.Operations, createdAt: nowIso() };
    k.grants.push(g);
    return g;
  });
}
export function listGrants(ctx: Ctx, p: { KeyId: string }) {
  return trailed(ctx, SRC, 'ListGrants', [], p, () => {
    const k = resolveKey(ctx, p.KeyId);
    kmsAuthorize(ctx, k, 'kms:ListGrants');
    return { key: k, grants: k.grants };
  });
}
export function revokeGrant(ctx: Ctx, p: { KeyId: string; GrantId: string }, retire = false): void {
  trailed(ctx, SRC, retire ? 'RetireGrant' : 'RevokeGrant', [], p, () => {
    const k = resolveKey(ctx, p.KeyId);
    kmsAuthorize(ctx, k, retire ? 'kms:RetireGrant' : 'kms:RevokeGrant');
    if (!k.grants.some((g) => g.id === p.GrantId)) throw new AwsError('NotFoundException', `Grant ID ${p.GrantId} not found`, 400);
    k.grants = k.grants.filter((g) => g.id !== p.GrantId);
  });
}

// ------------------------------------------------------------------ cifrado simulado

const MAGIC = 'KMSLAB1';
const b64 = (bytes: Uint8Array) => {
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s);
};
const unb64 = (s: string): Uint8Array => {
  let bin: string;
  try {
    bin = atob(s);
  } catch {
    throw new AwsError('InvalidCiphertextException', '', 400);
  }
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

function keystream(material: string, ctxHash: string, n: number): Uint8Array {
  const out = new Uint8Array(n);
  let block = '';
  let i = 0;
  while (i < n) {
    block = fakeSignature(`${material}|${ctxHash}|${i}|${block}`);
    for (let j = 0; j + 1 < block.length && i < n; j += 2) out[i++] = parseInt(block.slice(j, j + 2), 16);
  }
  return out;
}

const ctxHash = (c?: Record<string, string>) => fakeSignature(JSON.stringify(Object.entries(c ?? {}).sort())).slice(0, 16);

/** Cifra bytes con la clave dada. Formato del blob: MAGIC | keyId(36) | hashContexto(16) | datos. */
export function sealBytes(k: KmsKey, plain: Uint8Array, context?: Record<string, string>): string {
  const h = ctxHash(context);
  const ks = keystream(k.material, h, plain.length);
  const body = plain.map((b, i) => b ^ ks[i]);
  // El blob es texto ASCII (cuerpo en hexadecimal) para que sobreviva a tuberías y ficheros de la terminal.
  const hexBody = Array.from(body, (b) => b.toString(16).padStart(2, '0')).join('');
  return b64(new TextEncoder().encode(MAGIC + k.id + h + hexBody));
}

export function blobKeyId(blob: string): string {
  const bytes = unb64(blob);
  const head = new TextDecoder().decode(bytes.slice(0, MAGIC.length + 36 + 16));
  if (!head.startsWith(MAGIC) || bytes.length < MAGIC.length + 36 + 16) throw new AwsError('InvalidCiphertextException', '', 400);
  return head.slice(MAGIC.length, MAGIC.length + 36);
}

export function openBytes(k: KmsKey, blob: string, context?: Record<string, string>): Uint8Array {
  const bytes = unb64(blob);
  const hl = MAGIC.length + 36 + 16;
  if (bytes.length < hl) throw new AwsError('InvalidCiphertextException', '', 400);
  const head = new TextDecoder().decode(bytes.slice(0, hl));
  if (!head.startsWith(MAGIC)) throw new AwsError('InvalidCiphertextException', '', 400);
  const h = head.slice(MAGIC.length + 36);
  if (h !== ctxHash(context)) throw new AwsError('InvalidCiphertextException', '', 400);
  const hexBody = new TextDecoder().decode(bytes.slice(hl));
  if (!/^([0-9a-f]{2})*$/.test(hexBody)) throw new AwsError('InvalidCiphertextException', '', 400);
  const body = Uint8Array.from(hexBody.match(/../g) ?? [], (x) => parseInt(x, 16));
  const ks = keystream(k.material, h, body.length);
  return body.map((b, i) => b ^ ks[i]);
}

const toBytes = (b64s: string): Uint8Array => unb64(b64s);

function usable(ctx: Ctx, ref: string, action: string, opts: KmsAuthOpts = {}): KmsKey {
  const k = resolveKey(ctx, ref);
  kmsAuthorize(ctx, k, action, opts);
  stateCheck(k);
  return k;
}

export function encrypt(ctx: Ctx, p: { KeyId: string; Plaintext: string; EncryptionContext?: Record<string, string> }) {
  return trailed(ctx, SRC, 'Encrypt', [{ type: 'AWS::KMS::Key', name: p.KeyId }], { KeyId: p.KeyId, EncryptionContext: p.EncryptionContext }, () => {
    const k = usable(ctx, p.KeyId, 'kms:Encrypt');
    const bytes = toBytes(p.Plaintext);
    if (bytes.length === 0) throw new AwsError('ValidationException', "1 validation error detected: Value at 'plaintext' failed to satisfy constraint: Member must have length greater than or equal to 1", 400);
    if (bytes.length > 4096) throw new AwsError('ValidationException', "1 validation error detected: Value at 'plaintext' failed to satisfy constraint: Member must have length less than or equal to 4096", 400);
    return { CiphertextBlob: sealBytes(k, bytes, p.EncryptionContext), KeyId: k.arn, EncryptionAlgorithm: 'SYMMETRIC_DEFAULT' };
  });
}

export function decrypt(ctx: Ctx, p: { CiphertextBlob: string; KeyId?: string; EncryptionContext?: Record<string, string> }) {
  return trailed(ctx, SRC, 'Decrypt', [], { KeyId: p.KeyId, EncryptionContext: p.EncryptionContext }, () => {
    settleKms(ctx.s);
    const id = blobKeyId(p.CiphertextBlob);
    const k = ctx.s.kmsKeys.find((x) => x.id === id && x.region === ctx.region);
    if (!k) throw new AwsError('NotFoundException', `Key '${keyArn(ctx, id)}' does not exist`, 400);
    if (p.KeyId) {
      const want = resolveKey(ctx, p.KeyId);
      if (want.id !== k.id) throw new AwsError('IncorrectKeyException', 'The key ID in the request does not identify a CMK that can perform this operation.', 400);
    }
    kmsAuthorize(ctx, k, 'kms:Decrypt');
    stateCheck(k);
    return { KeyId: k.arn, Plaintext: b64(openBytes(k, p.CiphertextBlob, p.EncryptionContext)), EncryptionAlgorithm: 'SYMMETRIC_DEFAULT' };
  });
}

function randomBytes(n: number): Uint8Array {
  const s = Array.from({ length: n }, () => hex(2)).join('');
  return Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
}

export function generateDataKey(ctx: Ctx, p: { KeyId: string; KeySpec?: string; NumberOfBytes?: number; EncryptionContext?: Record<string, string> }, withPlain = true) {
  return trailed(ctx, SRC, withPlain ? 'GenerateDataKey' : 'GenerateDataKeyWithoutPlaintext', [], { KeyId: p.KeyId, KeySpec: p.KeySpec, NumberOfBytes: p.NumberOfBytes }, () => {
    const k = usable(ctx, p.KeyId, withPlain ? 'kms:GenerateDataKey' : 'kms:GenerateDataKeyWithoutPlaintext');
    if (p.KeySpec && p.NumberOfBytes) throw new AwsError('ValidationException', 'KeySpec and NumberOfBytes are mutually exclusive. Specify only one.', 400);
    const n = p.KeySpec === 'AES_128' ? 16 : p.KeySpec === 'AES_256' ? 32 : p.NumberOfBytes ?? 32;
    if (p.KeySpec && !['AES_128', 'AES_256'].includes(p.KeySpec)) throw new AwsError('ValidationException', `1 validation error detected: Value '${p.KeySpec}' at 'keySpec' failed to satisfy constraint: Member must satisfy enum value set: [AES_256, AES_128]`, 400);
    if (n < 1 || n > 1024) throw new AwsError('ValidationException', `1 validation error detected: Value '${n}' at 'numberOfBytes' failed to satisfy constraint: Member must have value less than or equal to 1024`, 400);
    const plain = randomBytes(n);
    return { CiphertextBlob: sealBytes(k, plain, p.EncryptionContext), ...(withPlain ? { Plaintext: b64(plain) } : {}), KeyId: k.arn };
  });
}

export function reEncrypt(ctx: Ctx, p: { CiphertextBlob: string; DestinationKeyId: string; SourceKeyId?: string; SourceEncryptionContext?: Record<string, string>; DestinationEncryptionContext?: Record<string, string> }) {
  return trailed(ctx, SRC, 'ReEncrypt', [], { DestinationKeyId: p.DestinationKeyId }, () => {
    settleKms(ctx.s);
    const id = blobKeyId(p.CiphertextBlob);
    const src = ctx.s.kmsKeys.find((x) => x.id === id && x.region === ctx.region);
    if (!src) throw new AwsError('NotFoundException', `Key '${keyArn(ctx, id)}' does not exist`, 400);
    if (p.SourceKeyId && resolveKey(ctx, p.SourceKeyId).id !== src.id) throw new AwsError('IncorrectKeyException', 'The key ID in the request does not identify a CMK that can perform this operation.', 400);
    kmsAuthorize(ctx, src, 'kms:ReEncryptFrom');
    stateCheck(src);
    const dst = usable(ctx, p.DestinationKeyId, 'kms:ReEncryptTo');
    const plain = openBytes(src, p.CiphertextBlob, p.SourceEncryptionContext);
    return { CiphertextBlob: sealBytes(dst, plain, p.DestinationEncryptionContext), SourceKeyId: src.arn, KeyId: dst.arn, SourceEncryptionAlgorithm: 'SYMMETRIC_DEFAULT', DestinationEncryptionAlgorithm: 'SYMMETRIC_DEFAULT' };
  });
}

// ------------------------------------------------------------------ uso interno por otros servicios (S3, Secrets Manager)

/** Cifra datos para otro servicio. `via` es el servicio; las claves CMK exigen permisos del llamador. */
export function serviceEncrypt(ctx: Ctx, k: KmsKey, via: string, action: 'kms:GenerateDataKey' | 'kms:Encrypt', plain: Uint8Array, context: Record<string, string>): string {
  kmsAuthorize(ctx, k, action, { via });
  stateCheck(k);
  return sealBytes(k, plain, context);
}
export function serviceDecrypt(ctx: Ctx, k: KmsKey, via: string, blob: string, context: Record<string, string>): Uint8Array {
  kmsAuthorize(ctx, k, 'kms:Decrypt', { via });
  stateCheck(k);
  return openBytes(k, blob, context);
}

/** Texto de la clave para mostrar (id → ARN). */
export const keyRef = (k: KmsKey) => k.arn;
