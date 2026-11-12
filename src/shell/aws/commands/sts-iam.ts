// aws sts / aws iam
import { defineCommand } from '../framework';
import * as iam from '../../../engine/services/iam';
import { userShape, groupShape, roleShape, policyShape } from '../shapes';
import { AwsError } from '../../../engine/errors';

const iso = (s: string) => s.replace(/\.\d+Z$/, '+00:00');

defineCommand({ service: 'sts', name: 'get-caller-identity', op: 'GetCallerIdentity', run: (c) => iam.getCallerIdentity(c) });
defineCommand({
  service: 'sts',
  name: 'assume-role',
  op: 'AssumeRole',
  run: (c, p) => {
    const r = iam.assumeRole(c, {
      RoleArn: p.RoleArn,
      RoleSessionName: p.RoleSessionName,
      DurationSeconds: p.DurationSeconds && Number(p.DurationSeconds),
      SerialNumber: p.SerialNumber,
      TokenCode: p.TokenCode,
      Policy: p.Policy,
      ExternalId: p.ExternalId,
    });
    return { ...r, Credentials: { ...r.Credentials, Expiration: iso(r.Credentials.Expiration) } };
  },
});
defineCommand({
  service: 'sts',
  name: 'get-session-token',
  op: 'GetSessionToken',
  run: (c, p) => {
    const r = iam.getSessionToken(c, { SerialNumber: p.SerialNumber, TokenCode: p.TokenCode, DurationSeconds: p.DurationSeconds && Number(p.DurationSeconds) });
    return { Credentials: { ...r.Credentials, Expiration: iso(r.Credentials.Expiration) } };
  },
});

// ---------------------------------------------------------------- usuarios
defineCommand({
  service: 'iam',
  name: 'create-user',
  op: 'CreateUser',
  list: ['tags'],
  structured: ['tags'],
  run: (c, p) => ({ User: userShape(iam.createUser(c, { UserName: p.UserName, Path: p.Path, Tags: p.Tags, PermissionsBoundary: p.PermissionsBoundary })) }),
});
defineCommand({ service: 'iam', name: 'get-user', op: 'GetUser', run: (c, p) => ({ User: userShape(iam.getUser(c, { UserName: p.UserName })) }) });
defineCommand({ service: 'iam', name: 'list-users', op: 'ListUsers', run: (c) => ({ Users: iam.listUsers(c).map(userShape) }) });
defineCommand({ service: 'iam', name: 'delete-user', op: 'DeleteUser', run: (c, p) => void iam.deleteUser(c, { UserName: p.UserName }) });
defineCommand({
  service: 'iam',
  name: 'create-access-key',
  op: 'CreateAccessKey',
  run: (c, p) => {
    const k = iam.createAccessKey(c, { UserName: p.UserName });
    return { AccessKey: { UserName: k.UserName, AccessKeyId: k.id, Status: k.status, SecretAccessKey: k.secret, CreateDate: iso(k.createdAt) } };
  },
});
defineCommand({
  service: 'iam',
  name: 'list-access-keys',
  op: 'ListAccessKeys',
  run: (c, p) => ({ AccessKeyMetadata: iam.listAccessKeys(c, { UserName: p.UserName }).map((k) => ({ ...k, CreateDate: iso(k.CreateDate) })) }),
});
defineCommand({ service: 'iam', name: 'update-access-key', op: 'UpdateAccessKey', run: (c, p) => void iam.updateAccessKey(c, { UserName: p.UserName, AccessKeyId: p.AccessKeyId, Status: p.Status }) });
defineCommand({ service: 'iam', name: 'delete-access-key', op: 'DeleteAccessKey', run: (c, p) => void iam.deleteAccessKey(c, { UserName: p.UserName, AccessKeyId: p.AccessKeyId }) });
defineCommand({ service: 'iam', name: 'enable-mfa-device', op: 'EnableMFADevice', run: (c, p) => void iam.enableMfa(c, { UserName: p.UserName, SerialNumber: p.SerialNumber }) });

// ---------------------------------------------------------------- grupos
defineCommand({ service: 'iam', name: 'create-group', op: 'CreateGroup', run: (c, p) => ({ Group: groupShape(iam.createGroup(c, { GroupName: p.GroupName, Path: p.Path })) }) });
defineCommand({ service: 'iam', name: 'list-groups', op: 'ListGroups', run: (c) => ({ Groups: iam.listGroups(c).map(groupShape) }) });
defineCommand({ service: 'iam', name: 'add-user-to-group', op: 'AddUserToGroup', run: (c, p) => void iam.addUserToGroup(c, { GroupName: p.GroupName, UserName: p.UserName }) });
defineCommand({ service: 'iam', name: 'remove-user-from-group', op: 'RemoveUserFromGroup', run: (c, p) => void iam.removeUserFromGroup(c, { GroupName: p.GroupName, UserName: p.UserName }) });

