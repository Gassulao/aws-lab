// aws kms
import { defineCommand, BIN, type Params } from '../framework';
import * as kms from '../../../engine/services/kms';
import type { KmsKey } from '../../../engine/types';
import type { Ctx } from '../../../engine/api';

const isoMicro = (s: string) => s.replace(/\.(\d{3})Z$/, '.$1000+00:00').replace(/Z$/, '+00:00');
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const TAGS = { list: ['tags'], structured: ['tags'] };

export function keyMetadata(c: Ctx, k: KmsKey) {
  return strip({
    AWSAccountId: c.s.account.id, KeyId: k.id, Arn: k.arn, CreationDate: isoMicro(k.createdAt), Enabled: k.state === 'Enabled', Description: k.description,
    KeyUsage: k.usage, KeyState: k.state, DeletionDate: k.deletionDate ? isoMicro(k.deletionDate) : undefined, Origin: 'AWS_KMS', KeyManager: k.manager,
    CustomerMasterKeySpec: k.spec, KeySpec: k.spec, EncryptionAlgorithms: ['SYMMETRIC_DEFAULT'], MultiRegion: false,
  });
}

/** Entrada binaria como la entiende AWS CLI v2: base64 por defecto, texto con raw-in-base64-out o bytes con fileb://. */
function inBytesB64(p: Params, v: unknown, rawAllowed: boolean): string {
  const s = String(v ?? '');
  if (s.startsWith(BIN)) return btoa(s.slice(BIN.length));
  if (rawAllowed && p.CliBinaryFormat === 'raw-in-base64-out') return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  try {
    atob(s);
    if (s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s)) return s;
  } catch {
    /* cae al error */
  }
  throw new Error(`Invalid base64: "${s}"`);
}

const ctxOf = (p: Params): Record<string, string> | undefined => p.EncryptionContext;
const id = (p: Params) => String(p.KeyId);

defineCommand({
  service: 'kms', name: 'create-key', op: 'CreateKey', ...TAGS, bool: ['bypass-policy-lockout-safety-check'],
  run: (c, p) => ({ KeyMetadata: keyMetadata(c, kms.createKey(c, { Description: p.Description, Policy: p.Policy, Tags: p.Tags, KeyUsage: p.KeyUsage, KeySpec: p.KeySpec ?? p.CustomerMasterKeySpec, BypassPolicyLockoutSafetyCheck: p.BypassPolicyLockoutSafetyCheck })) }),
});
defineCommand({ service: 'kms', name: 'describe-key', op: 'DescribeKey', run: (c, p) => ({ KeyMetadata: keyMetadata(c, kms.describeKey(c, { KeyId: id(p) })) }) });
defineCommand({ service: 'kms', name: 'list-keys', op: 'ListKeys', run: (c) => ({ Keys: kms.listKeys(c).map((k) => ({ KeyId: k.id, KeyArn: k.arn })), Truncated: false }) });
defineCommand({
  service: 'kms', name: 'list-aliases', op: 'ListAliases',
  run: (c, p) => ({
    Aliases: kms.listAliases(c, { KeyId: p.KeyId }).map((a) => ({ AliasName: a.name, AliasArn: `arn:aws:kms:${a.region}:${c.s.account.id}:${a.name}`, TargetKeyId: a.keyId, CreationDate: isoMicro(a.createdAt), LastUpdatedDate: isoMicro(a.updatedAt) })),
    Truncated: false,
  }),
});
defineCommand({ service: 'kms', name: 'create-alias', op: 'CreateAlias', run: (c, p) => void kms.createAlias(c, { AliasName: p.AliasName, TargetKeyId: p.TargetKeyId }) });
defineCommand({ service: 'kms', name: 'update-alias', op: 'UpdateAlias', run: (c, p) => void kms.updateAlias(c, { AliasName: p.AliasName, TargetKeyId: p.TargetKeyId }) });
defineCommand({ service: 'kms', name: 'delete-alias', op: 'DeleteAlias', run: (c, p) => void kms.deleteAlias(c, { AliasName: p.AliasName }) });
defineCommand({ service: 'kms', name: 'enable-key', op: 'EnableKey', run: (c, p) => void kms.setKeyEnabled(c, { KeyId: id(p) }, true) });
defineCommand({ service: 'kms', name: 'disable-key', op: 'DisableKey', run: (c, p) => void kms.setKeyEnabled(c, { KeyId: id(p) }, false) });
defineCommand({
  service: 'kms', name: 'schedule-key-deletion', op: 'ScheduleKeyDeletion',
  run: (c, p) => {
    const r = kms.scheduleKeyDeletion(c, { KeyId: id(p), PendingWindowInDays: p.PendingWindowInDays !== undefined ? Number(p.PendingWindowInDays) : undefined });
    return { ...r, DeletionDate: isoMicro(r.DeletionDate) };
  },
});
defineCommand({ service: 'kms', name: 'cancel-key-deletion', op: 'CancelKeyDeletion', run: (c, p) => ({ KeyId: kms.cancelKeyDeletion(c, { KeyId: id(p) }) }) });
defineCommand({ service: 'kms', name: 'enable-key-rotation', op: 'EnableKeyRotation', run: (c, p) => void kms.setRotation(c, { KeyId: id(p), RotationPeriodInDays: p.RotationPeriodInDays !== undefined ? Number(p.RotationPeriodInDays) : undefined }, true) });
defineCommand({ service: 'kms', name: 'disable-key-rotation', op: 'DisableKeyRotation', run: (c, p) => void kms.setRotation(c, { KeyId: id(p) }, false) });
defineCommand({
  service: 'kms', name: 'get-key-rotation-status', op: 'GetKeyRotationStatus',
  run: (c, p) => {
    const r = kms.getRotationStatus(c, { KeyId: id(p) });
    return strip({ KeyId: r.KeyId, KeyRotationEnabled: r.KeyRotationEnabled, RotationPeriodInDays: r.RotationPeriodInDays, NextRotationDate: r.NextRotationDate ? isoMicro(r.NextRotationDate) : undefined });
  },
});
defineCommand({ service: 'kms', name: 'get-key-policy', op: 'GetKeyPolicy', run: (c, p) => ({ Policy: JSON.stringify(kms.getKeyPolicy(c, { KeyId: id(p), PolicyName: p.PolicyName }), null, 2), PolicyName: 'default' }) });
defineCommand({ service: 'kms', name: 'put-key-policy', op: 'PutKeyPolicy', bool: ['bypass-policy-lockout-safety-check'], run: (c, p) => void kms.putKeyPolicy(c, { KeyId: id(p), PolicyName: p.PolicyName, Policy: p.Policy, BypassPolicyLockoutSafetyCheck: p.BypassPolicyLockoutSafetyCheck }) });
defineCommand({ service: 'kms', name: 'list-key-policies', op: 'ListKeyPolicies', run: (c, p) => (kms.getKeyPolicy(c, { KeyId: id(p) }), { PolicyNames: ['default'], Truncated: false }) });
defineCommand({ service: 'kms', name: 'tag-resource', op: 'TagResource', ...TAGS, run: (c, p) => void kms.tagResource(c, { KeyId: id(p), Tags: p.Tags ?? [] }) });
defineCommand({ service: 'kms', name: 'untag-resource', op: 'UntagResource', list: ['tag-keys'], run: (c, p) => void kms.untagResource(c, { KeyId: id(p), TagKeys: p.TagKeys ?? [] }) });
defineCommand({ service: 'kms', name: 'list-resource-tags', op: 'ListResourceTags', run: (c, p) => ({ Tags: Object.entries(kms.listResourceTags(c, { KeyId: id(p) })).map(([TagKey, TagValue]) => ({ TagKey, TagValue })), Truncated: false }) });

