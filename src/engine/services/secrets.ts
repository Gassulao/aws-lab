// AWS Secrets Manager: secretos versionados (AWSCURRENT/AWSPREVIOUS/AWSPENDING) cifrados con KMS, recuperación tras
// el borrado, política de recurso y rotación SIMULADA (en AWS real la ejecuta una función Lambda).
import type { Secret, SecretVersion, PolicyDocument, KmsKey } from '../types';
import { AwsError } from '../errors';
import { authorize, trailed, type Ctx } from '../api';
import { validatePolicyDocument } from '../policy';
import { nowIso, now, guid, randomString } from '../util';
import { awsManagedKey, resolveKey, kmsAuthorize, sealBytes, openBytes } from './kms';

const SRC = 'secretsmanager.amazonaws.com';
const DAY = 86_400_000;
const NAME_RE = /^[0-9A-Za-z/_+=.@-]{1,512}$/;
const via = (ctx: Ctx) => ({ via: `secretsmanager.${ctx.region}.amazonaws.com` });

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** Borra definitivamente los secretos cuya ventana de recuperación ha vencido. */
export function settleSecrets(s: Ctx['s']) {
  const t = now();
  s.secrets = s.secrets.filter((x) => !(x.deletedAt && new Date(x.deletedAt).getTime() <= t));
}

export function findSecret(ctx: Ctx, ref: string): Secret {
  settleSecrets(ctx.s);
  const arnName = ref.startsWith('arn:') ? /^arn:aws:secretsmanager:([^:]*):\d{12}:secret:(.+)$/.exec(ref) : null;
  if (ref.startsWith('arn:') && !arnName) throw new AwsError('InvalidParameterException', 'Invalid secret ARN', 400);
  const sec = ctx.s.secrets.find((x) => x.region === ctx.region && (arnName ? x.arn === ref || (x.name === arnName[2] && arnName[1] === x.region) : x.name === ref));
  if (!sec) throw new AwsError('ResourceNotFoundException', "Secrets Manager can't find the specified secret.", 400);
  return sec;
}

function notDeleted(sec: Secret) {
  if (sec.deletedAt) throw new AwsError('InvalidRequestException', "You can't perform this operation on the secret because it was marked for deletion.", 400);
}

function keyOf(ctx: Ctx, sec: { kmsKeyId?: string }): KmsKey {
  return sec.kmsKeyId ? resolveKey(ctx, sec.kmsKeyId) : awsManagedKey(ctx, 'secretsmanager');
}

function encryptValue(ctx: Ctx, sec: Pick<Secret, 'arn' | 'kmsKeyId'>, text: string): string {
  const k = keyOf(ctx, sec);
  try {
    kmsAuthorize(ctx, k, 'kms:GenerateDataKey', via(ctx));
  } catch (e) {
    if (e instanceof AwsError && e.code === 'AccessDeniedException') throw new AwsError('AccessDeniedException', 'Access to KMS is not allowed', 400);
    throw e;
  }
  if (k.state !== 'Enabled') throw new AwsError('EncryptionFailure', "Secrets Manager can't encrypt the protected secret text using the provided KMS key. Check the key and its key policy.", 400);
  return sealBytes(k, enc(text), { SecretARN: sec.arn });
}

function decryptValue(ctx: Ctx, sec: Secret, v: SecretVersion): string {
  let k: KmsKey;
  try {
    k = keyOf(ctx, sec);
  } catch {
    throw new AwsError('DecryptionFailure', "Secrets Manager can't decrypt the protected secret text using the provided KMS key.", 400);
  }
  try {
    kmsAuthorize(ctx, k, 'kms:Decrypt', via(ctx));
  } catch (e) {
    if (e instanceof AwsError && e.code === 'AccessDeniedException') throw new AwsError('AccessDeniedException', 'Access to KMS is not allowed', 400);
    throw e;
  }
  if (k.state !== 'Enabled') throw new AwsError('DecryptionFailure', "Secrets Manager can't decrypt the protected secret text using the provided KMS key. Check the key status.", 400);
  return dec(openBytes(k, v.ciphertext, { SecretARN: sec.arn }));
}

const auth = (ctx: Ctx, action: string, sec: Secret, ref?: string) => authorize(ctx, action, sec.arn, { resourcePolicy: sec.resourcePolicy, display: ref });

