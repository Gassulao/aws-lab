import { describe, it, expect, beforeEach } from 'vitest';
import { freshState } from '../src/engine/store';
import { newShell, runString, type Shell } from '../src/shell';
import { setClock } from '../src/engine/util';
import type { CloudState } from '../src/engine/types';

let st: CloudState;
let sh: Shell;
beforeEach(() => {
  setClock(null);
  st = freshState('Ana');
  sh = newShell(st);
});
const run = (cmd: string) => runString(sh, cmd);
const ok = async (cmd: string) => {
  const r = await run(cmd);
  expect(r.err, cmd).toBe('');
  return r.out;
};
const json = async (cmd: string) => JSON.parse(await ok(cmd));
const err = async (cmd: string) => (await run(cmd)).err;

describe('IAM extra', () => {
  it('perfil de inicio de sesión, política de contraseñas y alias', async () => {
    await ok('aws iam create-user --user-name luis');
    expect(await err('aws iam create-login-profile --user-name luis --password abc')).toContain('PasswordPolicyViolation');
    const lp = await json('aws iam create-login-profile --user-name luis --password "Secreto#2024" --password-reset-required');
    expect(lp.LoginProfile.PasswordResetRequired).toBe(true);
    expect(await err('aws iam create-login-profile --user-name luis --password "Secreto#2024"')).toContain('EntityAlreadyExists');
    await ok('aws iam delete-login-profile --user-name luis');
    expect(await err('aws iam delete-login-profile --user-name luis')).toContain('Login Profile for User luis cannot be found.');
    expect(await err('aws iam get-account-password-policy')).toContain('NoSuchEntity');
    await ok('aws iam update-account-password-policy --minimum-password-length 14 --require-symbols --require-numbers --max-password-age 90');
    const pp = await json('aws iam get-account-password-policy');
    expect(pp.PasswordPolicy).toMatchObject({ MinimumPasswordLength: 14, RequireSymbols: true, RequireNumbers: true, ExpirePasswords: true, MaxPasswordAge: 90, RequireUppercaseCharacters: false });
    expect(await err('aws iam create-login-profile --user-name luis --password "Secreto#2024"')).toContain('PasswordPolicyViolation');
    await ok('aws iam create-account-alias --account-alias mi-lab');
    expect((await json('aws iam list-account-aliases')).AccountAliases).toEqual(['mi-lab']);
    expect(await err('aws iam create-account-alias --account-alias AB')).toContain('ValidationError');
    await ok('aws iam delete-account-alias --account-alias mi-lab');
    expect((await json('aws iam list-account-aliases')).AccountAliases).toEqual([]);
  });

  it('etiquetas, MFA, grupos y resumen', async () => {
    await ok('aws iam create-user --user-name luis');
    await ok('aws iam tag-user --user-name luis --tags Key=env,Value=dev Key=team,Value=a');
    expect((await json('aws iam list-user-tags --user-name luis')).Tags).toHaveLength(2);
    await ok('aws iam untag-user --user-name luis --tag-keys env');
    expect(await ok("aws iam list-user-tags --user-name luis --query 'Tags[0].Key' --output text")).toBe('team\n');
    const mfa = await json('aws iam create-virtual-mfa-device --virtual-mfa-device-name luis-mfa --outfile /tmp/qr.png --bootstrap-method QRCodePNG');
    expect(mfa.VirtualMFADevice.SerialNumber).toBe(`arn:aws:iam::${st.account.id}:mfa/luis-mfa`);
    await ok(`aws iam enable-mfa-device --user-name luis --serial-number ${mfa.VirtualMFADevice.SerialNumber} --authentication-code1 123456 --authentication-code2 654321`);
    expect((await json('aws iam list-mfa-devices --user-name luis')).MFADevices[0].SerialNumber).toBe(mfa.VirtualMFADevice.SerialNumber);
    expect(await err(`aws iam delete-virtual-mfa-device --serial-number ${mfa.VirtualMFADevice.SerialNumber}`)).toContain('DeleteConflict');
    await ok(`aws iam deactivate-mfa-device --user-name luis --serial-number ${mfa.VirtualMFADevice.SerialNumber}`);
    await ok(`aws iam delete-virtual-mfa-device --serial-number ${mfa.VirtualMFADevice.SerialNumber}`);
    await ok('aws iam create-group --group-name devs && aws iam add-user-to-group --group-name devs --user-name luis');
    await ok('aws iam attach-group-policy --group-name devs --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess');
    expect((await json('aws iam list-groups-for-user --user-name luis')).Groups[0].GroupName).toBe('devs');
    expect((await json('aws iam list-attached-group-policies --group-name devs')).AttachedPolicies[0].PolicyName).toBe('ReadOnlyAccess');
    expect((await json('aws iam list-entities-for-policy --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess')).PolicyGroups[0].GroupName).toBe('devs');
    const sum = (await json('aws iam get-account-summary')).SummaryMap;
    expect(sum.Users).toBe(2);
    expect(sum.Groups).toBe(1);
  });

  it('políticas en línea y versiones de políticas', async () => {
    await ok('aws iam create-role --role-name r --assume-role-policy-document \'{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}\'');
    const doc = '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:ListAllMyBuckets","Resource":"*"}]}';
    await ok(`aws iam put-role-policy --role-name r --policy-name p1 --policy-document '${doc}'`);
    expect((await json('aws iam list-role-policies --role-name r')).PolicyNames).toEqual(['p1']);
    expect((await json('aws iam get-role-policy --role-name r --policy-name p1')).PolicyDocument.Statement[0].Action).toBe('s3:ListAllMyBuckets');
    await ok('aws iam delete-role-policy --role-name r --policy-name p1');
    expect(await err('aws iam get-role-policy --role-name r --policy-name p1')).toContain('The role policy with name p1 cannot be found.');

    const pol = await json(`aws iam create-policy --policy-name mi-pol --policy-document '${doc}'`);
    const arn = pol.Policy.Arn;
    const v2 = await json(`aws iam create-policy-version --policy-arn ${arn} --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:*","Resource":"*"}]}'`);
    expect(v2.PolicyVersion).toMatchObject({ VersionId: 'v2', IsDefaultVersion: false });
    await ok(`aws iam set-default-policy-version --policy-arn ${arn} --version-id v2`);
    expect((await json(`aws iam get-policy-version --policy-arn ${arn} --version-id v2`)).PolicyVersion.IsDefaultVersion).toBe(true);
    expect(st.policies.find((p) => p.arn === arn)!.document).toMatchObject({ Statement: [{ Action: 's3:*' }] });
    expect((await json(`aws iam list-policy-versions --policy-arn ${arn}`)).Versions.map((v: any) => v.VersionId)).toEqual(['v2', 'v1']);
    for (let i = 0; i < 3; i++) await ok(`aws iam create-policy-version --policy-arn ${arn} --policy-document '${doc}'`);
    expect(await err(`aws iam create-policy-version --policy-arn ${arn} --policy-document '${doc}'`)).toContain('LimitExceeded');
    expect(await err(`aws iam delete-policy-version --policy-arn ${arn} --version-id v2`)).toContain('DeleteConflict');
  });
});

