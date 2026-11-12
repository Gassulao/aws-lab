// aws secretsmanager
import { defineCommand, BIN } from '../framework';
import * as sm from '../../../engine/services/secrets';
import type { Secret } from '../../../engine/types';
import { tagList } from '../shapes';

const iso = (s: string) => s.replace(/\.(\d{3})Z$/, '.$1000+00:00').replace(/Z$/, '+00:00');
const day = (s?: string) => (s ? `${s.slice(0, 10)}T00:00:00+00:00` : undefined);
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const TAGS = { list: ['tags'], structured: ['tags'] };
const bin = (v: unknown) => (typeof v === 'string' && v.startsWith(BIN) ? btoa(v.slice(BIN.length)) : v === undefined ? undefined : String(v));
const stages = (s: Secret) => Object.fromEntries(s.versions.map((v) => [v.id, v.stages]));

function describe(s: Secret, list = false) {
  return strip({
    ARN: s.arn, Name: s.name, Description: s.description, KmsKeyId: s.kmsKeyId,
    RotationEnabled: s.rotation ? s.rotation.enabled : undefined, RotationLambdaARN: s.rotation?.lambdaArn,
    RotationRules: s.rotation?.days ? { AutomaticallyAfterDays: s.rotation.days } : undefined,
    LastRotatedDate: s.rotation?.lastRotatedAt ? iso(s.rotation.lastRotatedAt) : undefined,
    LastChangedDate: iso(s.changedAt), LastAccessedDate: day(s.accessedAt), NextRotationDate: s.rotation?.enabled && s.rotation.nextRotationAt ? iso(s.rotation.nextRotationAt) : undefined,
    DeletedDate: s.deletedAt ? iso(s.deletedAt) : undefined, Tags: tagList(s.tags),
    [list ? 'SecretVersionsToStages' : 'VersionIdsToStages']: stages(s), CreatedDate: iso(s.createdAt),
  });
}