// ---------------------------------------------------------------- grants
defineCommand({
  service: 'kms', name: 'create-grant', op: 'CreateGrant', list: ['operations'],
  run: (c, p) => {
    const g = kms.createGrant(c, { KeyId: id(p), GranteePrincipal: p.GranteePrincipal, Operations: p.Operations ?? [], RetiringPrincipal: p.RetiringPrincipal, Name: p.Name });
    return { GrantToken: g.token, GrantId: g.id };
  },
});
defineCommand({
  service: 'kms', name: 'list-grants', op: 'ListGrants',
  run: (c, p) => {
    const { key, grants } = kms.listGrants(c, { KeyId: id(p) });
    return { Grants: grants.map((g) => strip({ KeyId: key.id, GrantId: g.id, Name: g.name, CreationDate: isoMicro(g.createdAt), GranteePrincipal: g.granteePrincipal, RetiringPrincipal: g.retiringPrincipal, IssuingAccount: `arn:aws:iam::${c.s.account.id}:root`, Operations: g.operations })), Truncated: false };
  },
});
defineCommand({ service: 'kms', name: 'revoke-grant', op: 'RevokeGrant', run: (c, p) => void kms.revokeGrant(c, { KeyId: id(p), GrantId: p.GrantId }) });
defineCommand({ service: 'kms', name: 'retire-grant', op: 'RetireGrant', run: (c, p) => void kms.revokeGrant(c, { KeyId: id(p), GrantId: p.GrantId }, true) });

// ---------------------------------------------------------------- operaciones criptográficas
defineCommand({
  service: 'kms', name: 'encrypt', op: 'Encrypt', structured: ['encryption-context'],
  run: (c, p) => kms.encrypt(c, { KeyId: id(p), Plaintext: inBytesB64(p, p.Plaintext, true), EncryptionContext: ctxOf(p) }),
});
defineCommand({
  service: 'kms', name: 'decrypt', op: 'Decrypt', structured: ['encryption-context'],
  run: (c, p) => kms.decrypt(c, { CiphertextBlob: inBytesB64(p, p.CiphertextBlob, false), KeyId: p.KeyId, EncryptionContext: ctxOf(p) }),
});
defineCommand({
  service: 'kms', name: 'generate-data-key', op: 'GenerateDataKey', structured: ['encryption-context'],
  run: (c, p) => kms.generateDataKey(c, { KeyId: id(p), KeySpec: p.KeySpec, NumberOfBytes: p.NumberOfBytes !== undefined ? Number(p.NumberOfBytes) : undefined, EncryptionContext: ctxOf(p) }),
});
defineCommand({
  service: 'kms', name: 'generate-data-key-without-plaintext', op: 'GenerateDataKeyWithoutPlaintext', structured: ['encryption-context'],
  run: (c, p) => kms.generateDataKey(c, { KeyId: id(p), KeySpec: p.KeySpec, NumberOfBytes: p.NumberOfBytes !== undefined ? Number(p.NumberOfBytes) : undefined, EncryptionContext: ctxOf(p) }, false),
});
defineCommand({
  service: 'kms', name: 're-encrypt', op: 'ReEncrypt', structured: ['source-encryption-context', 'destination-encryption-context'],
  run: (c, p) => kms.reEncrypt(c, { CiphertextBlob: inBytesB64(p, p.CiphertextBlob, false), DestinationKeyId: p.DestinationKeyId, SourceKeyId: p.SourceKeyId, SourceEncryptionContext: p.SourceEncryptionContext, DestinationEncryptionContext: p.DestinationEncryptionContext }),
});