describe('S3 extra', () => {
  beforeEach(async () => {
    await ok('aws s3 mb s3://lab-x --region eu-west-1');
  });
  it('ACL y propiedad de objetos', async () => {
    expect(await err('aws s3api put-bucket-acl --bucket lab-x --acl private')).toContain('AccessControlListNotSupported');
    await ok('aws s3api put-bucket-ownership-controls --bucket lab-x --ownership-controls \'Rules=[{ObjectOwnership=BucketOwnerPreferred}]\'');
    expect((await json('aws s3api get-bucket-ownership-controls --bucket lab-x')).OwnershipControls.Rules[0].ObjectOwnership).toBe('BucketOwnerPreferred');
    expect(await err('aws s3api put-bucket-acl --bucket lab-x --acl public-read')).toContain('AccessDenied');
    await ok('aws s3api put-bucket-acl --bucket lab-x --acl authenticated-read');
    const acl = await json('aws s3api get-bucket-acl --bucket lab-x');
    expect(acl.Grants).toHaveLength(2);
    expect(acl.Grants[0].Permission).toBe('FULL_CONTROL');
  });
  it('ciclo de vida, CORS, web, cifrado, versionado y acceso público', async () => {
    expect(await err('aws s3api get-bucket-lifecycle-configuration --bucket lab-x')).toContain('NoSuchLifecycleConfiguration');
    await ok(`aws s3api put-bucket-lifecycle-configuration --bucket lab-x --lifecycle-configuration '{"Rules":[{"ID":"r1","Status":"Enabled","Filter":{"Prefix":"logs/"},"Expiration":{"Days":30}}]}'`);
    expect((await json('aws s3api get-bucket-lifecycle-configuration --bucket lab-x')).Rules[0].ID).toBe('r1');
    expect(await err(`aws s3api put-bucket-lifecycle-configuration --bucket lab-x --lifecycle-configuration '{"Rules":[{"Status":"Bad"}]}'`)).toContain('MalformedXML');
    expect(await err('aws s3api get-bucket-cors --bucket lab-x')).toContain('NoSuchCORSConfiguration');
    await ok(`aws s3api put-bucket-cors --bucket lab-x --cors-configuration '{"CORSRules":[{"AllowedMethods":["GET"],"AllowedOrigins":["*"]}]}'`);
    expect((await json('aws s3api get-bucket-cors --bucket lab-x')).CORSRules[0].AllowedMethods).toEqual(['GET']);
    expect(await err('aws s3api get-bucket-website --bucket lab-x')).toContain('NoSuchWebsiteConfiguration');
    await ok(`aws s3api put-bucket-website --bucket lab-x --website-configuration '{"IndexDocument":{"Suffix":"index.html"}}'`);
    expect((await json('aws s3api get-bucket-website --bucket lab-x')).IndexDocument.Suffix).toBe('index.html');
    await ok('aws s3api delete-bucket-website --bucket lab-x');
    expect(await ok('aws s3api get-bucket-versioning --bucket lab-x')).toBe('');
    await ok(`aws s3api put-bucket-versioning --bucket lab-x --versioning-configuration Status=Enabled`);
    expect((await json('aws s3api get-bucket-versioning --bucket lab-x')).Status).toBe('Enabled');
    expect((await json('aws s3api get-bucket-encryption --bucket lab-x')).ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm).toBe('AES256');
    expect((await json('aws s3api get-public-access-block --bucket lab-x')).PublicAccessBlockConfiguration.BlockPublicAcls).toBe(true);
  });
  it('etiquetas de objeto, copia y versiones', async () => {
    await ok('aws s3api put-bucket-versioning --bucket lab-x --versioning-configuration Status=Enabled');
    await ok('echo uno > /tmp/a.txt; aws s3 cp /tmp/a.txt s3://lab-x/a.txt');
    await ok('echo dos > /tmp/a.txt; aws s3 cp /tmp/a.txt s3://lab-x/a.txt');
    await ok('aws s3api delete-object --bucket lab-x --key a.txt');
    const v = await json('aws s3api list-object-versions --bucket lab-x');
    expect(v.Versions).toHaveLength(2);
    expect(v.DeleteMarkers).toHaveLength(1);
    expect(v.DeleteMarkers[0].IsLatest).toBe(true);
    await ok('aws s3api put-bucket-versioning --bucket lab-x --versioning-configuration Status=Suspended');
    await ok('aws s3api put-object-tagging --bucket lab-x --key a.txt --tagging \'TagSet=[{Key=k,Value=v}]\'').catch(() => {});
    await ok('aws s3 cp /tmp/a.txt s3://lab-x/b.txt');
    await ok('aws s3api put-object-tagging --bucket lab-x --key b.txt --tagging \'TagSet=[{Key=k,Value=v}]\'');
    expect((await json('aws s3api get-object-tagging --bucket lab-x --key b.txt')).TagSet).toEqual([{ Key: 'k', Value: 'v' }]);
    const c = await json('aws s3api copy-object --bucket lab-x --key c.txt --copy-source lab-x/b.txt');
    expect(c.CopyObjectResult.ETag).toMatch(/^"/);
    expect(await err('aws s3api copy-object --bucket lab-x --key z --copy-source lab-x/nada')).toContain('NoSuchKey');
  });
  it('URL prefirmada: funciona y caduca', async () => {
    await ok('echo secreto > /tmp/s.txt; aws s3 cp /tmp/s.txt s3://lab-x/s.txt');
    const url = (await ok('aws s3 presign s3://lab-x/s.txt --expires-in 60')).trim();
    expect(url).toContain('X-Amz-Expires=60');
    expect(await ok(`curl -s "${url}"`)).toBe('secreto\n');
    const t = Date.now();
    setClock(() => t + 120_000);
    expect(await ok(`curl -s "${url}"`)).toContain('Request has expired');
    setClock(null);
    expect(await ok(`curl -s "${url.replace(/Signature=(.)/, (_m, c) => 'Signature=' + (c === '0' ? '1' : '0'))}"`)).toContain('SignatureDoesNotMatch');
  });
});

describe('CloudTrail trails', () => {
  const POLICY = (b: string) =>
    JSON.stringify({ Version: '2012-10-17', Statement: [
      { Sid: 'A', Effect: 'Allow', Principal: { Service: 'cloudtrail.amazonaws.com' }, Action: 's3:GetBucketAcl', Resource: `arn:aws:s3:::${b}` },
      { Sid: 'B', Effect: 'Allow', Principal: { Service: 'cloudtrail.amazonaws.com' }, Action: 's3:PutObject', Resource: `arn:aws:s3:::${b}/AWSLogs/*` },
    ] });
  it('crea el trail, exige la política del bucket y entrega eventos', async () => {
    expect(await err('aws cloudtrail create-trail --name trl1 --s3-bucket-name nada')).toContain('S3BucketDoesNotExistException');
    await ok('aws s3 mb s3://trail-logs');
    expect(await err('aws cloudtrail create-trail --name trl1 --s3-bucket-name trail-logs')).toContain('InsufficientS3BucketPolicyException');
    await ok(`aws s3api put-bucket-policy --bucket trail-logs --policy '${POLICY('trail-logs')}'`);
    const t = await json('aws cloudtrail create-trail --name trl1 --s3-bucket-name trail-logs --is-multi-region-trail');
    expect(t).toMatchObject({ Name: 'trl1', IsMultiRegionTrail: true, IncludeGlobalServiceEvents: true });
    expect(await err('aws cloudtrail create-trail --name trl1 --s3-bucket-name trail-logs')).toContain('TrailAlreadyExistsException');
    expect((await json('aws cloudtrail get-trail-status --name trl1')).IsLogging).toBe(false);
    await ok('aws cloudtrail start-logging --name trl1');
    expect((await json('aws cloudtrail get-trail-status --name trl1')).IsLogging).toBe(true);
    await ok('aws iam create-user --user-name zoe');
    const keys = (await ok('aws s3 ls s3://trail-logs --recursive')).trim().split('\n');
    expect(keys.length).toBeGreaterThan(0);
    const key = keys[0].trim().split(/\s+/).pop()!;
    expect(key).toMatch(/^AWSLogs\/\d+\/CloudTrail\/eu-west-1\/\d{4}\/\d\d\/\d\d\/\d+_CloudTrail_eu-west-1_\d{8}T\d{4}Z_trl1_\w+\.json\.gz$/);
    await ok(`aws s3 cp s3://trail-logs/${key} /tmp/log.json`);
    const log = JSON.parse(await ok('cat /tmp/log.json'));
    expect(log.Records.some((r: any) => r.eventName === 'CreateUser' && r.eventSource === 'iam.amazonaws.com')).toBe(true);
    await ok('aws cloudtrail stop-logging --name trl1');
    expect((await json('aws cloudtrail get-trail-status --name trl1')).IsLogging).toBe(false);
    const sel = await json('aws cloudtrail get-event-selectors --trail-name trl1');
    expect(sel.EventSelectors[0]).toMatchObject({ ReadWriteType: 'All', IncludeManagementEvents: true });
    expect((await json('aws cloudtrail describe-trails')).trailList[0].HomeRegion).toBe('eu-west-1');
    expect(await err('aws cloudtrail get-trail-status --name nope')).toContain('TrailNotFoundException');
  });
});

describe('EC2 extra', () => {
  it('NACL: crear, entradas y errores', async () => {
    const vpc = (await json('aws ec2 create-vpc --cidr-block 10.0.0.0/16')).Vpc.VpcId;
    const acl = (await json(`aws ec2 create-network-acl --vpc-id ${vpc}`)).NetworkAcl.NetworkAclId;
    await ok(`aws ec2 create-network-acl-entry --network-acl-id ${acl} --ingress --rule-number 100 --protocol tcp --port-range From=22,To=22 --cidr-block 10.0.0.0/8 --rule-action allow`);
    expect(await err(`aws ec2 create-network-acl-entry --network-acl-id ${acl} --ingress --rule-number 100 --protocol tcp --port-range From=22,To=22 --cidr-block 10.0.0.0/8 --rule-action allow`)).toContain('NetworkAclEntryAlreadyExists');
    const d = (await json(`aws ec2 describe-network-acls --network-acl-ids ${acl}`)).NetworkAcls[0];
    expect(d.IsDefault).toBe(false);
    expect(d.Entries.filter((e: any) => !e.Egress).map((e: any) => e.RuleNumber)).toEqual([100, 32767]);
    expect(d.Entries.find((e: any) => e.RuleNumber === 100).PortRange).toEqual({ From: 22, To: 22 });
    const def = (await json(`aws ec2 describe-network-acls --filters Name=vpc-id,Values=${vpc} Name=default,Values=true`)).NetworkAcls;
    expect(def).toHaveLength(1);
  });
  it('volúmenes, adjuntar, instantáneas y errores', async () => {
    await ok('aws ec2 create-key-pair --key-name k >/dev/null');
    const img = (await ok("aws ec2 describe-images --query 'Images[0].ImageId' --output text")).trim();
    const i = (await json(`aws ec2 run-instances --image-id ${img} --instance-type t3.micro`)).Instances[0];
    const v = await json(`aws ec2 create-volume --availability-zone ${i.Placement.AvailabilityZone} --size 10 --volume-type gp3`);
    expect(v.State).toBe('creating');
    expect((await json(`aws ec2 describe-volumes --volume-ids ${v.VolumeId}`)).Volumes[0].State).toBe('available');
    await ok(`aws ec2 attach-volume --volume-id ${v.VolumeId} --instance-id ${i.InstanceId} --device /dev/sdf`);
    expect(await err(`aws ec2 attach-volume --volume-id ${v.VolumeId} --instance-id ${i.InstanceId} --device /dev/sdg`)).toContain('VolumeInUse');
    expect(await err(`aws ec2 delete-volume --volume-id ${v.VolumeId}`)).toContain('currently attached');
    const snap = await json(`aws ec2 create-snapshot --volume-id ${v.VolumeId} --description prueba`);
    expect(snap.VolumeSize).toBe(10);
    expect((await json('aws ec2 describe-snapshots --owner-ids self')).Snapshots[0].State).toBe('completed');
    await ok(`aws ec2 detach-volume --volume-id ${v.VolumeId}`);
    await ok(`aws ec2 delete-volume --volume-id ${v.VolumeId}`);
    expect(await err(`aws ec2 describe-volumes --volume-ids ${v.VolumeId}`)).toContain('InvalidVolume.NotFound');
    expect(await err(`aws ec2 create-volume --availability-zone eu-west-1z --size 1`)).toContain('InvalidParameterValue');
    const status = (await json(`aws ec2 describe-instance-status --instance-ids ${i.InstanceId} --include-all-instances`)).InstanceStatuses;
    expect(status).toHaveLength(1);
  });
  it('IP elástica y reglas de grupos de seguridad', async () => {
    const img = (await ok("aws ec2 describe-images --query 'Images[0].ImageId' --output text")).trim();
    const i = (await json(`aws ec2 run-instances --image-id ${img}`)).Instances[0];
    const eip = await json('aws ec2 allocate-address');
    const a = await json(`aws ec2 associate-address --instance-id ${i.InstanceId} --allocation-id ${eip.AllocationId}`);
    expect(a.AssociationId).toMatch(/^eipassoc-/);
    expect((await json(`aws ec2 describe-instances --instance-ids ${i.InstanceId}`)).Reservations[0].Instances[0].PublicIpAddress).toBe(eip.PublicIp);
    await ok(`aws ec2 disassociate-address --association-id ${a.AssociationId}`);
    expect(await err(`aws ec2 disassociate-address --association-id ${a.AssociationId}`)).toContain('InvalidAssociationID.NotFound');
    const rules = (await json(`aws ec2 describe-security-group-rules --filters Name=group-id,Values=${i.SecurityGroups[0].GroupId}`)).SecurityGroupRules;
    expect(rules.some((r: any) => r.IsEgress && r.CidrIpv4 === '0.0.0.0/0')).toBe(true);
  });
});
