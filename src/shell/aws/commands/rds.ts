// aws rds
import { defineCommand, type Params } from '../framework';
import * as R from '../../../engine/serverless/rds';
import { sv } from '../../../engine/serverless';
import type { RdsInstance, RdsSnapshot, RdsSubnetGroup } from '../../../engine/serverless/types';
import type { Ctx } from '../../../engine/api';
import { need, num, bool, arr, strip, microIso, tagsOut, tagsIn, waitFor } from './sv-util';

const S = 'rds';
const HOSTED_ZONE = 'Z2R2ITUGPM61AM';
const mm = (c: Ctx, g: RdsSubnetGroup) => ({
  DBSubnetGroupName: g.name, DBSubnetGroupDescription: g.description, VpcId: g.vpcId, SubnetGroupStatus: 'Complete',
  Subnets: g.subnetIds.map((id) => { const x = c.s.subnets.find((y) => y.id === id); return { SubnetIdentifier: id, SubnetAvailabilityZone: { Name: x?.az }, SubnetOutpost: {}, SubnetStatus: 'Active' }; }),
  DBSubnetGroupArn: g.arn, SupportedNetworkTypes: ['IPV4'],
});
const pendingOut = (i: RdsInstance) => {
  const pv = i.pendingValues ?? {};
  return strip({ DBInstanceClass: pv.cls, AllocatedStorage: pv.allocatedStorage, MultiAZ: pv.multiAz, BackupRetentionPeriod: pv.backupRetention, EngineVersion: pv.engineVersion, StorageType: pv.storageType, Port: pv.port });
};
const inst = (c: Ctx, i: RdsInstance) => {
  const status = R.rdsStatus(i);
  const g = R.allSubnetGroups(c).find((x) => x.name === i.subnetGroup);
  return strip({
    DBInstanceIdentifier: i.id, DBInstanceClass: i.cls, Engine: i.engine, DBInstanceStatus: status, MasterUsername: i.masterUser, DBName: i.dbName,
    Endpoint: status === 'creating' ? undefined : { Address: i.endpoint, Port: i.port, HostedZoneId: HOSTED_ZONE },
    AllocatedStorage: i.allocatedStorage, InstanceCreateTime: status === 'creating' ? undefined : microIso(i.readyAt), PreferredBackupWindow: '03:12-03:42', BackupRetentionPeriod: i.backupRetention, DBSecurityGroups: [],
    VpcSecurityGroups: i.sgIds.map((VpcSecurityGroupId) => ({ VpcSecurityGroupId, Status: 'active' })),
    DBParameterGroups: [{ DBParameterGroupName: i.parameterGroup, ParameterApplyStatus: 'in-sync' }],
    AvailabilityZone: i.az, DBSubnetGroup: g ? mm(c, g) : undefined, PreferredMaintenanceWindow: 'sat:05:20-sat:05:50', PendingModifiedValues: pendingOut(i), MultiAZ: i.multiAz,
    EngineVersion: i.engineVersion, AutoMinorVersionUpgrade: true, ReadReplicaSourceDBInstanceIdentifier: i.readReplicaOf, ReadReplicaDBInstanceIdentifiers: sv(c.s).rdsInstances.filter((x) => x.readReplicaOf === i.id).map((x) => x.id),
    LicenseModel: i.engine === 'postgres' ? 'postgresql-license' : 'general-public-license', StorageType: i.storageType, PubliclyAccessible: i.publiclyAccessible, StorageEncrypted: i.encrypted, KmsKeyId: i.kmsKeyId,
    DbInstancePort: 0, DbiResourceId: i.dbiResourceId, DBInstanceArn: i.arn, SecondaryAvailabilityZone: i.multiAz ? i.secondaryAz : undefined, DeletionProtection: i.deletionProtection,
    TagList: tagsOut(i.tags),
  });
};
const snap = (x: RdsSnapshot) => {
  const status = R.snapshotStatus(x);
  return strip({
    DBSnapshotIdentifier: x.id, DBInstanceIdentifier: x.instanceId, SnapshotCreateTime: microIso(x.createdAt), Engine: x.engine, AllocatedStorage: x.allocatedStorage, Status: status, Port: x.port, AvailabilityZone: x.az, VpcId: x.vpcId,
    InstanceCreateTime: microIso(x.instanceCreatedAt), MasterUsername: x.masterUser, EngineVersion: x.engineVersion, SnapshotType: x.type, StorageType: x.storageType, Encrypted: x.encrypted, KmsKeyId: x.kmsKeyId,
    DBSnapshotArn: x.arn, PercentProgress: status === 'available' ? 100 : 0, DBName: x.dbName, TagList: tagsOut(x.tags),
  });
};
const ID = (p: Params) => need(p, 'DbInstanceIdentifier', 'db-instance-identifier') as string;
const TAGS = ['tags'];

