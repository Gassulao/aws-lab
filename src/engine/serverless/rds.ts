// Amazon RDS: instancias MySQL, MariaDB y PostgreSQL con ciclo de vida (creating → available), grupos de subredes,
// grupos de seguridad de VPC, instantáneas, restauración, réplicas de lectura, Multi-AZ y conmutación por error simulada.
import { AwsError } from '../errors';
import { trailed, type Ctx } from '../api';
import type { CloudState } from '../types';
import { hex, now, randomString } from '../util';
import { speedFactor } from '../store';
import { ensureDefaultVpc } from '../services/ec2';
import { awsManagedKey, getKmsKeyOrNullImpl } from '../services/kms';
import { sv, type RdsInstance, type RdsSnapshot, type RdsSubnetGroup } from './types';
import { svAuthorize, asArr } from './util';

const SRC = 'rds.amazonaws.com';
const ENGINES: Record<string, { versions: string[]; port: number; defaultDb?: string }> = {
  mysql: { versions: ['8.0.35', '8.0.36', '8.0.39', '8.4.3'], port: 3306 },
  mariadb: { versions: ['10.6.18', '10.11.8', '11.4.3'], port: 3306 },
  postgres: { versions: ['14.12', '15.7', '15.8', '16.3', '16.4'], port: 5432, defaultDb: 'postgres' },
};
const arnDb = (ctx: Ctx, id: string) => `arn:aws:rds:${ctx.region}:${ctx.s.account.id}:db:${id}`;
const arnSub = (ctx: Ctx, n: string) => `arn:aws:rds:${ctx.region}:${ctx.s.account.id}:subgrp:${n}`;
const arnSnap = (ctx: Ctx, n: string) => `arn:aws:rds:${ctx.region}:${ctx.s.account.id}:snapshot:${n}`;
const auth = (ctx: Ctx, action: string, resource: string) => svAuthorize(ctx, action, resource, 'query');
const inval = (m: string) => new AwsError('InvalidParameterValue', m, 400);
const combo = (m: string) => new AwsError('InvalidParameterCombination', m, 400);
const scaled = (ms: number) => Math.round(ms * speedFactor());

// ------------------------------------------------------------------ paso del tiempo

export function rdsStatus(i: RdsInstance): string {
  if (i.transient && now() < i.transient.until) return i.transient.status;
  return i.stopped ? 'stopped' : i.readyAt > now() ? 'creating' : 'available';
}
const ev = (s: CloudState, region: string, id: string, message: string, type = 'db-instance') => {
  const list = sv(s).rdsEvents; list.push({ ts: now(), sourceId: id, sourceType: type, message, region });
  if (list.length > 300) list.splice(0, list.length - 200);
};

/** Aplica las transiciones vencidas (reinicios, modificaciones, conmutaciones, borrados). */
export function settleRds(s: CloudState) {
  const t = now();
  const st = sv(s);
  for (const i of [...st.rdsInstances]) {
    if (i.readyAt <= t && !i.stopped && !i.transient && !(i as any)._ready) { (i as any)._ready = true; ev(s, i.region, i.id, 'DB instance created'); ev(s, i.region, i.id, 'DB instance restarted'); }
    const tr = i.transient;
    if (!tr || t < tr.until) continue;
    i.transient = undefined;
    if (tr.status === 'deleting') { st.rdsInstances = st.rdsInstances.filter((x) => x !== i); ev(s, i.region, i.id, 'DB instance deleted'); continue; }
    if (tr.apply) Object.assign(i, tr.apply);
    if (tr.after === 'failover' && i.secondaryAz) { [i.az, i.secondaryAz] = [i.secondaryAz, i.az]; ev(s, i.region, i.id, 'Multi-AZ instance failover completed'); }
    if (tr.status === 'stopping') { i.stopped = true; ev(s, i.region, i.id, 'DB instance stopped'); }
    else if (tr.status === 'starting') { i.stopped = false; ev(s, i.region, i.id, 'DB instance started'); }
    else if (tr.status === 'rebooting') ev(s, i.region, i.id, 'DB instance restarted');
    else if (tr.status === 'modifying') ev(s, i.region, i.id, 'Finished applying modification to DB instance');
  }
}

// ------------------------------------------------------------------ subredes

export function allSubnetGroups(ctx: Ctx): RdsSubnetGroup[] {
  const list = sv(ctx.s).rdsSubnetGroups.filter((g) => g.region === ctx.region);
  const def = ctx.s.vpcs.find((v) => v.isDefault && v.region === ctx.region);
  if (def && !list.some((g) => g.name === 'default')) {
    const subs = ctx.s.subnets.filter((x) => x.vpcId === def.id).map((x) => x.id);
    list.unshift({ name: 'default', arn: arnSub(ctx, 'default'), description: 'default', vpcId: def.id, subnetIds: subs, region: ctx.region });
  }
  return list;
}
const groupOr = (ctx: Ctx, name: string) => {
  const g = allSubnetGroups(ctx).find((x) => x.name === name);
  if (!g) throw new AwsError('DBSubnetGroupNotFoundFault', `DBSubnetGroup '${name}' not found.`, 404);
  return g;
};
export const subnetGroupAzs = (s: CloudState, g: RdsSubnetGroup) => [...new Set(g.subnetIds.map((id) => s.subnets.find((x) => x.id === id)?.az).filter(Boolean) as string[])];

