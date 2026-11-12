// aws iam (operaciones complementarias)
import { defineCommand } from '../framework';
import * as x from '../../../engine/services/iamExtra';
import { groupShape, userShape } from '../shapes';
import { VFS } from '../../fs';

const iso = (s: string) => s.replace(/\.\d+Z$/, '+00:00');
const TAGS = { list: ['tags'], structured: ['tags'] };
const num = (v: unknown) => (v === undefined ? undefined : Number(v));

defineCommand({
  service: 'iam', name: 'create-login-profile', op: 'CreateLoginProfile', bool: ['password-reset-required'],
  run: (c, p) => {
    const r = x.createLoginProfile(c, { UserName: p.UserName ?? c.caller.userName, Password: String(p.Password ?? ''), PasswordResetRequired: p.PasswordResetRequired });
    return { LoginProfile: { ...r, CreateDate: iso(r.CreateDate) } };
  },
});
defineCommand({
  service: 'iam', name: 'get-login-profile', op: 'GetLoginProfile',
  run: (c, p) => {
    const r = x.getLoginProfile(c, { UserName: p.UserName });
    return { LoginProfile: { ...r, CreateDate: iso(r.CreateDate) } };
  },
});
defineCommand({ service: 'iam', name: 'delete-login-profile', op: 'DeleteLoginProfile', run: (c, p) => void x.deleteLoginProfile(c, { UserName: p.UserName }) });

defineCommand({ service: 'iam', name: 'tag-user', op: 'TagUser', ...TAGS, run: (c, p) => void x.tagUser(c, { UserName: p.UserName, Tags: p.Tags ?? [] }) });
defineCommand({ service: 'iam', name: 'untag-user', op: 'UntagUser', list: ['tag-keys'], run: (c, p) => void x.untagUser(c, { UserName: p.UserName, TagKeys: p.TagKeys ?? [] }) });
defineCommand({ service: 'iam', name: 'list-user-tags', op: 'ListUserTags', run: (c, p) => ({ Tags: x.listUserTags(c, { UserName: p.UserName }) }) });
defineCommand({ service: 'iam', name: 'tag-role', op: 'TagRole', ...TAGS, run: (c, p) => void x.tagRole(c, { RoleName: p.RoleName, Tags: p.Tags ?? [] }) });
defineCommand({ service: 'iam', name: 'untag-role', op: 'UntagRole', list: ['tag-keys'], run: (c, p) => void x.untagRole(c, { RoleName: p.RoleName, TagKeys: p.TagKeys ?? [] }) });
defineCommand({ service: 'iam', name: 'list-role-tags', op: 'ListRoleTags', run: (c, p) => ({ Tags: x.listRoleTags(c, { RoleName: p.RoleName }) }) });

defineCommand({
  service: 'iam', name: 'create-virtual-mfa-device', op: 'CreateVirtualMFADevice',
  run: (c, p, sh) => {
    const r = x.createVirtualMfaDevice(c, { VirtualMFADeviceName: p.VirtualMfaDeviceName, Path: p.Path });
    if (p.Outfile) {
      const bootstrap = p.BootstrapMethod ?? 'QRCodePNG';
      sh.fs.writeFile(VFS.norm(String(p.Outfile), sh.cwd), bootstrap === 'Base32StringSeed' ? r.Base32StringSeed : '\u0089PNG (código QR simulado)');
    }
    return { VirtualMFADevice: { SerialNumber: r.SerialNumber } };
  },
});
defineCommand({
  service: 'iam', name: 'list-virtual-mfa-devices', op: 'ListVirtualMFADevices',
  run: (c) => ({ VirtualMFADevices: x.listVirtualMfaDevices(c).map((d: any) => (d.User ? { SerialNumber: d.SerialNumber, User: userShape(d.User), EnableDate: iso(d.EnableDate) } : { SerialNumber: d.SerialNumber })) }),
});
defineCommand({ service: 'iam', name: 'list-mfa-devices', op: 'ListMFADevices', run: (c, p) => ({ MFADevices: x.listMfaDevices(c, { UserName: p.UserName }).map((d) => ({ ...d, EnableDate: iso(d.EnableDate) })) }) });
defineCommand({ service: 'iam', name: 'deactivate-mfa-device', op: 'DeactivateMFADevice', run: (c, p) => void x.deactivateMfaDevice(c, { UserName: p.UserName, SerialNumber: p.SerialNumber }) });
defineCommand({ service: 'iam', name: 'delete-virtual-mfa-device', op: 'DeleteVirtualMFADevice', run: (c, p) => void x.deleteVirtualMfaDevice(c, { SerialNumber: p.SerialNumber }) });

defineCommand({ service: 'iam', name: 'create-account-alias', op: 'CreateAccountAlias', run: (c, p) => void x.createAccountAlias(c, { AccountAlias: p.AccountAlias }) });
defineCommand({ service: 'iam', name: 'list-account-aliases', op: 'ListAccountAliases', run: (c) => ({ AccountAliases: x.listAccountAliases(c) }) });
defineCommand({ service: 'iam', name: 'delete-account-alias', op: 'DeleteAccountAlias', run: (c, p) => void x.deleteAccountAlias(c, { AccountAlias: p.AccountAlias }) });