function validTags(tags?: { Key: string; Value: string }[]) {
  return Object.fromEntries((tags ?? []).map((t) => [t.Key, t.Value ?? '']));
}

function addVersion(ctx: Ctx, sec: Secret, text: string, binary: boolean, stages: string[] = ['AWSCURRENT']): SecretVersion {
  const v: SecretVersion = { id: guid(), stages: [...stages], ciphertext: encryptValue(ctx, sec, text), binary, createdAt: nowIso() };
  if (stages.includes('AWSCURRENT')) {
    const prev = sec.versions.find((x) => x.stages.includes('AWSCURRENT'));
    sec.versions.forEach((x) => (x.stages = x.stages.filter((st) => st !== 'AWSPREVIOUS' && !stages.includes(st))));
    if (prev) prev.stages = [...prev.stages, 'AWSPREVIOUS'];
  } else {
    sec.versions.forEach((x) => (x.stages = x.stages.filter((st) => !stages.includes(st))));
  }
  sec.versions.push(v);
  sec.versions = sec.versions.filter((x) => x.stages.length > 0);
  sec.changedAt = nowIso();
  return v;
}

// ------------------------------------------------------------------ operaciones

export function createSecret(ctx: Ctx, p: { Name: string; Description?: string; KmsKeyId?: string; SecretString?: string; SecretBinary?: string; Tags?: { Key: string; Value: string }[] }) {
  return trailed(ctx, SRC, 'CreateSecret', [{ type: 'AWS::SecretsManager::Secret', name: p.Name }], { Name: p.Name, Description: p.Description, KmsKeyId: p.KmsKeyId }, () => {
    authorize(ctx, 'secretsmanager:CreateSecret', `arn:aws:secretsmanager:${ctx.region}:${ctx.s.account.id}:secret:${p.Name}-XXXXXX`);
    settleSecrets(ctx.s);
    if (!NAME_RE.test(p.Name)) throw new AwsError('ValidationException', 'Invalid name. Must be a valid name containing alphanumeric characters, or any of the following: -/_+=.@!', 400);
    const dup = ctx.s.secrets.find((x) => x.name === p.Name && x.region === ctx.region);
    if (dup?.deletedAt) throw new AwsError('InvalidRequestException', "You can't create this secret because a secret with this name is already scheduled for deletion.", 400);
    if (dup) throw new AwsError('ResourceExistsException', `The operation failed because the secret ${p.Name} already exists.`, 400);
    if (p.SecretString !== undefined && p.SecretBinary !== undefined) throw new AwsError('InvalidParameterException', 'You can\'t specify both SecretString and SecretBinary.', 400);
    if (p.KmsKeyId) {
      try {
        const k = resolveKey(ctx, p.KmsKeyId);
        if (k.state === 'PendingDeletion') throw new AwsError('InvalidRequestException', `Secrets Manager can't use the KMS key ${k.arn} because it is pending deletion.`, 400);
      } catch (e) {
        if (e instanceof AwsError && e.code === 'NotFoundException') throw new AwsError('ResourceNotFoundException', "Secrets Manager can't find the specified KMS key.", 400);
        throw e;
      }
    }
    const arn = `arn:aws:secretsmanager:${ctx.region}:${ctx.s.account.id}:secret:${p.Name}-${randomString(6, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')}`;
    const sec: Secret = { name: p.Name, arn, region: ctx.region, description: p.Description, kmsKeyId: p.KmsKeyId, versions: [], createdAt: nowIso(), changedAt: nowIso(), tags: validTags(p.Tags) };
    let v: SecretVersion | undefined;
    const val = p.SecretString ?? p.SecretBinary;
    if (val !== undefined) v = addVersion(ctx, sec, val, p.SecretBinary !== undefined);
    ctx.s.secrets.push(sec);
    return { sec, versionId: v?.id };
  });
}