function checkSubnets(ctx: Ctx, ids: string[]): { vpcId: string } {
  if (!ids.length) throw inval('The parameter SubnetIds must be provided and must not be blank.'.replace('SubnetIds must be provided and must not be blank.', 'SubnetIds is not valid'));
  const subs = ids.map((id) => { const x = ctx.s.subnets.find((y) => y.id === id && y.region === ctx.region); if (!x) throw new AwsError('InvalidSubnet', `The requested subnet ${id} could not be found.`.replace('The requested subnet ' + id + ' could not be found.', `Subnet ${id} not found.`).replace(/^/, ''), 400); return x; });
  if (new Set(subs.map((x) => x.vpcId)).size > 1) throw new AwsError('InvalidSubnet', 'Invalid subnets: the subnets must belong to the same VPC.'.replace('Invalid subnets: the subnets must belong to the same VPC.', 'Some of the subnets are in different VPCs. All subnets in a DB subnet group must be in the same VPC.'), 400);
  const azs = new Set(subs.map((x) => x.az));
  if (azs.size < 2) throw new AwsError('DBSubnetGroupDoesNotCoverEnoughAZs', `The DB subnet group doesn't meet Availability Zone (AZ) coverage requirement. Current AZ coverage: ${[...azs].join(',')}. Add subnets to cover at least 2 AZs.`, 400);
  return { vpcId: subs[0].vpcId };
}
export function createDbSubnetGroup(ctx: Ctx, p: { DBSubnetGroupName: string; DBSubnetGroupDescription: string; SubnetIds: string[] }): RdsSubnetGroup {
  return trailed(ctx, SRC, 'CreateDBSubnetGroup', [{ type: 'AWS::RDS::DBSubnetGroup', name: p.DBSubnetGroupName }], { dBSubnetGroupName: p.DBSubnetGroupName, subnetIds: p.SubnetIds }, () => {
    const name = (p.DBSubnetGroupName ?? '').toLowerCase();
    auth(ctx, 'rds:CreateDBSubnetGroup', arnSub(ctx, name));
    if (!/^[a-z0-9._ -]{1,255}$/.test(name)) throw inval('The parameter DBSubnetGroupName is not a valid identifier. Identifiers must begin with a letter; must contain only ASCII letters, digits, and hyphens; and must not end with a hyphen or contain two consecutive hyphens.'.replace(/^.*$/, 'The parameter DBSubnetGroupName must be provided and must not be blank. Only letters, numbers, periods, underscores, spaces and hyphens are allowed.'));
    if (name === 'default') throw inval('The DB subnet group name "default" is reserved.'.replace('The DB subnet group name "default" is reserved.', 'DBSubnetGroupName default is reserved'));
    if (sv(ctx.s).rdsSubnetGroups.some((g) => g.name === name && g.region === ctx.region)) throw new AwsError('DBSubnetGroupAlreadyExists', `The DB subnet group '${name}' already exists.`, 400);
    const { vpcId } = checkSubnets(ctx, asArr(p.SubnetIds));
    const g: RdsSubnetGroup = { name, arn: arnSub(ctx, name), description: p.DBSubnetGroupDescription ?? '', vpcId, subnetIds: asArr(p.SubnetIds), region: ctx.region };
    sv(ctx.s).rdsSubnetGroups.push(g);
    return g;
  });
}
export function describeDbSubnetGroups(ctx: Ctx, p: { DBSubnetGroupName?: string }): RdsSubnetGroup[] {
  return trailed(ctx, SRC, 'DescribeDBSubnetGroups', [], p, () => {
    auth(ctx, 'rds:DescribeDBSubnetGroups', arnSub(ctx, p.DBSubnetGroupName ?? '*'));
    if (p.DBSubnetGroupName) return [groupOr(ctx, p.DBSubnetGroupName.toLowerCase())];
    return allSubnetGroups(ctx);
  });
}
export function modifyDbSubnetGroup(ctx: Ctx, p: { DBSubnetGroupName: string; SubnetIds: string[]; DBSubnetGroupDescription?: string }): RdsSubnetGroup {
  return trailed(ctx, SRC, 'ModifyDBSubnetGroup', [], p, () => {
    auth(ctx, 'rds:ModifyDBSubnetGroup', arnSub(ctx, p.DBSubnetGroupName));
    const g = sv(ctx.s).rdsSubnetGroups.find((x) => x.name === p.DBSubnetGroupName.toLowerCase() && x.region === ctx.region);
    if (!g) throw new AwsError('DBSubnetGroupNotFoundFault', `DBSubnetGroup '${p.DBSubnetGroupName}' not found.`, 404);
    const { vpcId } = checkSubnets(ctx, asArr(p.SubnetIds));
    g.subnetIds = asArr(p.SubnetIds); g.vpcId = vpcId;
    if (p.DBSubnetGroupDescription !== undefined) g.description = p.DBSubnetGroupDescription;
    return g;
  });
}
export function deleteDbSubnetGroup(ctx: Ctx, p: { DBSubnetGroupName: string }): void {
  trailed(ctx, SRC, 'DeleteDBSubnetGroup', [], p, () => {
    auth(ctx, 'rds:DeleteDBSubnetGroup', arnSub(ctx, p.DBSubnetGroupName));
    const g = sv(ctx.s).rdsSubnetGroups.find((x) => x.name === p.DBSubnetGroupName.toLowerCase() && x.region === ctx.region);
    if (!g) throw new AwsError('DBSubnetGroupNotFoundFault', `DBSubnetGroup '${p.DBSubnetGroupName}' not found.`, 404);
    const users = sv(ctx.s).rdsInstances.filter((i) => i.subnetGroup === g.name && i.region === ctx.region);
    if (users.length) throw new AwsError('InvalidDBSubnetGroupStateFault', `Cannot delete the subnet group '${g.name}' because at least one database instance: ${users[0].id} is still using it.`, 400);
    sv(ctx.s).rdsSubnetGroups = sv(ctx.s).rdsSubnetGroups.filter((x) => x !== g);
  });
}