// ---------------------------------------------------------------- políticas
defineCommand({
  service: 'iam',
  name: 'create-policy',
  op: 'CreatePolicy',
  run: (c, p) => ({ Policy: policyShape(iam.createPolicy(c, { PolicyName: p.PolicyName, PolicyDocument: p.PolicyDocument, Path: p.Path, Description: p.Description })) }),
});
defineCommand({ service: 'iam', name: 'get-policy', op: 'GetPolicy', run: (c, p) => ({ Policy: policyShape(iam.getPolicy(c, { PolicyArn: p.PolicyArn })) }) });
defineCommand({
  service: 'iam',
  name: 'list-policies',
  op: 'ListPolicies',
  bool: ['only-attached'],
  run: (c, p) => ({ Policies: iam.listPolicies(c, { Scope: p.Scope, OnlyAttached: p.OnlyAttached }).map(policyShape) }),
});
defineCommand({ service: 'iam', name: 'delete-policy', op: 'DeletePolicy', run: (c, p) => void iam.deletePolicy(c, { PolicyArn: p.PolicyArn }) });
defineCommand({ service: 'iam', name: 'attach-user-policy', op: 'AttachUserPolicy', run: (c, p) => void iam.attachUserPolicy(c, { UserName: p.UserName, PolicyArn: p.PolicyArn }) });
defineCommand({ service: 'iam', name: 'detach-user-policy', op: 'DetachUserPolicy', run: (c, p) => void iam.detachUserPolicy(c, { UserName: p.UserName, PolicyArn: p.PolicyArn }) });
defineCommand({ service: 'iam', name: 'attach-group-policy', op: 'AttachGroupPolicy', run: (c, p) => void iam.attachGroupPolicy(c, { GroupName: p.GroupName, PolicyArn: p.PolicyArn }) });
defineCommand({ service: 'iam', name: 'detach-group-policy', op: 'DetachGroupPolicy', run: (c, p) => void iam.detachGroupPolicy(c, { GroupName: p.GroupName, PolicyArn: p.PolicyArn }) });
defineCommand({ service: 'iam', name: 'delete-group', op: 'DeleteGroup', run: (c, p) => void iam.deleteGroup(c, { GroupName: p.GroupName }) });
defineCommand({ service: 'iam', name: 'attach-role-policy', op: 'AttachRolePolicy', run: (c, p) => void iam.attachRolePolicy(c, { RoleName: p.RoleName, PolicyArn: p.PolicyArn }) });
defineCommand({ service: 'iam', name: 'detach-role-policy', op: 'DetachRolePolicy', run: (c, p) => void iam.detachRolePolicy(c, { RoleName: p.RoleName, PolicyArn: p.PolicyArn }) });
defineCommand({ service: 'iam', name: 'put-user-policy', op: 'PutUserPolicy', run: (c, p) => void iam.putUserPolicy(c, { UserName: p.UserName, PolicyName: p.PolicyName, PolicyDocument: p.PolicyDocument }) });
defineCommand({ service: 'iam', name: 'put-role-policy', op: 'PutRolePolicy', run: (c, p) => void iam.putRolePolicy(c, { RoleName: p.RoleName, PolicyName: p.PolicyName, PolicyDocument: p.PolicyDocument }) });
defineCommand({ service: 'iam', name: 'list-attached-user-policies', op: 'ListAttachedUserPolicies', run: (c, p) => ({ AttachedPolicies: iam.listAttachedUserPolicies(c, { UserName: p.UserName }) }) });
defineCommand({ service: 'iam', name: 'list-attached-role-policies', op: 'ListAttachedRolePolicies', run: (c, p) => ({ AttachedPolicies: iam.listAttachedRolePolicies(c, { RoleName: p.RoleName }) }) });

// ---------------------------------------------------------------- roles
defineCommand({
  service: 'iam',
  name: 'create-role',
  op: 'CreateRole',
  list: ['tags'],
  structured: ['tags'],
  run: (c, p) => ({
    Role: roleShape(
      iam.createRole(c, {
        RoleName: p.RoleName,
        AssumeRolePolicyDocument: p.AssumeRolePolicyDocument,
        Path: p.Path,
        Description: p.Description,
        MaxSessionDuration: p.MaxSessionDuration && Number(p.MaxSessionDuration),
        Tags: p.Tags,
      }),
    ),
  }),
});
defineCommand({ service: 'iam', name: 'get-role', op: 'GetRole', run: (c, p) => ({ Role: roleShape(iam.getRole(c, { RoleName: p.RoleName })) }) });
defineCommand({ service: 'iam', name: 'list-roles', op: 'ListRoles', run: (c) => ({ Roles: iam.listRoles(c).map(roleShape) }) });
defineCommand({ service: 'iam', name: 'update-assume-role-policy', op: 'UpdateAssumeRolePolicy', run: (c, p) => void iam.updateAssumeRolePolicy(c, { RoleName: p.RoleName, PolicyDocument: p.PolicyDocument }) });
defineCommand({ service: 'iam', name: 'delete-role', op: 'DeleteRole', run: (c, p) => void iam.deleteRole(c, { RoleName: p.RoleName }) });
defineCommand({
  service: 'iam',
  name: 'create-instance-profile',
  op: 'CreateInstanceProfile',
  run: (c, p) => {
    const ip = iam.createInstanceProfile(c, { InstanceProfileName: p.InstanceProfileName });
    return { InstanceProfile: { Path: '/', InstanceProfileName: ip.name, InstanceProfileId: ip.id, Arn: ip.arn, CreateDate: iso(ip.createdAt), Roles: [] } };
  },
});
defineCommand({ service: 'iam', name: 'add-role-to-instance-profile', op: 'AddRoleToInstanceProfile', run: (c, p) => void iam.addRoleToInstanceProfile(c, { InstanceProfileName: p.InstanceProfileName, RoleName: p.RoleName }) });
defineCommand({
  service: 'iam',
  name: 'simulate-principal-policy',
  op: 'SimulatePrincipalPolicy',
  list: ['action-names', 'resource-arns'],
  run: (c, p) => ({ EvaluationResults: iam.simulatePrincipalPolicy(c, { PolicySourceArn: p.PolicySourceArn, ActionNames: p.ActionNames, ResourceArns: p.ResourceArns }) }),
});