export function getSecretValue(ctx: Ctx, p: { SecretId: string; VersionId?: string; VersionStage?: string }) {
  return trailed(ctx, SRC, 'GetSecretValue', [], { SecretId: p.SecretId, VersionId: p.VersionId, VersionStage: p.VersionStage }, () => {
    const sec = findSecret(ctx, p.SecretId);
    auth(ctx, 'secretsmanager:GetSecretValue', sec, p.SecretId);
    notDeleted(sec);
    let v: SecretVersion | undefined;
    if (p.VersionId) {
      v = sec.versions.find((x) => x.id === p.VersionId);
      if (!v) throw new AwsError('ResourceNotFoundException', `Secrets Manager can't find the specified secret value for VersionId: ${p.VersionId}`, 400);
    } else {
      const stage = p.VersionStage ?? 'AWSCURRENT';
      v = sec.versions.find((x) => x.stages.includes(stage));
      if (!v) throw new AwsError('ResourceNotFoundException', `Secrets Manager can't find the specified secret value for staging label: ${stage}`, 400);
    }
    const text = decryptValue(ctx, sec, v);
    sec.accessedAt = nowIso();
    return { sec, v, text };
  });
}

export function putSecretValue(ctx: Ctx, p: { SecretId: string; SecretString?: string; SecretBinary?: string; VersionStages?: string[] }) {
  return trailed(ctx, SRC, 'PutSecretValue', [], { SecretId: p.SecretId, VersionStages: p.VersionStages }, () => {
    const sec = findSecret(ctx, p.SecretId);
    auth(ctx, 'secretsmanager:PutSecretValue', sec, p.SecretId);
    notDeleted(sec);
    const val = p.SecretString ?? p.SecretBinary;
    if (val === undefined) throw new AwsError('ValidationException', 'You must provide either SecretString or SecretBinary.', 400);
    const v = addVersion(ctx, sec, val, p.SecretBinary !== undefined, p.VersionStages?.length ? p.VersionStages : ['AWSCURRENT']);
    return { sec, v };
  });
}

export function updateSecret(ctx: Ctx, p: { SecretId: string; Description?: string; KmsKeyId?: string; SecretString?: string }) {
  return trailed(ctx, SRC, 'UpdateSecret', [], { SecretId: p.SecretId, KmsKeyId: p.KmsKeyId }, () => {
    const sec = findSecret(ctx, p.SecretId);
    auth(ctx, 'secretsmanager:UpdateSecret', sec, p.SecretId);
    notDeleted(sec);
    if (p.Description !== undefined) sec.description = p.Description;
    if (p.KmsKeyId && p.KmsKeyId !== sec.kmsKeyId) {
      // Re-cifra todas las versiones con la nueva clave.
      const plain = sec.versions.map((v) => decryptValue(ctx, sec, v));
      try {
        resolveKey(ctx, p.KmsKeyId);
      } catch {
        throw new AwsError('ResourceNotFoundException', "Secrets Manager can't find the specified KMS key.", 400);
      }
      sec.kmsKeyId = p.KmsKeyId;
      sec.versions.forEach((v, i) => (v.ciphertext = encryptValue(ctx, sec, plain[i])));
    }
    let v: SecretVersion | undefined;
    if (p.SecretString !== undefined) v = addVersion(ctx, sec, p.SecretString, false);
    sec.changedAt = nowIso();
    return { sec, v };
  });
}

export function describeSecret(ctx: Ctx, p: { SecretId: string }): Secret {
  return trailed(ctx, SRC, 'DescribeSecret', [], p, () => {
    const sec = findSecret(ctx, p.SecretId);
    auth(ctx, 'secretsmanager:DescribeSecret', sec, p.SecretId);
    return sec;
  });
}

export function listSecrets(ctx: Ctx, p: { IncludePlannedDeletion?: boolean } = {}): Secret[] {
  return trailed(ctx, SRC, 'ListSecrets', [], p, () => {
    settleSecrets(ctx.s);
    authorize(ctx, 'secretsmanager:ListSecrets', '*');
    return ctx.s.secrets.filter((x) => x.region === ctx.region && (p.IncludePlannedDeletion || !x.deletedAt));
  });
}

export function listSecretVersionIds(ctx: Ctx, p: { SecretId: string; IncludeDeprecated?: boolean }) {
  return trailed(ctx, SRC, 'ListSecretVersionIds', [], p, () => {
    const sec = findSecret(ctx, p.SecretId);
    auth(ctx, 'secretsmanager:ListSecretVersionIds', sec, p.SecretId);
    return sec;
  });
}