// ------------------------------------------------------------------ instancias

function instOr(ctx: Ctx, id: string): RdsInstance {
  settleRds(ctx.s);
  const i = sv(ctx.s).rdsInstances.find((x) => x.id === (id ?? '').toLowerCase() && x.region === ctx.region);
  if (!i) throw new AwsError('DBInstanceNotFound', `DBInstance ${id} not found.`, 404);
  return i;
}
const needAvailable = (i: RdsInstance) => { if (rdsStatus(i) !== 'available') throw new AwsError('InvalidDBInstanceState', `Instance ${i.id} is not in available state.`, 400); };

function validateCommon(ctx: Ctx, engine: string, p: { MasterUserPassword?: string; AllocatedStorage?: number; DBInstanceClass?: string; BackupRetentionPeriod?: number }, storageType: string) {
  if (p.DBInstanceClass !== undefined && !/^db\.[a-z0-9]+\.[a-z0-9]+$/.test(p.DBInstanceClass)) throw inval(`Invalid DB Instance class: ${p.DBInstanceClass}`);
  if (p.MasterUserPassword !== undefined) {
    if (p.MasterUserPassword.length < 8) throw inval('The parameter MasterUserPassword is not a valid password because it is shorter than 8 characters.');
    if (/[/@" ]/.test(p.MasterUserPassword)) throw inval("The parameter MasterUserPassword is not a valid password. Only printable ASCII characters besides '/', '@', '\"', ' ' may be used.");
  }
  if (p.AllocatedStorage !== undefined) {
    const n = Number(p.AllocatedStorage);
    if (!Number.isInteger(n) || n < 20 || n > 65536) throw inval(`Invalid storage size for engine name ${engine} and storage type ${storageType}: ${p.AllocatedStorage}`);
  }
  if (p.BackupRetentionPeriod !== undefined && (p.BackupRetentionPeriod < 0 || p.BackupRetentionPeriod > 35)) throw inval(`Invalid backup retention period: ${p.BackupRetentionPeriod}. Must be between 0 and 35.`.replace(/^.*$/, `Invalid backup retention period. Must be between 0 and 35.`));
  void ctx;
}

export interface CreateDbP {
  DBInstanceIdentifier: string; DBInstanceClass: string; Engine: string; EngineVersion?: string; MasterUsername?: string; MasterUserPassword?: string; AllocatedStorage?: number; DBName?: string;
  VpcSecurityGroupIds?: string[]; DBSubnetGroupName?: string; MultiAZ?: boolean; PubliclyAccessible?: boolean; StorageEncrypted?: boolean; KmsKeyId?: string; BackupRetentionPeriod?: number;
  Port?: number; DeletionProtection?: boolean; StorageType?: string; Tags?: { Key: string; Value: string }[]; AvailabilityZone?: string;
}

function placement(ctx: Ctx, g: RdsSubnetGroup, multi: boolean, az?: string) {
  const azs = subnetGroupAzs(ctx.s, g).sort();
  if (az && !azs.includes(az)) throw inval(`Availability zone ${az} is not part of the DB subnet group ${g.name}.`.replace(/^.*$/, `Invalid availability zone: ${az}. Supported availability zones are: ${azs.join(', ')}`));
  const primary = az ?? azs[0];
  return { az: primary, secondaryAz: multi ? azs.find((x) => x !== primary) : undefined };
}

export function createDbInstance(ctx: Ctx, p: CreateDbP): RdsInstance {
  return trailed(ctx, SRC, 'CreateDBInstance', [{ type: 'AWS::RDS::DBInstance', name: p.DBInstanceIdentifier }], { dBInstanceIdentifier: p.DBInstanceIdentifier, dBInstanceClass: p.DBInstanceClass, engine: p.Engine, multiAZ: p.MultiAZ, masterUsername: p.MasterUsername }, () => {
    settleRds(ctx.s);
    const id = (p.DBInstanceIdentifier ?? '').toLowerCase();
    auth(ctx, 'rds:CreateDBInstance', arnDb(ctx, id));
    if (!/^[a-zA-Z][a-zA-Z0-9]*(-[a-zA-Z0-9]+)*$/.test(p.DBInstanceIdentifier ?? '') || p.DBInstanceIdentifier.length > 63) throw inval('The parameter DBInstanceIdentifier is not a valid identifier. Identifiers must begin with a letter; must contain only ASCII letters, digits, and hyphens; and must not end with a hyphen or contain two consecutive hyphens.');
    const eng = ENGINES[p.Engine];
    if (!eng) throw inval(`Invalid DB engine`);
    if (!p.DBInstanceClass) throw new AwsError('MissingParameter', 'The request must contain the parameter DBInstanceClass.'.replace(/^.*$/, 'The parameter DBInstanceClass must be provided and must not be blank.'), 400);
    const storageType = p.StorageType ?? 'gp2';
    if (!['gp2', 'gp3', 'io1', 'standard'].includes(storageType)) throw inval(`Invalid storage type: ${storageType}`);
    validateCommon(ctx, p.Engine, p, storageType);
    if (p.AllocatedStorage === undefined) throw combo(`The parameter AllocatedStorage must be provided and must not be blank for engine '${p.Engine}'`.replace(/^.*$/, `The parameter AllocatedStorage must be provided and must not be blank for engine ${p.Engine}`));
    if (!p.MasterUsername) throw combo('The parameter MasterUsername must be provided and must not be blank.');
    if (!p.MasterUserPassword) throw combo('The parameter MasterUserPassword must be provided and must not be blank.'.replace(/^.*$/, 'The parameter MasterUserPassword must be provided and must not be blank.'));
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,15}$/.test(p.MasterUsername)) throw inval(`The parameter MasterUsername is not a valid identifier. Identifiers must begin with a letter and must contain only ASCII letters, digits, and underscores.`.replace(/^.*$/, `MasterUsername ${p.MasterUsername} is not valid. It must begin with a letter, contain only letters, digits and underscores, and be at most 16 characters long.`));
    if (p.Engine === 'postgres' && ['admin', 'rdsadmin'].includes(p.MasterUsername.toLowerCase())) throw inval(`MasterUsername ${p.MasterUsername} cannot be used as it is a reserved word used by the engine`);
    if (p.Engine !== 'postgres' && ['rdsadmin', 'root'].includes(p.MasterUsername.toLowerCase()) && p.MasterUsername.toLowerCase() === 'rdsadmin') throw inval(`MasterUsername ${p.MasterUsername} cannot be used as it is a reserved word used by the engine`);
    if (sv(ctx.s).rdsInstances.some((x) => x.id === id && x.region === ctx.region)) throw new AwsError('DBInstanceAlreadyExists', `DB instance already exists`, 400);
    const version = p.EngineVersion ?? eng.versions[eng.versions.length - 2] ?? eng.versions[0];
    if (!eng.versions.includes(version)) throw new AwsError('InvalidParameterCombination', `Cannot find version ${version} for ${p.Engine}`, 400);
    ensureDefaultVpc(ctx.s, ctx.region);
    const gName = (p.DBSubnetGroupName ?? 'default').toLowerCase();
    const g = groupOr(ctx, gName);
    if (p.MultiAZ && p.AvailabilityZone) throw combo('Requesting a specific availability zone is not valid for Multi-AZ instances.');
    const sgIds = asArr(p.VpcSecurityGroupIds).length ? asArr(p.VpcSecurityGroupIds) : [ctx.s.vpcs.find((v) => v.id === g.vpcId)!.defaultSecurityGroupId];
    for (const sgId of sgIds) {
      const sg = ctx.s.securityGroups.find((x) => x.id === sgId && x.region === ctx.region);
      if (!sg) throw new AwsError('InvalidParameterValue', `The security group '${sgId}' does not exist`.replace(/^.*$/, `VPC security group ${sgId} does not exist`).replace(/^/, ''), 400);
      if (sg.vpcId !== g.vpcId) throw combo(`The DB instance and EC2 security group are in different VPCs. The DB instance is in ${g.vpcId} and the EC2 security group is in ${sg.vpcId}`);
    }
    let kms: string | undefined;
    if (p.StorageEncrypted || p.KmsKeyId) {
      if (p.KmsKeyId) { const k = getKmsKeyOrNullImpl(ctx, p.KmsKeyId); if (!k) throw new AwsError('KMSKeyNotAccessibleFault', `The specified KMS key [${p.KmsKeyId}] does not exist, is not enabled or you do not have permissions to access it.`, 400); kms = k.arn; }
      else kms = awsManagedKey(ctx, 'rds').arn;
    }
    const place = placement(ctx, g, !!p.MultiAZ, p.AvailabilityZone);
    const defVpc = ctx.s.vpcs.find((v) => v.id === g.vpcId)?.isDefault;
    const t = now();
    const inst: RdsInstance = {
      id, arn: arnDb(ctx, id), region: ctx.region, engine: p.Engine, engineVersion: version, cls: p.DBInstanceClass, allocatedStorage: Number(p.AllocatedStorage), storageType, masterUser: p.MasterUsername,
      dbName: p.DBName ?? eng.defaultDb, port: Number(p.Port ?? eng.port), createdAt: t, readyAt: t + scaled(p.MultiAZ ? 90_000 : 60_000), multiAz: !!p.MultiAZ, publiclyAccessible: p.PubliclyAccessible ?? !!defVpc,
      subnetGroup: g.name, vpcId: g.vpcId, sgIds, az: place.az, secondaryAz: place.secondaryAz, encrypted: !!kms, kmsKeyId: kms, backupRetention: p.BackupRetentionPeriod ?? 1, deletionProtection: !!p.DeletionProtection,
      endpoint: `${id}.${randomString(12)}.${ctx.region}.rds.amazonaws.com`, dbiResourceId: 'db-' + randomString(26).toUpperCase(), tags: Object.fromEntries(asArr(p.Tags).map((x) => [x.Key, x.Value])), parameterGroup: `default.${p.Engine}${version.split('.').slice(0, p.Engine === 'postgres' && Number(version.split('.')[0]) >= 10 ? 1 : 2).join('.')}`,
    };
    sv(ctx.s).rdsInstances.push(inst);
    ev(ctx.s, ctx.region, id, 'Creating DB instance');
    return inst;
  });
}