defineCommand({
  service: 'secretsmanager', name: 'create-secret', op: 'CreateSecret', ...TAGS,
  run: (c, p) => {
    const { sec, versionId } = sm.createSecret(c, { Name: p.Name, Description: p.Description, KmsKeyId: p.KmsKeyId, SecretString: p.SecretString, SecretBinary: bin(p.SecretBinary), Tags: p.Tags });
    return strip({ ARN: sec.arn, Name: sec.name, VersionId: versionId });
  },
});
defineCommand({
  service: 'secretsmanager', name: 'get-secret-value', op: 'GetSecretValue',
  run: (c, p) => {
    const { sec, v, text } = sm.getSecretValue(c, { SecretId: p.SecretId, VersionId: p.VersionId, VersionStage: p.VersionStage });
    return { ARN: sec.arn, Name: sec.name, VersionId: v.id, [v.binary ? 'SecretBinary' : 'SecretString']: text, VersionStages: v.stages, CreatedDate: iso(v.createdAt) };
  },
});
defineCommand({
  service: 'secretsmanager', name: 'put-secret-value', op: 'PutSecretValue', list: ['version-stages'],
  run: (c, p) => {
    const { sec, v } = sm.putSecretValue(c, { SecretId: p.SecretId, SecretString: p.SecretString, SecretBinary: bin(p.SecretBinary), VersionStages: p.VersionStages });
    return { ARN: sec.arn, Name: sec.name, VersionId: v.id, VersionStages: v.stages };
  },
});
defineCommand({
  service: 'secretsmanager', name: 'update-secret', op: 'UpdateSecret',
  run: (c, p) => {
    const { sec, v } = sm.updateSecret(c, { SecretId: p.SecretId, Description: p.Description, KmsKeyId: p.KmsKeyId, SecretString: p.SecretString });
    return strip({ ARN: sec.arn, Name: sec.name, VersionId: v?.id });
  },
});
defineCommand({ service: 'secretsmanager', name: 'describe-secret', op: 'DescribeSecret', run: (c, p) => describe(sm.describeSecret(c, { SecretId: p.SecretId })) });
defineCommand({ service: 'secretsmanager', name: 'list-secrets', op: 'ListSecrets', bool: ['include-planned-deletion'], run: (c, p) => ({ SecretList: sm.listSecrets(c, { IncludePlannedDeletion: p.IncludePlannedDeletion }).map((s) => describe(s, true)) }) });
defineCommand({
  service: 'secretsmanager', name: 'list-secret-version-ids', op: 'ListSecretVersionIds', bool: ['include-deprecated'],
  run: (c, p) => {
    const s = sm.listSecretVersionIds(c, { SecretId: p.SecretId });
    return { Versions: s.versions.map((v) => ({ VersionId: v.id, VersionStages: v.stages, CreatedDate: iso(v.createdAt) })), ARN: s.arn, Name: s.name };
  },
});
defineCommand({
  service: 'secretsmanager', name: 'delete-secret', op: 'DeleteSecret', bool: ['force-delete-without-recovery'],
  run: (c, p) => {
    const { sec, deletionDate } = sm.deleteSecret(c, { SecretId: p.SecretId, RecoveryWindowInDays: p.RecoveryWindowInDays !== undefined ? Number(p.RecoveryWindowInDays) : undefined, ForceDeleteWithoutRecovery: p.ForceDeleteWithoutRecovery });
    return { ARN: sec.arn, Name: sec.name, DeletionDate: iso(deletionDate) };
  },
});
defineCommand({ service: 'secretsmanager', name: 'restore-secret', op: 'RestoreSecret', run: (c, p) => { const s = sm.restoreSecret(c, { SecretId: p.SecretId }); return { ARN: s.arn, Name: s.name }; } });
defineCommand({
  service: 'secretsmanager', name: 'rotate-secret', op: 'RotateSecret', structured: ['rotation-rules'], bool: ['rotate-immediately'],
  run: (c, p) => {
    const { sec, versionId } = sm.rotateSecret(c, { SecretId: p.SecretId, RotationLambdaARN: p.RotationLambdaArn, AutomaticallyAfterDays: p.RotationRules?.AutomaticallyAfterDays !== undefined ? Number(p.RotationRules.AutomaticallyAfterDays) : undefined, RotateImmediately: p.RotateImmediately });
    return strip({ ARN: sec.arn, Name: sec.name, VersionId: versionId });
  },
});
defineCommand({ service: 'secretsmanager', name: 'cancel-rotate-secret', op: 'CancelRotateSecret', run: (c, p) => { const s = sm.cancelRotateSecret(c, { SecretId: p.SecretId }); return { ARN: s.arn, Name: s.name }; } });
defineCommand({ service: 'secretsmanager', name: 'tag-resource', op: 'TagResource', ...TAGS, run: (c, p) => void sm.tagSecret(c, { SecretId: p.SecretId, Tags: p.Tags ?? [] }) });
defineCommand({ service: 'secretsmanager', name: 'untag-resource', op: 'UntagResource', list: ['tag-keys'], run: (c, p) => void sm.untagSecret(c, { SecretId: p.SecretId, TagKeys: p.TagKeys ?? [] }) });
defineCommand({
  service: 'secretsmanager', name: 'get-random-password', op: 'GetRandomPassword', bool: ['exclude-numbers', 'exclude-punctuation', 'exclude-uppercase', 'exclude-lowercase', 'include-space', 'require-each-included-type'],
  run: (c, p) => ({ RandomPassword: sm.getRandomPassword(c, { PasswordLength: p.PasswordLength !== undefined ? Number(p.PasswordLength) : undefined, ExcludeCharacters: p.ExcludeCharacters, ExcludeNumbers: p.ExcludeNumbers, ExcludePunctuation: p.ExcludePunctuation, ExcludeUppercase: p.ExcludeUppercase, ExcludeLowercase: p.ExcludeLowercase, IncludeSpace: p.IncludeSpace, RequireEachIncludedType: p.RequireEachIncludedType }) }),
});
defineCommand({ service: 'secretsmanager', name: 'put-resource-policy', op: 'PutResourcePolicy', run: (c, p) => { const s = sm.putResourcePolicy(c, { SecretId: p.SecretId, ResourcePolicy: p.ResourcePolicy }); return { ARN: s.arn, Name: s.name }; } });
defineCommand({
  service: 'secretsmanager', name: 'get-resource-policy', op: 'GetResourcePolicy',
  run: (c, p) => { const s = sm.getResourcePolicy(c, { SecretId: p.SecretId }); return strip({ ARN: s.arn, Name: s.name, ResourcePolicy: s.resourcePolicy ? JSON.stringify(s.resourcePolicy, null, 2) : undefined }); },
});
defineCommand({ service: 'secretsmanager', name: 'delete-resource-policy', op: 'DeleteResourcePolicy', run: (c, p) => { const s = sm.deleteResourcePolicy(c, { SecretId: p.SecretId }); return { ARN: s.arn, Name: s.name }; } });