export function deleteSecret(ctx: Ctx, p: { SecretId: string; RecoveryWindowInDays?: number; ForceDeleteWithoutRecovery?: boolean }) {
  return trailed(ctx, SRC, 'DeleteSecret', [], p, () => {
    const sec = findSecret(ctx, p.SecretId);
    auth(ctx, 'secretsmanager:DeleteSecret', sec, p.SecretId);
    if (p.ForceDeleteWithoutRecovery && p.RecoveryWindowInDays !== undefined) throw new AwsError('InvalidParameterException', "You can't use ForceDeleteWithoutRecovery in conjunction with RecoveryWindowInDays.", 400);
    const days = p.RecoveryWindowInDays ?? 30;
    if (!p.ForceDeleteWithoutRecovery && (days < 7 || days > 30)) throw new AwsError('InvalidParameterException', 'The RecoveryWindowInDays value must be between 7 and 30 days (inclusive).', 400);
    if (p.ForceDeleteWithoutRecovery) {
      ctx.s.secrets = ctx.s.secrets.filter((x) => x !== sec);
      return { sec, deletionDate: nowIso() };
    }
    sec.deletedAt = new Date(now() + days * DAY).toISOString();
    return { sec, deletionDate: sec.deletedAt };
  });
}

export function restoreSecret(ctx: Ctx, p: { SecretId: string }): Secret {
  return trailed(ctx, SRC, 'RestoreSecret', [], p, () => {
    const sec = findSecret(ctx, p.SecretId);
    auth(ctx, 'secretsmanager:RestoreSecret', sec, p.SecretId);
    delete sec.deletedAt;
    return sec;
  });
}