export function describeDbInstances(ctx: Ctx, p: { DBInstanceIdentifier?: string }): RdsInstance[] {
  return trailed(ctx, SRC, 'DescribeDBInstances', [], p, () => {
    auth(ctx, 'rds:DescribeDBInstances', arnDb(ctx, p.DBInstanceIdentifier ?? '*'));
    settleRds(ctx.s);
    if (p.DBInstanceIdentifier) return [instOr(ctx, p.DBInstanceIdentifier)];
    return sv(ctx.s).rdsInstances.filter((i) => i.region === ctx.region);
  });
}

export function modifyDbInstance(ctx: Ctx, p: { DBInstanceIdentifier: string; DBInstanceClass?: string; AllocatedStorage?: number; MultiAZ?: boolean; BackupRetentionPeriod?: number; VpcSecurityGroupIds?: string[]; PubliclyAccessible?: boolean; DeletionProtection?: boolean; ApplyImmediately?: boolean; MasterUserPassword?: string; EngineVersion?: string; StorageType?: string }): RdsInstance {
  return trailed(ctx, SRC, 'ModifyDBInstance', [{ type: 'AWS::RDS::DBInstance', name: p.DBInstanceIdentifier }], { dBInstanceIdentifier: p.DBInstanceIdentifier, multiAZ: p.MultiAZ, dBInstanceClass: p.DBInstanceClass, applyImmediately: p.ApplyImmediately }, () => {
    const i = instOr(ctx, p.DBInstanceIdentifier);
    auth(ctx, 'rds:ModifyDBInstance', i.arn);
    needAvailable(i);
    validateCommon(ctx, i.engine, p, p.StorageType ?? i.storageType);
    if (p.AllocatedStorage !== undefined && Number(p.AllocatedStorage) < i.allocatedStorage) throw combo(`Invalid storage size for engine name ${i.engine} and storage type ${i.storageType}: ${p.AllocatedStorage}`.replace(/^.*$/, `Cannot decrease allocated storage: the new size (${p.AllocatedStorage} GiB) is smaller than the current size (${i.allocatedStorage} GiB)`));
    const immediate: Partial<RdsInstance> = {}, deferred: Partial<RdsInstance> = {};
    if (p.DeletionProtection !== undefined) immediate.deletionProtection = p.DeletionProtection;
    if (p.BackupRetentionPeriod !== undefined) immediate.backupRetention = Number(p.BackupRetentionPeriod);
    if (p.PubliclyAccessible !== undefined) immediate.publiclyAccessible = p.PubliclyAccessible;
    if (p.VpcSecurityGroupIds) {
      for (const id of p.VpcSecurityGroupIds) { const sg = ctx.s.securityGroups.find((x) => x.id === id); if (!sg) throw inval(`VPC security group ${id} does not exist`); if (sg.vpcId !== i.vpcId) throw combo(`The DB instance and EC2 security group are in different VPCs. The DB instance is in ${i.vpcId} and the EC2 security group is in ${sg.vpcId}`); }
      immediate.sgIds = asArr(p.VpcSecurityGroupIds);
    }
    if (p.DBInstanceClass !== undefined && p.DBInstanceClass !== i.cls) deferred.cls = p.DBInstanceClass;
    if (p.AllocatedStorage !== undefined && Number(p.AllocatedStorage) !== i.allocatedStorage) deferred.allocatedStorage = Number(p.AllocatedStorage);
    if (p.EngineVersion !== undefined && p.EngineVersion !== i.engineVersion) { if (!ENGINES[i.engine].versions.includes(p.EngineVersion)) throw combo(`Cannot find version ${p.EngineVersion} for ${i.engine}`); deferred.engineVersion = p.EngineVersion; }
    if (p.StorageType !== undefined) deferred.storageType = p.StorageType;
    if (p.MultiAZ !== undefined && p.MultiAZ !== i.multiAz) {
      deferred.multiAz = p.MultiAZ;
      if (p.MultiAZ) { const g = groupOr(ctx, i.subnetGroup); deferred.secondaryAz = subnetGroupAzs(ctx.s, g).find((x) => x !== i.az); }
      else deferred.secondaryAz = undefined;
    }
    Object.assign(i, immediate);
    i.pendingValues = { ...(i.pendingValues ?? {}), ...deferred };
    if (p.ApplyImmediately && Object.keys(i.pendingValues).length) {
      const apply = i.pendingValues; i.pendingValues = undefined;
      i.transient = { status: 'modifying', until: now() + scaled(Object.keys(apply).includes('multiAz') ? 45_000 : 25_000), apply };
      ev(ctx.s, i.region, i.id, 'Applying modification to database instance class'.replace('database instance class', 'DB instance'));
    } else if (Object.keys(immediate).length) { ev(ctx.s, i.region, i.id, 'Applying modification to DB instance'); }
    return i;
  });
}