defineCommand({
  service: 'iam', name: 'get-account-password-policy', op: 'GetAccountPasswordPolicy',
  run: (c) => {
    const { HardExpiry, ...r } = x.getAccountPasswordPolicy(c);
    return { PasswordPolicy: { ...r, ...(HardExpiry !== undefined ? { HardExpiry } : {}) } };
  },
});
defineCommand({
  service: 'iam', name: 'update-account-password-policy', op: 'UpdateAccountPasswordPolicy',
  bool: ['require-symbols', 'require-numbers', 'require-uppercase-characters', 'require-lowercase-characters', 'allow-users-to-change-password', 'hard-expiry'],
  run: (c, p) =>
    void x.updateAccountPasswordPolicy(c, {
      MinimumPasswordLength: num(p.MinimumPasswordLength), RequireSymbols: p.RequireSymbols, RequireNumbers: p.RequireNumbers,
      RequireUppercaseCharacters: p.RequireUppercaseCharacters, RequireLowercaseCharacters: p.RequireLowercaseCharacters,
      AllowUsersToChangePassword: p.AllowUsersToChangePassword, MaxPasswordAge: num(p.MaxPasswordAge), PasswordReusePrevention: num(p.PasswordReusePrevention), HardExpiry: p.HardExpiry,
    }),
});
defineCommand({ service: 'iam', name: 'delete-account-password-policy', op: 'DeleteAccountPasswordPolicy', run: (c) => void x.deleteAccountPasswordPolicy(c) });
defineCommand({ service: 'iam', name: 'get-account-summary', op: 'GetAccountSummary', run: (c) => ({ SummaryMap: x.getAccountSummary(c) }) });

defineCommand({ service: 'iam', name: 'list-groups-for-user', op: 'ListGroupsForUser', run: (c, p) => ({ Groups: x.listGroupsForUser(c, { UserName: p.UserName }).map(groupShape) }) });
defineCommand({ service: 'iam', name: 'list-attached-group-policies', op: 'ListAttachedGroupPolicies', run: (c, p) => ({ AttachedPolicies: x.listAttachedGroupPolicies(c, { GroupName: p.GroupName }) }) });
defineCommand({ service: 'iam', name: 'list-entities-for-policy', op: 'ListEntitiesForPolicy', run: (c, p) => x.listEntitiesForPolicy(c, { PolicyArn: p.PolicyArn, EntityFilter: p.EntityFilter }) });

defineCommand({ service: 'iam', name: 'list-role-policies', op: 'ListRolePolicies', run: (c, p) => ({ PolicyNames: x.listRolePolicies(c, { RoleName: p.RoleName }) }) });
defineCommand({ service: 'iam', name: 'list-user-policies', op: 'ListUserPolicies', run: (c, p) => ({ PolicyNames: x.listUserPolicies(c, { UserName: p.UserName }) }) });
defineCommand({ service: 'iam', name: 'get-role-policy', op: 'GetRolePolicy', run: (c, p) => x.getRolePolicy(c, { RoleName: p.RoleName, PolicyName: p.PolicyName }) });
defineCommand({ service: 'iam', name: 'get-user-policy', op: 'GetUserPolicy', run: (c, p) => x.getUserPolicy(c, { UserName: p.UserName, PolicyName: p.PolicyName }) });
defineCommand({ service: 'iam', name: 'delete-role-policy', op: 'DeleteRolePolicy', run: (c, p) => void x.deleteRolePolicy(c, { RoleName: p.RoleName, PolicyName: p.PolicyName }) });
defineCommand({ service: 'iam', name: 'delete-user-policy', op: 'DeleteUserPolicy', run: (c, p) => void x.deleteUserPolicy(c, { UserName: p.UserName, PolicyName: p.PolicyName }) });

defineCommand({
  service: 'iam', name: 'create-policy-version', op: 'CreatePolicyVersion', bool: ['set-as-default'],
  run: (c, p) => {
    const r = x.createPolicyVersion(c, { PolicyArn: p.PolicyArn, PolicyDocument: p.PolicyDocument, SetAsDefault: p.SetAsDefault });
    return { PolicyVersion: { ...r, CreateDate: iso(r.CreateDate) } };
  },
});
defineCommand({ service: 'iam', name: 'list-policy-versions', op: 'ListPolicyVersions', run: (c, p) => ({ Versions: x.listPolicyVersions(c, { PolicyArn: p.PolicyArn }).map((v) => ({ ...v, CreateDate: iso(v.CreateDate) })) }) });
defineCommand({
  service: 'iam', name: 'get-policy-version', op: 'GetPolicyVersion',
  run: (c, p) => {
    const v = x.getPolicyVersion(c, { PolicyArn: p.PolicyArn, VersionId: p.VersionId });
    return { PolicyVersion: { Document: v.Document, VersionId: v.VersionId, IsDefaultVersion: v.IsDefaultVersion, CreateDate: iso(v.CreateDate) } };
  },
});
defineCommand({ service: 'iam', name: 'set-default-policy-version', op: 'SetDefaultPolicyVersion', run: (c, p) => void x.setDefaultPolicyVersion(c, { PolicyArn: p.PolicyArn, VersionId: p.VersionId }) });
defineCommand({ service: 'iam', name: 'delete-policy-version', op: 'DeletePolicyVersion', run: (c, p) => void x.deletePolicyVersion(c, { PolicyArn: p.PolicyArn, VersionId: p.VersionId }) });