export function randomPassword(len: number, o: { ExcludeCharacters?: string; ExcludeNumbers?: boolean; ExcludePunctuation?: boolean; ExcludeUppercase?: boolean; ExcludeLowercase?: boolean; IncludeSpace?: boolean; RequireEachIncludedType?: boolean }): string {
  const sets: string[] = [];
  if (!o.ExcludeLowercase) sets.push('abcdefghijklmnopqrstuvwxyz');
  if (!o.ExcludeUppercase) sets.push('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  if (!o.ExcludeNumbers) sets.push('0123456789');
  if (!o.ExcludePunctuation) sets.push('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');
  if (o.IncludeSpace) sets.push(' ');
  const ex = o.ExcludeCharacters ?? '';
  const pools = sets.map((s) => [...s].filter((c) => !ex.includes(c)).join('')).filter(Boolean);
  if (!pools.length) throw new AwsError('InvalidParameterException', 'Unable to generate a password with the given constraints.', 400);
  const all = pools.join('');
  let out = randomString(len, all);
  if (o.RequireEachIncludedType !== false && len >= pools.length) {
    const chars = [...out];
    pools.forEach((pool, i) => {
      if (![...pool].some((c) => chars.includes(c))) chars[i] = randomString(1, pool);
    });
    out = chars.join('');
  }
  return out;
}

export function getRandomPassword(ctx: Ctx, p: { PasswordLength?: number; ExcludeCharacters?: string; ExcludeNumbers?: boolean; ExcludePunctuation?: boolean; ExcludeUppercase?: boolean; ExcludeLowercase?: boolean; IncludeSpace?: boolean; RequireEachIncludedType?: boolean }): string {
  return trailed(ctx, SRC, 'GetRandomPassword', [], p, () => {
    authorize(ctx, 'secretsmanager:GetRandomPassword', '*');
    const len = p.PasswordLength ?? 32;
    if (len < 1 || len > 4096) throw new AwsError('InvalidParameterException', 'Password length must be between 1 and 4096.', 400);
    return randomPassword(len, p);
  });
}

export function rotateSecret(ctx: Ctx, p: { SecretId: string; RotationLambdaARN?: string; AutomaticallyAfterDays?: number; RotateImmediately?: boolean }) {
  return trailed(ctx, SRC, 'RotateSecret', [], p, () => {
    const sec = findSecret(ctx, p.SecretId);
    auth(ctx, 'secretsmanager:RotateSecret', sec, p.SecretId);
    notDeleted(sec);
    const days = p.AutomaticallyAfterDays ?? sec.rotation?.days ?? 30;
    if (days < 1 || days > 1000) throw new AwsError('InvalidParameterException', 'AutomaticallyAfterDays must be between 1 and 1000.', 400);
    const cur = sec.versions.find((v) => v.stages.includes('AWSCURRENT'));
    if (!cur) throw new AwsError('InvalidRequestException', "You can't rotate a secret that has no value.", 400);
    sec.rotation = { enabled: true, lambdaArn: p.RotationLambdaARN ?? sec.rotation?.lambdaArn, days, lastRotatedAt: sec.rotation?.lastRotatedAt, nextRotationAt: sec.rotation?.nextRotationAt };
    let versionId: string | undefined;
    if (p.RotateImmediately !== false) {
      // Simulación de las fases createSecret/setSecret/testSecret/finishSecret: genera un valor nuevo conservando la estructura JSON.
      const old = decryptValue(ctx, sec, cur);
      let next: string;
      try {
        const j = JSON.parse(old);
        if (j && typeof j === 'object' && 'password' in j) next = JSON.stringify({ ...j, password: randomPassword(32, { ExcludePunctuation: true }) });
        else next = randomPassword(32, { ExcludePunctuation: true });
      } catch {
        next = randomPassword(32, { ExcludePunctuation: true });
      }
      const v = addVersion(ctx, sec, next, false);
      versionId = v.id;
      sec.rotation.lastRotatedAt = nowIso();
    }
    sec.rotation.nextRotationAt = new Date((sec.rotation.lastRotatedAt ? new Date(sec.rotation.lastRotatedAt).getTime() : now()) + days * DAY).toISOString();
    return { sec, versionId };
  });
}

export function cancelRotateSecret(ctx: Ctx, p: { SecretId: string }): Secret {
  return trailed(ctx, SRC, 'CancelRotateSecret', [], p, () => {
    const sec = findSecret(ctx, p.SecretId);
    auth(ctx, 'secretsmanager:CancelRotateSecret', sec, p.SecretId);
    notDeleted(sec);
    if (!sec.rotation?.enabled) throw new AwsError('InvalidRequestException', "The secret isn't rotating.", 400);
    sec.rotation = { ...sec.rotation, enabled: false, nextRotationAt: undefined };
    return sec;
  });
}

export function tagSecret(ctx: Ctx, p: { SecretId: string; Tags: { Key: string; Value: string }[] }): void {
  trailed(ctx, SRC, 'TagResource', [], p, () => {
    const sec = findSecret(ctx, p.SecretId);
    auth(ctx, 'secretsmanager:TagResource', sec, p.SecretId);
    Object.assign(sec.tags, validTags(p.Tags));
  });
}
export function untagSecret(ctx: Ctx, p: { SecretId: string; TagKeys: string[] }): void {
  trailed(ctx, SRC, 'UntagResource', [], p, () => {
    const sec = findSecret(ctx, p.SecretId);
    auth(ctx, 'secretsmanager:UntagResource', sec, p.SecretId);
    p.TagKeys.forEach((k) => delete sec.tags[k]);
  });
}

export function putResourcePolicy(ctx: Ctx, p: { SecretId: string; ResourcePolicy: string }): Secret {
  return trailed(ctx, SRC, 'PutResourcePolicy', [], { SecretId: p.SecretId }, () => {
    const sec = findSecret(ctx, p.SecretId);
    auth(ctx, 'secretsmanager:PutResourcePolicy', sec, p.SecretId);
    let doc: PolicyDocument;
    try {
      doc = validatePolicyDocument(JSON.parse(p.ResourcePolicy), 'resource');
    } catch (e) {
      throw new AwsError('MalformedPolicyDocumentException', e instanceof AwsError ? e.message : 'This resource policy contains invalid JSON.', 400);
    }
    sec.resourcePolicy = doc;
    return sec;
  });
}
export function getResourcePolicy(ctx: Ctx, p: { SecretId: string }): Secret {
  return trailed(ctx, SRC, 'GetResourcePolicy', [], p, () => {
    const sec = findSecret(ctx, p.SecretId);
    auth(ctx, 'secretsmanager:GetResourcePolicy', sec, p.SecretId);
    return sec;
  });
}
export function deleteResourcePolicy(ctx: Ctx, p: { SecretId: string }): Secret {
  return trailed(ctx, SRC, 'DeleteResourcePolicy', [], p, () => {
    const sec = findSecret(ctx, p.SecretId);
    auth(ctx, 'secretsmanager:DeleteResourcePolicy', sec, p.SecretId);
    delete sec.resourcePolicy;
    return sec;
  });
}