export function rebootDbInstance(ctx: Ctx, p: { DBInstanceIdentifier: string; ForceFailover?: boolean }): RdsInstance {
  return trailed(ctx, SRC, 'RebootDBInstance', [{ type: 'AWS::RDS::DBInstance', name: p.DBInstanceIdentifier }], { dBInstanceIdentifier: p.DBInstanceIdentifier, forceFailover: p.ForceFailover }, () => {
    const i = instOr(ctx, p.DBInstanceIdentifier);
    auth(ctx, 'rds:RebootDBInstance', i.arn);
    needAvailable(i);
    if (p.ForceFailover && !i.multiAz) throw combo('Cannot failover a Single-AZ instance.'.replace(/^.*$/, 'Cannot force a failover for a Single-AZ DB instance. Use Multi-AZ or reboot without ForceFailover.'));
    const fo = !!p.ForceFailover;
    i.transient = { status: 'rebooting', until: now() + scaled(fo ? 30_000 : 12_000), after: fo ? 'failover' : undefined };
    ev(ctx.s, i.region, i.id, fo ? 'Multi-AZ instance failover started.' : 'DB instance shutdown');
    return i;
  });
}
export function stopDbInstance(ctx: Ctx, p: { DBInstanceIdentifier: string }): RdsInstance {
  return trailed(ctx, SRC, 'StopDBInstance', [], p, () => {
    const i = instOr(ctx, p.DBInstanceIdentifier); auth(ctx, 'rds:StopDBInstance', i.arn); needAvailable(i);
    i.transient = { status: 'stopping', until: now() + scaled(20_000) };
    return i;
  });
}
export function startDbInstance(ctx: Ctx, p: { DBInstanceIdentifier: string }): RdsInstance {
  return trailed(ctx, SRC, 'StartDBInstance', [], p, () => {
    const i = instOr(ctx, p.DBInstanceIdentifier); auth(ctx, 'rds:StartDBInstance', i.arn);
    if (rdsStatus(i) !== 'stopped') throw new AwsError('InvalidDBInstanceState', `Instance ${i.id} is not stopped.`.replace(/^.*$/, `Instance ${i.id} is not in stopped state.`), 400);
    i.transient = { status: 'starting', until: now() + scaled(30_000) };
    return i;
  });
}