defineCommand({
  service: S, name: 'create-db-instance', op: 'CreateDBInstance', list: ['vpc-security-group-ids', 'tags'], structured: TAGS, bool: ['multi-az', 'publicly-accessible', 'storage-encrypted', 'deletion-protection'],
  run: (c, p) => ({ DBInstance: inst(c, R.createDbInstance(c, {
    DBInstanceIdentifier: ID(p), DBInstanceClass: p.DbInstanceClass, Engine: need(p, 'Engine', 'engine'), EngineVersion: p.EngineVersion, MasterUsername: p.MasterUsername, MasterUserPassword: p.MasterUserPassword, AllocatedStorage: num(p.AllocatedStorage),
    DBName: p.DbName, VpcSecurityGroupIds: p.VpcSecurityGroupIds ? arr(p.VpcSecurityGroupIds) : undefined, DBSubnetGroupName: p.DbSubnetGroupName, MultiAZ: bool(p.MultiAz), PubliclyAccessible: bool(p.PubliclyAccessible), StorageEncrypted: bool(p.StorageEncrypted),
    KmsKeyId: p.KmsKeyId, BackupRetentionPeriod: num(p.BackupRetentionPeriod), Port: num(p.Port), DeletionProtection: bool(p.DeletionProtection), StorageType: p.StorageType, Tags: p.Tags ? tagsIn(p.Tags) : undefined, AvailabilityZone: p.AvailabilityZone,
  })) }),
});
defineCommand({ service: S, name: 'describe-db-instances', op: 'DescribeDBInstances', run: (c, p) => ({ DBInstances: R.describeDbInstances(c, { DBInstanceIdentifier: p.DbInstanceIdentifier }).map((i) => inst(c, i)) }) });
defineCommand({
  service: S, name: 'modify-db-instance', op: 'ModifyDBInstance', list: ['vpc-security-group-ids'], bool: ['multi-az', 'publicly-accessible', 'deletion-protection', 'apply-immediately'],
  run: (c, p) => ({ DBInstance: inst(c, R.modifyDbInstance(c, {
    DBInstanceIdentifier: ID(p), DBInstanceClass: p.DbInstanceClass, AllocatedStorage: num(p.AllocatedStorage), MultiAZ: bool(p.MultiAz), BackupRetentionPeriod: num(p.BackupRetentionPeriod), VpcSecurityGroupIds: p.VpcSecurityGroupIds ? arr(p.VpcSecurityGroupIds) : undefined,
    PubliclyAccessible: bool(p.PubliclyAccessible), DeletionProtection: bool(p.DeletionProtection), ApplyImmediately: bool(p.ApplyImmediately), MasterUserPassword: p.MasterUserPassword, EngineVersion: p.EngineVersion, StorageType: p.StorageType,
  })) }),
});
defineCommand({ service: S, name: 'reboot-db-instance', op: 'RebootDBInstance', bool: ['force-failover'], run: (c, p) => ({ DBInstance: inst(c, R.rebootDbInstance(c, { DBInstanceIdentifier: ID(p), ForceFailover: bool(p.ForceFailover) })) }) });
defineCommand({ service: S, name: 'stop-db-instance', op: 'StopDBInstance', run: (c, p) => ({ DBInstance: inst(c, R.stopDbInstance(c, { DBInstanceIdentifier: ID(p) })) }) });
defineCommand({ service: S, name: 'start-db-instance', op: 'StartDBInstance', run: (c, p) => ({ DBInstance: inst(c, R.startDbInstance(c, { DBInstanceIdentifier: ID(p) })) }) });
defineCommand({
  service: S, name: 'delete-db-instance', op: 'DeleteDBInstance', bool: ['skip-final-snapshot', 'delete-automated-backups'],
  run: (c, p) => ({ DBInstance: inst(c, R.deleteDbInstance(c, { DBInstanceIdentifier: ID(p), SkipFinalSnapshot: bool(p.SkipFinalSnapshot), FinalDBSnapshotIdentifier: p.FinalDbSnapshotIdentifier, DeleteAutomatedBackups: bool(p.DeleteAutomatedBackups) })) }),
});
defineCommand({
  service: S, name: 'create-db-subnet-group', op: 'CreateDBSubnetGroup', list: ['subnet-ids'],
  run: (c, p) => ({ DBSubnetGroup: mm(c, R.createDbSubnetGroup(c, { DBSubnetGroupName: need(p, 'DbSubnetGroupName', 'db-subnet-group-name'), DBSubnetGroupDescription: need(p, 'DbSubnetGroupDescription', 'db-subnet-group-description'), SubnetIds: arr(need(p, 'SubnetIds', 'subnet-ids')) })) }),
});
defineCommand({ service: S, name: 'describe-db-subnet-groups', op: 'DescribeDBSubnetGroups', run: (c, p) => ({ DBSubnetGroups: R.describeDbSubnetGroups(c, { DBSubnetGroupName: p.DbSubnetGroupName }).map((g) => mm(c, g)) }) });
defineCommand({
  service: S, name: 'modify-db-subnet-group', op: 'ModifyDBSubnetGroup', list: ['subnet-ids'],
  run: (c, p) => ({ DBSubnetGroup: mm(c, R.modifyDbSubnetGroup(c, { DBSubnetGroupName: need(p, 'DbSubnetGroupName', 'db-subnet-group-name'), SubnetIds: arr(need(p, 'SubnetIds', 'subnet-ids')), DBSubnetGroupDescription: p.DbSubnetGroupDescription })) }),
});
defineCommand({ service: S, name: 'delete-db-subnet-group', op: 'DeleteDBSubnetGroup', run: (c, p) => void R.deleteDbSubnetGroup(c, { DBSubnetGroupName: need(p, 'DbSubnetGroupName', 'db-subnet-group-name') }) });
defineCommand({
  service: S, name: 'create-db-snapshot', op: 'CreateDBSnapshot', list: TAGS, structured: TAGS,
  run: (c, p) => ({ DBSnapshot: snap(R.createDbSnapshot(c, { DBSnapshotIdentifier: need(p, 'DbSnapshotIdentifier', 'db-snapshot-identifier'), DBInstanceIdentifier: ID(p), Tags: p.Tags ? tagsIn(p.Tags) : undefined })) }),
});
defineCommand({ service: S, name: 'describe-db-snapshots', op: 'DescribeDBSnapshots', run: (c, p) => ({ DBSnapshots: R.describeDbSnapshots(c, { DBInstanceIdentifier: p.DbInstanceIdentifier, DBSnapshotIdentifier: p.DbSnapshotIdentifier, SnapshotType: p.SnapshotType }).map(snap) }) });
defineCommand({ service: S, name: 'delete-db-snapshot', op: 'DeleteDBSnapshot', run: (c, p) => ({ DBSnapshot: snap(R.deleteDbSnapshot(c, { DBSnapshotIdentifier: need(p, 'DbSnapshotIdentifier', 'db-snapshot-identifier') })) }) });
defineCommand({
  service: S, name: 'restore-db-instance-from-db-snapshot', op: 'RestoreDBInstanceFromDBSnapshot', list: ['vpc-security-group-ids'], bool: ['multi-az', 'publicly-accessible'],
  run: (c, p) => ({ DBInstance: inst(c, R.restoreFromSnapshot(c, { DBInstanceIdentifier: ID(p), DBSnapshotIdentifier: need(p, 'DbSnapshotIdentifier', 'db-snapshot-identifier'), DBInstanceClass: p.DbInstanceClass, MultiAZ: bool(p.MultiAz), DBSubnetGroupName: p.DbSubnetGroupName, VpcSecurityGroupIds: p.VpcSecurityGroupIds ? arr(p.VpcSecurityGroupIds) : undefined, PubliclyAccessible: bool(p.PubliclyAccessible), Port: num(p.Port) })) }),
});
defineCommand({
  service: S, name: 'create-db-instance-read-replica', op: 'CreateDBInstanceReadReplica', bool: ['publicly-accessible'],
  run: (c, p) => ({ DBInstance: inst(c, R.createReadReplica(c, { DBInstanceIdentifier: ID(p), SourceDBInstanceIdentifier: need(p, 'SourceDBInstanceIdentifier', 'source-db-instance-identifier'), DBInstanceClass: p.DbInstanceClass, PubliclyAccessible: bool(p.PubliclyAccessible) })) }),
});
defineCommand({ service: S, name: 'promote-read-replica', op: 'PromoteReadReplica', run: (c, p) => ({ DBInstance: inst(c, R.promoteReadReplica(c, { DBInstanceIdentifier: ID(p), BackupRetentionPeriod: num(p.BackupRetentionPeriod) })) }) });
defineCommand({ service: S, name: 'add-tags-to-resource', op: 'AddTagsToResource', list: TAGS, structured: TAGS, run: (c, p) => void R.addTags(c, { ResourceName: need(p, 'ResourceName', 'resource-name'), Tags: tagsIn(need(p, 'Tags', 'tags')) }) });
defineCommand({ service: S, name: 'remove-tags-from-resource', op: 'RemoveTagsFromResource', list: ['tag-keys'], run: (c, p) => void R.removeTags(c, { ResourceName: need(p, 'ResourceName', 'resource-name'), TagKeys: arr(need(p, 'TagKeys', 'tag-keys')) }) });
defineCommand({ service: S, name: 'list-tags-for-resource', op: 'ListTagsForResource', run: (c, p) => ({ TagList: tagsOut(R.listTags(c, { ResourceName: need(p, 'ResourceName', 'resource-name') })) }) });
defineCommand({
  service: S, name: 'describe-events', op: 'DescribeEvents',
  run: (c, p) => ({ Events: R.describeEvents(c, { SourceIdentifier: p.SourceIdentifier, SourceType: p.SourceType, Duration: num(p.Duration) }).map((e) => ({ SourceIdentifier: e.sourceId, SourceType: e.sourceType, Message: e.message, EventCategories: [], Date: microIso(e.ts), SourceArn: `arn:aws:rds:${e.region}:${c.s.account.id}:db:${e.sourceId}` })) }),
});
defineCommand({
  service: S, name: 'wait', op: 'Wait',
  run: async (c, p, _sh, pos) => {
    const w = pos[0];
    const find = () => sv(c.s).rdsInstances.find((i) => i.id === String(p.DbInstanceIdentifier ?? '').toLowerCase() && i.region === c.region);
    if (w === 'db-instance-available') {
      const id = ID(p); R.describeDbInstances(c, { DBInstanceIdentifier: id });
      await waitFor(c, 'DBInstanceAvailable', () => R.rdsStatus(find()!) === 'available', () => (find() ? (['deleting', 'failed', 'incompatible-restore'].includes(R.rdsStatus(find()!)) ? `DBInstanceStatus is ${R.rdsStatus(find()!)}` : undefined) : 'DBInstanceNotFound'));
    } else if (w === 'db-instance-deleted') {
      await waitFor(c, 'DBInstanceDeleted', () => !find());
    } else if (w === 'db-snapshot-available') {
      const sid = String(need(p, 'DbSnapshotIdentifier', 'db-snapshot-identifier')).toLowerCase();
      await waitFor(c, 'DBSnapshotAvailable', () => { const x = sv(c.s).rdsSnapshots.find((y) => y.id === sid && y.region === c.region); return !!x && R.snapshotStatus(x) === 'available'; });
    } else throw new Error(`\nusage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\naws: error: argument operation: Invalid choice, valid choices are:\n\ndb-instance-available | db-instance-deleted\ndb-snapshot-available`);
    return undefined;
  },
});