function takeSnapshot(ctx: Ctx, i: RdsInstance, id: string, type: 'manual' | 'automated', tags: Record<string, string> = {}): RdsSnapshot {
  const t = now();
  const snap: RdsSnapshot = {
    id, arn: arnSnap(ctx, id), instanceId: i.id, region: i.region, engine: i.engine, engineVersion: i.engineVersion, allocatedStorage: i.allocatedStorage, storageType: i.storageType, masterUser: i.masterUser, port: i.port,
    createdAt: t, readyAt: t + scaled(20_000 + i.allocatedStorage * 100), type, encrypted: i.encrypted, kmsKeyId: i.kmsKeyId, az: i.az, vpcId: i.vpcId, dbName: i.dbName, tags, instanceCreatedAt: i.createdAt, cls: i.cls, multiAz: i.multiAz,
  };
  sv(ctx.s).rdsSnapshots.push(snap);
  return snap;
}
export const snapshotStatus = (x: RdsSnapshot) => (x.readyAt > now() ? 'creating' : 'available');

export function deleteDbInstance(ctx: Ctx, p: { DBInstanceIdentifier: string; SkipFinalSnapshot?: boolean; FinalDBSnapshotIdentifier?: string; DeleteAutomatedBackups?: boolean }): RdsInstance {
  return trailed(ctx, SRC, 'DeleteDBInstance', [{ type: 'AWS::RDS::DBInstance', name: p.DBInstanceIdentifier }], { dBInstanceIdentifier: p.DBInstanceIdentifier, skipFinalSnapshot: p.SkipFinalSnapshot, finalDBSnapshotIdentifier: p.FinalDBSnapshotIdentifier }, () => {
    const i = instOr(ctx, p.DBInstanceIdentifier);
    auth(ctx, 'rds:DeleteDBInstance', i.arn);
    if (i.deletionProtection) throw combo('Cannot delete protected DB Instance, please disable deletion protection and try again.');
    const st = rdsStatus(i);
    if (st === 'deleting') throw new AwsError('InvalidDBInstanceState', `Instance ${i.id} is already being deleted.`, 400);
    if (!p.SkipFinalSnapshot && !p.FinalDBSnapshotIdentifier) throw combo('FinalDBSnapshotIdentifier is required unless SkipFinalSnapshot is specified.');
    if (p.SkipFinalSnapshot && p.FinalDBSnapshotIdentifier) throw combo('FinalDBSnapshotIdentifier can not be specified when SkipFinalSnapshot is specified.'.replace(/^.*$/, 'FinalDBSnapshotIdentifier can not be specified when SkipFinalSnapshot is true.'));
    if (st === 'creating' && !p.SkipFinalSnapshot) throw new AwsError('InvalidDBInstanceState', `Instance ${i.id} is not in available state.`, 400);
    if (!p.SkipFinalSnapshot) {
      const sid = p.FinalDBSnapshotIdentifier!.toLowerCase();
      if (sv(ctx.s).rdsSnapshots.some((x) => x.id === sid && x.region === ctx.region)) throw new AwsError('DBSnapshotAlreadyExists', `Cannot create the snapshot because a snapshot with the identifier ${sid} already exists.`, 400);
      takeSnapshot(ctx, i, sid, 'manual');
    }
    for (const r of sv(ctx.s).rdsInstances) if (r.readReplicaOf === i.id) r.readReplicaOf = undefined;
    i.transient = { status: 'deleting', until: now() + scaled(15_000) };
    ev(ctx.s, i.region, i.id, 'DB instance shutdown');
    return i;
  });
}

// ------------------------------------------------------------------ instantáneas
export function createDbSnapshot(ctx: Ctx, p: { DBSnapshotIdentifier: string; DBInstanceIdentifier: string; Tags?: { Key: string; Value: string }[] }): RdsSnapshot {
  return trailed(ctx, SRC, 'CreateDBSnapshot', [{ type: 'AWS::RDS::DBSnapshot', name: p.DBSnapshotIdentifier }], { dBSnapshotIdentifier: p.DBSnapshotIdentifier, dBInstanceIdentifier: p.DBInstanceIdentifier }, () => {
    const id = (p.DBSnapshotIdentifier ?? '').toLowerCase();
    auth(ctx, 'rds:CreateDBSnapshot', arnSnap(ctx, id));
    if (!/^[a-zA-Z][a-zA-Z0-9]*(-[a-zA-Z0-9]+)*$/.test(p.DBSnapshotIdentifier ?? '')) throw inval('The parameter DBSnapshotIdentifier is not a valid identifier. Identifiers must begin with a letter; must contain only ASCII letters, digits, and hyphens; and must not end with a hyphen or contain two consecutive hyphens.');
    const i = instOr(ctx, p.DBInstanceIdentifier);
    needAvailable(i);
    if (sv(ctx.s).rdsSnapshots.some((x) => x.id === id && x.region === ctx.region)) throw new AwsError('DBSnapshotAlreadyExists', `Cannot create the snapshot because a snapshot with the identifier ${id} already exists.`, 400);
    ev(ctx.s, i.region, i.id, 'Creating manual snapshot', 'db-instance');
    return takeSnapshot(ctx, i, id, 'manual', Object.fromEntries(asArr(p.Tags).map((x) => [x.Key, x.Value])));
  });
}
export function describeDbSnapshots(ctx: Ctx, p: { DBInstanceIdentifier?: string; DBSnapshotIdentifier?: string; SnapshotType?: string }): RdsSnapshot[] {
  return trailed(ctx, SRC, 'DescribeDBSnapshots', [], p, () => {
    auth(ctx, 'rds:DescribeDBSnapshots', arnSnap(ctx, p.DBSnapshotIdentifier ?? '*'));
    const all = sv(ctx.s).rdsSnapshots.filter((x) => x.region === ctx.region);
    if (p.DBSnapshotIdentifier) { const x = all.find((y) => y.id === p.DBSnapshotIdentifier!.toLowerCase()); if (!x) throw new AwsError('DBSnapshotNotFound', `DBSnapshot not found: ${p.DBSnapshotIdentifier}`, 404); return [x]; }
    return all.filter((x) => (!p.DBInstanceIdentifier || x.instanceId === p.DBInstanceIdentifier.toLowerCase()) && (!p.SnapshotType || x.type === p.SnapshotType));
  });
}
export function deleteDbSnapshot(ctx: Ctx, p: { DBSnapshotIdentifier: string }): RdsSnapshot {
  return trailed(ctx, SRC, 'DeleteDBSnapshot', [], p, () => {
    const id = p.DBSnapshotIdentifier.toLowerCase();
    auth(ctx, 'rds:DeleteDBSnapshot', arnSnap(ctx, id));
    const x = sv(ctx.s).rdsSnapshots.find((y) => y.id === id && y.region === ctx.region);
    if (!x) throw new AwsError('DBSnapshotNotFound', `DBSnapshot not found: ${p.DBSnapshotIdentifier}`, 404);
    if (snapshotStatus(x) !== 'available') throw new AwsError('InvalidDBSnapshotState', `Cannot delete the snapshot ${id} because it is not in available state.`.replace(/^.*$/, `Cannot delete the snapshot because it is in creating state`), 400);
    sv(ctx.s).rdsSnapshots = sv(ctx.s).rdsSnapshots.filter((y) => y !== x);
    return x;
  });
}
export function restoreFromSnapshot(ctx: Ctx, p: { DBInstanceIdentifier: string; DBSnapshotIdentifier: string; DBInstanceClass?: string; MultiAZ?: boolean; DBSubnetGroupName?: string; VpcSecurityGroupIds?: string[]; PubliclyAccessible?: boolean; Port?: number }): RdsInstance {
  return trailed(ctx, SRC, 'RestoreDBInstanceFromDBSnapshot', [{ type: 'AWS::RDS::DBInstance', name: p.DBInstanceIdentifier }], { dBInstanceIdentifier: p.DBInstanceIdentifier, dBSnapshotIdentifier: p.DBSnapshotIdentifier }, () => {
    const id = (p.DBInstanceIdentifier ?? '').toLowerCase();
    auth(ctx, 'rds:RestoreDBInstanceFromDBSnapshot', arnDb(ctx, id));
    const snap = sv(ctx.s).rdsSnapshots.find((y) => y.id === (p.DBSnapshotIdentifier ?? '').toLowerCase() && y.region === ctx.region);
    if (!snap) throw new AwsError('DBSnapshotNotFound', `DBSnapshot not found: ${p.DBSnapshotIdentifier}`, 404);
    if (snapshotStatus(snap) !== 'available') throw new AwsError('InvalidDBSnapshotState', `Cannot restore from snapshot ${snap.id} because it is not in available state.`.replace(/^.*$/, `Snapshot ${snap.id} is not in available state.`), 400);
    if (sv(ctx.s).rdsInstances.some((x) => x.id === id && x.region === ctx.region)) throw new AwsError('DBInstanceAlreadyExists', 'DB instance already exists', 400);
    const g = groupOr(ctx, (p.DBSubnetGroupName ?? 'default').toLowerCase());
    const multi = p.MultiAZ ?? snap.multiAz;
    const place = placement(ctx, g, multi);
    const sgIds = asArr(p.VpcSecurityGroupIds).length ? asArr(p.VpcSecurityGroupIds) : [ctx.s.vpcs.find((v) => v.id === g.vpcId)!.defaultSecurityGroupId];
    const t = now();
    const inst: RdsInstance = {
      id, arn: arnDb(ctx, id), region: ctx.region, engine: snap.engine, engineVersion: snap.engineVersion, cls: p.DBInstanceClass ?? snap.cls, allocatedStorage: snap.allocatedStorage, storageType: snap.storageType, masterUser: snap.masterUser, dbName: snap.dbName,
      port: Number(p.Port ?? snap.port), createdAt: t, readyAt: t + scaled(60_000), multiAz: multi, publiclyAccessible: p.PubliclyAccessible ?? true, subnetGroup: g.name, vpcId: g.vpcId, sgIds, az: place.az, secondaryAz: place.secondaryAz,
      encrypted: snap.encrypted, kmsKeyId: snap.kmsKeyId, backupRetention: 1, deletionProtection: false, endpoint: `${id}.${randomString(12)}.${ctx.region}.rds.amazonaws.com`, dbiResourceId: 'db-' + randomString(26).toUpperCase(), tags: {},
      parameterGroup: `default.${snap.engine}${snap.engineVersion.split('.').slice(0, snap.engine === 'postgres' ? 1 : 2).join('.')}`,
    };
    sv(ctx.s).rdsInstances.push(inst);
    ev(ctx.s, ctx.region, id, 'Restored from snapshot ' + snap.id);
    return inst;
  });
}

// ------------------------------------------------------------------ réplicas de lectura
export function createReadReplica(ctx: Ctx, p: { DBInstanceIdentifier: string; SourceDBInstanceIdentifier: string; DBInstanceClass?: string; PubliclyAccessible?: boolean }): RdsInstance {
  return trailed(ctx, SRC, 'CreateDBInstanceReadReplica', [{ type: 'AWS::RDS::DBInstance', name: p.DBInstanceIdentifier }], p, () => {
    const id = (p.DBInstanceIdentifier ?? '').toLowerCase();
    auth(ctx, 'rds:CreateDBInstanceReadReplica', arnDb(ctx, id));
    const src = instOr(ctx, p.SourceDBInstanceIdentifier);
    needAvailable(src);
    if (src.backupRetention === 0) throw new AwsError('InvalidDBInstanceState', 'Automated backups are not enabled for this database instance. To enable automated backups, set the backup retention period to a non-zero value.'.replace(/^.*$/, 'Automated backups are not enabled for this database instance. To enable automated backups, set the backup retention period to a non-zero value.'), 400);
    if (sv(ctx.s).rdsInstances.some((x) => x.id === id && x.region === ctx.region)) throw new AwsError('DBInstanceAlreadyExists', 'DB instance already exists', 400);
    const t = now();
    const g = groupOr(ctx, src.subnetGroup);
    const azs = subnetGroupAzs(ctx.s, g).sort();
    const inst: RdsInstance = { ...JSON.parse(JSON.stringify(src)), id, arn: arnDb(ctx, id), createdAt: t, readyAt: t + scaled(60_000), multiAz: false, secondaryAz: undefined, az: azs.find((x) => x !== src.az) ?? src.az, readReplicaOf: src.id, cls: p.DBInstanceClass ?? src.cls, endpoint: `${id}.${randomString(12)}.${ctx.region}.rds.amazonaws.com`, dbiResourceId: 'db-' + randomString(26).toUpperCase(), tags: {}, transient: undefined, pendingValues: undefined, deletionProtection: false, publiclyAccessible: p.PubliclyAccessible ?? src.publiclyAccessible };
    sv(ctx.s).rdsInstances.push(inst);
    ev(ctx.s, ctx.region, id, 'Creating read replica');
    return inst;
  });
}
export function promoteReadReplica(ctx: Ctx, p: { DBInstanceIdentifier: string; BackupRetentionPeriod?: number }): RdsInstance {
  return trailed(ctx, SRC, 'PromoteReadReplica', [], p, () => {
    const i = instOr(ctx, p.DBInstanceIdentifier);
    auth(ctx, 'rds:PromoteReadReplica', i.arn);
    if (!i.readReplicaOf) throw new AwsError('InvalidDBInstanceState', `DB Instance ${i.id} is not a read replica.`.replace(/^.*$/, `DB Instance is not a read replica.`), 400);
    needAvailable(i);
    i.readReplicaOf = undefined;
    i.transient = { status: 'modifying', until: now() + scaled(20_000) };
    ev(ctx.s, i.region, i.id, 'Promoted Read Replica to standalone DB instance'.replace('Promoted Read Replica to standalone DB instance', 'Promoted to standalone DB instance'));
    return i;
  });
}

// ------------------------------------------------------------------ etiquetas y eventos
function taggable(ctx: Ctx, arn: string): { tags: Record<string, string> } {
  const i = sv(ctx.s).rdsInstances.find((x) => x.arn === arn);
  if (i) return i;
  const sn = sv(ctx.s).rdsSnapshots.find((x) => x.arn === arn);
  if (sn) return sn;
  throw new AwsError(arn.includes(':snapshot:') ? 'DBSnapshotNotFound' : 'DBInstanceNotFound', arn.includes(':snapshot:') ? `DBSnapshot not found: ${arn.split(':').pop()}` : `DBInstance ${arn.split(':').pop()} not found.`, 404);
}
export function addTags(ctx: Ctx, p: { ResourceName: string; Tags: { Key: string; Value: string }[] }) { trailed(ctx, SRC, 'AddTagsToResource', [], { resourceName: p.ResourceName }, () => { auth(ctx, 'rds:AddTagsToResource', p.ResourceName); const t = taggable(ctx, p.ResourceName); for (const x of asArr(p.Tags)) t.tags[x.Key] = x.Value; }); }
export function removeTags(ctx: Ctx, p: { ResourceName: string; TagKeys: string[] }) { trailed(ctx, SRC, 'RemoveTagsFromResource', [], { resourceName: p.ResourceName }, () => { auth(ctx, 'rds:RemoveTagsFromResource', p.ResourceName); const t = taggable(ctx, p.ResourceName); for (const k of asArr(p.TagKeys)) delete t.tags[k]; }); }
export function listTags(ctx: Ctx, p: { ResourceName: string }) { return trailed(ctx, SRC, 'ListTagsForResource', [], { resourceName: p.ResourceName }, () => { auth(ctx, 'rds:ListTagsForResource', p.ResourceName); return taggable(ctx, p.ResourceName).tags; }); }
export function describeEvents(ctx: Ctx, p: { SourceIdentifier?: string; SourceType?: string; Duration?: number }) {
  return trailed(ctx, SRC, 'DescribeEvents', [], p, () => {
    auth(ctx, 'rds:DescribeEvents', '*');
    settleRds(ctx.s);
    const since = now() - (p.Duration ?? 60) * 60_000;
    return sv(ctx.s).rdsEvents.filter((e) => e.region === ctx.region && e.ts >= since && (!p.SourceIdentifier || e.sourceId === p.SourceIdentifier.toLowerCase()) && (!p.SourceType || e.sourceType === p.SourceType));
  });
}
export const ENGINE_VERSIONS = (e: string) => ENGINES[e]?.versions ?? [];
export const ENGINE_NAMES = Object.keys(ENGINES);
void hex;
