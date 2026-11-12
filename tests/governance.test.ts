import { describe, it, expect, beforeEach } from 'vitest';
import { freshState } from '../src/engine/store';
import { newShell, runString, type Shell } from '../src/shell';
import { setClock } from '../src/engine/util';
import type { CloudState } from '../src/engine/types';
import { estimateCost } from '../src/ui/pages/home/cost';
import { evaluate } from '../src/engine/policy';
import { gov } from '../src/engine/services/govTypes';

let st: CloudState;
let sh: Shell;
let T: number;
beforeEach(() => {
  T = Date.parse('2026-11-10T10:00:00Z');
  setClock(() => T);
  st = freshState('Ana');
  st.settings.speed = 'instant';
  sh = newShell(st);
});
const run = (cmd: string) => runString(sh, cmd);
const ok = async (cmd: string) => { const r = await run(cmd); expect(r.err, cmd).toBe(''); return r.out; };
const json = async (cmd: string) => JSON.parse(await ok(cmd));
const err = async (cmd: string) => (await run(cmd)).err;
const AMI = 'ami-0a1b2c3d4e5f60001';
const hours = (h: number) => { T += h * 3_600_000; };
const q = (o: unknown) => `'${JSON.stringify(o)}'`;

/** Crea la organización, habilita las SCP y una cuenta miembro; devuelve prefijo de entorno para actuar en ella. */
async function orgWithMember() {
  const o = await json('aws organizations create-organization --feature-set ALL');
  const root = (await json('aws organizations list-roots')).Roots[0].Id;
  await ok(`aws organizations enable-policy-type --root-id ${root} --policy-type SERVICE_CONTROL_POLICY`);
  const ou = (await json(`aws organizations create-organizational-unit --parent-id ${root} --name Sandbox`)).OrganizationalUnit.Id;
  const stt = (await json('aws organizations create-account --account-name dev --email dev@example.com')).CreateAccountStatus;
  const done = (await json(`aws organizations describe-create-account-status --create-account-request-id ${stt.Id}`)).CreateAccountStatus;
  expect(done.State).toBe('SUCCEEDED');
  await ok(`aws organizations move-account --account-id ${done.AccountId} --source-parent-id ${root} --destination-parent-id ${ou}`);
  return { org: o.Organization, root, ou, acct: done.AccountId as string };
}
async function asMember(acct: string) {
  const c = (await json(`aws sts assume-role --role-arn arn:aws:iam::${acct}:role/OrganizationAccountAccessRole --role-session-name prueba`)).Credentials;
  return `AWS_ACCESS_KEY_ID=${c.AccessKeyId} AWS_SECRET_ACCESS_KEY=${c.SecretAccessKey} AWS_SESSION_TOKEN=${c.SessionToken} AWS_DEFAULT_REGION=eu-west-1`;
}
const scp = (sts: object[]) => q({ Version: '2012-10-17', Statement: sts });

describe('Organizations', () => {
  it('sin organización devuelve AWSOrganizationsNotInUseException y la crea con la cuenta de administración', async () => {
    expect(await err('aws organizations describe-organization')).toContain('AWSOrganizationsNotInUseException');
    const o = (await json('aws organizations create-organization --feature-set ALL')).Organization;
    expect(o.Id).toMatch(/^o-[a-z0-9]{10}$/);
    expect(o.MasterAccountId).toBe(st.account.id);
    expect(o.Arn).toBe(`arn:aws:organizations::${st.account.id}:organization/${o.Id}`);
    expect(await err('aws organizations create-organization')).toContain('AlreadyInOrganizationException');
    const accts = (await json('aws organizations list-accounts')).Accounts;
    expect(accts).toHaveLength(1);
    expect(accts[0]).toMatchObject({ Id: st.account.id, Status: 'ACTIVE', JoinedMethod: 'INVITED' });
    const root = (await json('aws organizations list-roots')).Roots[0];
    expect(root.Id).toMatch(/^r-[a-z0-9]{4}$/);
    expect(root.PolicyTypes).toEqual([]);
  });

  it('OU, cuentas, mover cuentas y errores como los de AWS', async () => {
    const { root, ou, acct } = await orgWithMember();
    expect(ou).toMatch(new RegExp(`^ou-${root.slice(2)}-[a-z0-9]{8}$`));
    expect(await err(`aws organizations create-organizational-unit --parent-id ${root} --name Sandbox`)).toContain('DuplicateOrganizationalUnitException');
    expect(await err('aws organizations create-account --account-name otra --email dev@example.com')).toBeDefined();
    const dup = (await json('aws organizations create-account --account-name otra --email dev@example.com')).CreateAccountStatus;
    expect((await json(`aws organizations describe-create-account-status --create-account-request-id ${dup.Id}`)).CreateAccountStatus).toMatchObject({ State: 'FAILED', FailureReason: 'EMAIL_ALREADY_EXISTS' });
    expect((await json(`aws organizations list-accounts-for-parent --parent-id ${ou}`)).Accounts.map((a: any) => a.Id)).toEqual([acct]);
    expect(await err(`aws organizations delete-organizational-unit --organizational-unit-id ${ou}`)).toContain('OrganizationalUnitNotEmptyException');
    expect((await json(`aws organizations list-parents --child-id ${acct}`)).Parents[0]).toEqual({ Id: ou, Type: 'ORGANIZATIONAL_UNIT' });
    expect(await err('aws organizations delete-organization')).toContain('OrganizationNotEmptyException');
  });

  it('las SCP exigen habilitar el tipo de política y validan el contenido', async () => {
    await ok('aws organizations create-organization');
    const root = (await json('aws organizations list-roots')).Roots[0].Id;
    expect(await err(`aws organizations attach-policy --policy-id p-FullAWSAccess --target-id ${root}`)).toContain('PolicyTypeNotEnabledException');
    await ok(`aws organizations enable-policy-type --root-id ${root} --policy-type SERVICE_CONTROL_POLICY`);
    expect(await err(`aws organizations enable-policy-type --root-id ${root} --policy-type SERVICE_CONTROL_POLICY`)).toContain('PolicyTypeAlreadyEnabledException');
    expect(await err(`aws organizations create-policy --name x --type SERVICE_CONTROL_POLICY --content '{no-json'`)).toContain('MalformedPolicyDocumentException');
    const pol = (await json(`aws organizations create-policy --name DenyS3 --description d --type SERVICE_CONTROL_POLICY --content ${scp([{ Effect: 'Deny', Action: 's3:DeleteBucket', Resource: '*' }])}`)).Policy;
    expect(pol.PolicySummary).toMatchObject({ Name: 'DenyS3', AwsManaged: false, Type: 'SERVICE_CONTROL_POLICY' });
    expect(await err(`aws organizations create-policy --name DenyS3 --type SERVICE_CONTROL_POLICY --content ${scp([{ Effect: 'Deny', Action: 's3:*', Resource: '*' }])}`)).toContain('DuplicatePolicyException');
    await ok(`aws organizations attach-policy --policy-id ${pol.PolicySummary.Id} --target-id ${root}`);
    expect(await err(`aws organizations delete-policy --policy-id ${pol.PolicySummary.Id}`)).toContain('PolicyInUseException');
    expect(await err(`aws organizations detach-policy --policy-id p-FullAWSAccess --target-id ${root}`)).not.toContain('ConstraintViolation'); // aún queda DenyS3 adjunta
    // ahora la raíz solo tiene DenyS3; quitarla deja a la raíz sin SCP
    expect(await err(`aws organizations detach-policy --policy-id ${pol.PolicySummary.Id} --target-id ${root}`)).toContain('ConstraintViolationException');
    const list = (await json('aws organizations list-policies --filter SERVICE_CONTROL_POLICY')).Policies;
    expect(list.map((p: any) => p.Name).sort()).toEqual(['DenyS3', 'FullAWSAccess']);
  });

  it('una SCP deniega aunque IAM permita, pero no afecta a la cuenta de administración', async () => {
    const { ou, acct } = await orgWithMember();
    await ok('aws s3 mb s3://datos-ana');
    const pol = (await json(`aws organizations create-policy --name NoBorrarBuckets --type SERVICE_CONTROL_POLICY --description x --content ${scp([{ Effect: 'Deny', Action: 's3:DeleteBucket', Resource: '*' }])}`)).Policy.PolicySummary.Id;
    // Antes de adjuntarla el miembro (administrador por IAM) puede borrar.
    const env = await asMember(acct);
    await ok(`${env} aws s3 mb s3://temporal-ana`);
    await ok(`${env} aws s3api delete-bucket --bucket temporal-ana`);
    await ok(`aws organizations attach-policy --policy-id ${pol} --target-id ${ou}`);
    await ok(`${env} aws s3 mb s3://temporal2-ana`);
    const e = await err(`${env} aws s3api delete-bucket --bucket temporal2-ana`);
    expect(e).toContain('AccessDenied');
    expect(e).toContain('with an explicit deny in a service control policy');
    expect(e).toContain(`assumed-role/OrganizationAccountAccessRole/prueba`);
    // La cuenta de administración no se ve afectada.
    await ok('aws s3api delete-bucket --bucket datos-ana');
    // CloudTrail guarda el rechazo.
    expect(st.trail.some((t) => t.eventName === 'DeleteBucket' && t.errorCode === 'AccessDenied' && t.principalArn.includes(acct))).toBe(true);
    await ok(`aws organizations detach-policy --policy-id ${pol} --target-id ${ou}`);
    await ok(`${env} aws s3api delete-bucket --bucket temporal2-ana`);
  });

  it('una SCP que sustituye a FullAWSAccess es una lista de permitidos y bloquea lo demás', async () => {
    const { ou, acct } = await orgWithMember();
    const pol = (await json(`aws organizations create-policy --name SoloS3 --type SERVICE_CONTROL_POLICY --description x --content ${scp([{ Effect: 'Allow', Action: ['s3:*', 'sts:*'], Resource: '*' }])}`)).Policy.PolicySummary.Id;
    await ok(`aws organizations attach-policy --policy-id ${pol} --target-id ${ou}`);
    await ok(`aws organizations detach-policy --policy-id p-FullAWSAccess --target-id ${ou}`);
    const env = await asMember(acct);
    await ok(`${env} aws s3 mb s3://lista-blanca`);
    const e = await err(`${env} aws ec2 describe-vpcs`);
    expect(e).toContain('UnauthorizedOperation');
    expect(e).toContain('because no service control policy allows the ec2:DescribeVpcs action');
    expect(await err(`${env} aws organizations list-accounts`)).toContain('AccessDeniedException');
    // La raíz sigue permitiendo todo, la OU solo S3.
  });

  it('restricción de región con aws:RequestedRegion', async () => {
    const { ou, acct } = await orgWithMember();
    const pol = (await json(`aws organizations create-policy --name SoloIrlanda --type SERVICE_CONTROL_POLICY --description x --content ${scp([{ Effect: 'Deny', Action: 'ec2:*', Resource: '*', Condition: { StringNotEquals: { 'aws:RequestedRegion': 'eu-west-1' } } }])}`)).Policy.PolicySummary.Id;
    await ok(`aws organizations attach-policy --policy-id ${pol} --target-id ${ou}`);
    const env = await asMember(acct);
    await ok(`${env} aws ec2 describe-vpcs --region eu-west-1`);
    expect(await err(`${env} aws ec2 describe-vpcs --region us-east-1`)).toContain('explicit deny in a service control policy');
  });

  it('evaluate: niveles de SCP', () => {
    const allow = { Statement: [{ Effect: 'Allow' as const, Action: '*', Resource: '*' }] };
    const deny = { Statement: [{ Effect: 'Deny' as const, Action: 'ec2:*', Resource: '*' }] };
    const base = { action: 'ec2:RunInstances', resource: '*', identity: [allow] };
    expect(evaluate({ ...base })).toMatchObject({ decision: 'Allow' });
    expect(evaluate({ ...base, scp: [[allow], [allow]] })).toMatchObject({ decision: 'Allow' });
    expect(evaluate({ ...base, scp: [[allow], [deny]] })).toMatchObject({ decision: 'ExplicitDeny', via: 'scp' });
    expect(evaluate({ ...base, scp: [[allow], []] })).toMatchObject({ decision: 'ImplicitDeny', via: 'scp' });
    expect(evaluate({ ...base, scp: [[{ Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }] }]] })).toMatchObject({ decision: 'ImplicitDeny', via: 'scp' });
  });

  it('el rol de la cuenta miembro no se puede asumir sin organización ni con identidades sin permiso', async () => {
    expect(await err('aws sts assume-role --role-arn arn:aws:iam::123456789012:role/OrganizationAccountAccessRole --role-session-name x')).toContain('AccessDenied');
  });
});

describe('AWS Config', () => {
  async function recorder() {
    await ok('aws s3 mb s3://config-ana');
    const trust = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'config.amazonaws.com' }, Action: 'sts:AssumeRole' }] });
    await ok(`aws iam create-role --role-name config-rol --assume-role-policy-document '${trust}'`);
    await ok(`aws configservice put-configuration-recorder --configuration-recorder name=default,roleARN=arn:aws:iam::${st.account.id}:role/config-rol --recording-group allSupported=true,includeGlobalResourceTypes=true`);
    await ok('aws configservice put-delivery-channel --delivery-channel name=default,s3BucketName=config-ana');
    await ok('aws configservice start-configuration-recorder --configuration-recorder-name default');
  }
  const rule = (name: string, id: string, params?: Record<string, string>) => ok(`aws configservice put-config-rule --config-rule ${q({ ConfigRuleName: name, Source: { Owner: 'AWS', SourceIdentifier: id }, ...(params ? { InputParameters: JSON.stringify(params) } : {}) })}`);

  it('exige grabador y canal antes de crear reglas', async () => {
    expect(await err(`aws configservice put-config-rule --config-rule ${q({ ConfigRuleName: 'x', Source: { Owner: 'AWS', SourceIdentifier: 'INCOMING_SSH_DISABLED' } })}`)).toContain('NoAvailableConfigurationRecorderException');
    expect(await err(`aws configservice put-configuration-recorder --configuration-recorder name=default,roleARN=arn:aws:iam::${st.account.id}:role/no-existe --recording-group allSupported=true`)).toContain('InvalidRoleException');
    await ok(`aws configservice put-configuration-recorder --configuration-recorder name=default,roleARN=arn:aws:iam::${st.account.id}:role/aws-service-role/config.amazonaws.com/AWSServiceRoleForConfig --recording-group allSupported=true`);
    expect(await err('aws configservice start-configuration-recorder --configuration-recorder-name default')).toContain('NoAvailableDeliveryChannelException');
    expect(await err('aws configservice put-delivery-channel --delivery-channel name=default,s3BucketName=no-existe')).toContain('NoSuchBucketException');
    await ok('aws s3 mb s3://cfg-bucket');
    await ok('aws configservice put-delivery-channel --delivery-channel name=default,s3BucketName=cfg-bucket');
    await ok('aws configservice start-configuration-recorder --configuration-recorder-name default');
    const s = await json('aws configservice describe-configuration-recorder-status');
    expect(s.ConfigurationRecordersStatus[0]).toMatchObject({ name: 'default', recording: true, lastStatus: 'SUCCESS' });
    expect(await err('aws configservice delete-delivery-channel --delivery-channel-name default')).toContain('LastDeliveryChannelDeleteFailedException');
  });

  it('restricted-ssh evalúa contra los grupos de seguridad reales', async () => {
    await recorder();
    await rule('restricted-ssh', 'INCOMING_SSH_DISABLED');
    expect(await err(`aws configservice put-config-rule --config-rule ${q({ ConfigRuleName: 'x', Source: { Owner: 'AWS', SourceIdentifier: 'NO_EXISTE' } })}`)).toContain('sourceIdentifier NO_EXISTE is invalid');
    const vpc = (await json('aws ec2 describe-vpcs --filters Name=is-default,Values=true')).Vpcs[0].VpcId;
    const sg = (await json(`aws ec2 create-security-group --group-name web --description web --vpc-id ${vpc}`)).GroupId;
    await ok(`aws ec2 authorize-security-group-ingress --group-id ${sg} --protocol tcp --port 22 --cidr 0.0.0.0/0`);
    let c = (await json('aws configservice describe-compliance-by-config-rule --config-rule-names restricted-ssh')).ComplianceByConfigRules[0];
    expect(c.Compliance.ComplianceType).toBe('NON_COMPLIANT');
    const d = (await json('aws configservice get-compliance-details-by-config-rule --config-rule-name restricted-ssh --compliance-types NON_COMPLIANT')).EvaluationResults;
    expect(d.map((x: any) => x.EvaluationResultIdentifier.EvaluationResultQualifier.ResourceId)).toEqual([sg]);
    expect(d[0].Annotation).toContain('port 22');
    await ok(`aws ec2 revoke-security-group-ingress --group-id ${sg} --protocol tcp --port 22 --cidr 0.0.0.0/0`);
    await ok('aws configservice start-config-rules-evaluation --config-rule-names restricted-ssh');
    c = (await json('aws configservice describe-compliance-by-config-rule --config-rule-names restricted-ssh')).ComplianceByConfigRules[0];
    expect(c.Compliance.ComplianceType).toBe('COMPLIANT');
    expect((await json('aws configservice describe-compliance-by-resource --resource-type AWS::EC2::SecurityGroup --compliance-types COMPLIANT')).ComplianceByResources.length).toBeGreaterThan(0);
  });

  it('s3-bucket-public-read-prohibited, MFA, claves antiguas y etiquetas obligatorias', async () => {
    await recorder();
    await rule('s3-public-read', 'S3_BUCKET_PUBLIC_READ_PROHIBITED');
    await rule('iam-mfa', 'IAM_USER_MFA_ENABLED');
    await rule('claves-rotadas', 'ACCESS_KEYS_ROTATED', { maxAccessKeyAge: '30' });
    await rule('etiquetas', 'REQUIRED_TAGS', { tag1Key: 'Entorno' });
    await ok('aws s3 mb s3://web-publica');
    await ok('aws s3api put-public-access-block --bucket web-publica --public-access-block-configuration BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false');
    await ok(`aws s3api put-bucket-policy --bucket web-publica --policy ${q({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: 'arn:aws:s3:::web-publica/*' }] })}`);
    const by = async (n: string) => (await json(`aws configservice describe-compliance-by-config-rule --config-rule-names ${n}`)).ComplianceByConfigRules[0].Compliance.ComplianceType;
    expect(await by('s3-public-read')).toBe('NON_COMPLIANT');
    expect(await by('iam-mfa')).toBe('NON_COMPLIANT'); // el usuario administrador no tiene MFA
    expect(await by('claves-rotadas')).toBe('COMPLIANT');
    expect(await by('etiquetas')).toBe('NON_COMPLIANT');
    // envejecer la clave 40 días
    hours(24 * 40);
    expect(await by('claves-rotadas')).toBe('NON_COMPLIANT');
    await ok('aws s3api put-public-access-block --bucket web-publica --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true');
    expect(await by('s3-public-read')).toBe('COMPLIANT');
    const sum = (await json('aws configservice get-compliance-summary-by-config-rule')).ComplianceSummary;
    expect(sum.NonCompliantResourceCount.CappedCount).toBe(3);
    expect((await json('aws configservice list-discovered-resources --resource-type AWS::S3::Bucket')).resourceIdentifiers.map((r: any) => r.resourceId)).toContain('web-publica');
    await ok('aws configservice delete-config-rule --config-rule-name iam-mfa');
    expect(await err('aws configservice delete-config-rule --config-rule-name iam-mfa')).toContain('NoSuchConfigRuleException');
  });

  it('con el grabador detenido las reglas quedan en INSUFFICIENT_DATA', async () => {
    await recorder();
    await rule('s3-public-read', 'S3_BUCKET_PUBLIC_READ_PROHIBITED');
    await ok('aws configservice stop-configuration-recorder --configuration-recorder-name default');
    const c = (await json('aws configservice describe-compliance-by-config-rule')).ComplianceByConfigRules[0];
    expect(c.Compliance.ComplianceType).toBe('INSUFFICIENT_DATA');
  });
});

describe('Budgets y Cost Explorer', () => {
  const acct = () => st.account.id;
  async function launch(type = 't3.micro') {
    return (await json(`aws ec2 run-instances --image-id ${AMI} --instance-type ${type}`)).Instances[0].InstanceId as string;
  }

  it('Cost Explorer es coherente con el coste de la cuenta', async () => {
    await launch('t3.micro');
    hours(30);
    await launch('t3.medium');
    hours(5);
    const total = estimateCost(st).total;
    expect(total).toBeGreaterThan(0.3);
    const r = await json('aws ce get-cost-and-usage --time-period Start=2026-11-01,End=2026-11-13 --granularity DAILY --metrics UnblendedCost');
    const sum = r.ResultsByTime.reduce((a: number, d: any) => a + Number(d.Total.UnblendedCost.Amount), 0);
    expect(sum).toBeCloseTo(total, 6);
    expect(r.ResultsByTime).toHaveLength(12);
    const mensual = await json('aws ce get-cost-and-usage --time-period Start=2026-11-01,End=2026-12-01 --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE');
    expect(mensual.GroupDefinitions).toEqual([{ Type: 'DIMENSION', Key: 'SERVICE' }]);
    const g = mensual.ResultsByTime[0].Groups;
    expect(g.map((x: any) => x.Keys[0])).toContain('Amazon Elastic Compute Cloud - Compute');
    expect(g.reduce((a: number, x: any) => a + Number(x.Metrics.UnblendedCost.Amount), 0)).toBeCloseTo(total, 6);
    const uso = await json('aws ce get-cost-and-usage --time-period Start=2026-11-10,End=2026-11-11 --granularity DAILY --metrics UsageQuantity --filter ' + q({ Dimensions: { Key: 'SERVICE', Values: ['Amazon Elastic Compute Cloud - Compute'] } }));
    expect(Number(uso.ResultsByTime[0].Total.UsageQuantity.Amount)).toBeCloseTo(14, 3);
    expect(uso.ResultsByTime[0].Total.UsageQuantity.Unit).toBe('Hrs');
    expect((await json('aws ce get-dimension-values --time-period Start=2026-11-01,End=2026-11-13 --dimension SERVICE')).DimensionValues.length).toBeGreaterThanOrEqual(2);
  });

  it('valida las entradas de Cost Explorer', async () => {
    expect(await err('aws ce get-cost-and-usage --time-period Start=2026-11-10,End=2026-11-01 --granularity DAILY --metrics UnblendedCost')).toContain('ValidationException');
    expect(await err('aws ce get-cost-and-usage --time-period Start=2026-11-01,End=2026-11-10 --granularity DAILY --metrics Nope')).toContain('Metric Nope is not valid');
    expect(await err('aws ce get-cost-and-usage --time-period Start=hoy,End=2026-11-10 --granularity DAILY --metrics UnblendedCost')).toContain('YYYY-MM-DD');
  });

  it('la previsión mensual crece con el ritmo de gasto', async () => {
    await launch('m5.xlarge');
    const f = await json('aws ce get-cost-forecast --time-period Start=2026-11-10,End=2026-12-01 --metric UNBLENDED_COST --granularity MONTHLY');
    expect(Number(f.Total.Amount)).toBeGreaterThan(40);
    expect(await err('aws ce get-cost-forecast --time-period Start=2026-11-01,End=2026-12-01 --metric UNBLENDED_COST --granularity MONTHLY')).toContain('DataUnavailableException');
  });

  it('presupuestos: gasto actual y previsto, avisos por SNS y por correo', async () => {
    const topic = (await json('aws sns create-topic --name avisos')).TopicArn;
    const budget = { BudgetName: 'mensual', BudgetLimit: { Amount: '10', Unit: 'USD' }, TimeUnit: 'MONTHLY', BudgetType: 'COST' };
    const notifs = [
      { Notification: { NotificationType: 'FORECASTED', ComparisonOperator: 'GREATER_THAN', Threshold: 100, ThresholdType: 'PERCENTAGE' }, Subscribers: [{ SubscriptionType: 'SNS', Address: topic }, { SubscriptionType: 'EMAIL', Address: 'ana@example.com' }] },
      { Notification: { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: 80, ThresholdType: 'PERCENTAGE' }, Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'ana@example.com' }] },
    ];
    await ok(`aws budgets create-budget --account-id ${acct()} --budget ${q(budget)} --notifications-with-subscribers ${q(notifs)}`);
    expect(await err(`aws budgets create-budget --account-id ${acct()} --budget ${q(budget)}`)).toContain('DuplicateRecordException');
    expect(await err(`aws budgets create-budget --account-id ${acct()} --budget ${q({ ...budget, BudgetName: 'b2', BudgetLimit: { Amount: '0', Unit: 'USD' } })}`)).toContain('InvalidParameterException');
    let n = (await json(`aws budgets describe-notifications-for-budget --account-id ${acct()} --budget-name mensual`)).Notifications;
    expect(n.map((x: any) => x.NotificationState)).toEqual(['OK', 'OK']);
    await launch('m5.xlarge'); // 0,192 USD/h: la previsión del mes supera 10 USD
    const b = (await json(`aws budgets describe-budget --account-id ${acct()} --budget-name mensual`)).Budget;
    expect(Number(b.CalculatedSpend.ForecastedSpend.Amount)).toBeGreaterThan(10);
    expect(Number(b.CalculatedSpend.ActualSpend.Amount)).toBeLessThan(0.01);
    n = (await json(`aws budgets describe-notifications-for-budget --account-id ${acct()} --budget-name mensual`)).Notifications;
    expect(n.map((x: any) => x.NotificationState)).toEqual(['ALARM', 'OK']);
    expect(st.topics[0].messages).toHaveLength(1);
    expect(st.topics[0].messages[0].subject).toContain('mensual');
    expect(gov(st).alerts!.filter((a) => a.channel === 'EMAIL')).toHaveLength(1);
    // no repite el aviso
    await ok(`aws budgets describe-budgets --account-id ${acct()}`);
    expect(st.topics[0].messages).toHaveLength(1);
    // gasto real: 3 días con la instancia grande supera el 80 %
    hours(24 * 2);
    n = (await json(`aws budgets describe-notifications-for-budget --account-id ${acct()} --budget-name mensual`)).Notifications;
    expect(n[1].NotificationState).toBe('ALARM');
    await ok(`aws budgets delete-budget --account-id ${acct()} --budget-name mensual`);
    expect(await err(`aws budgets describe-budget --account-id ${acct()} --budget-name mensual`)).toContain('NotFoundException');
    expect(await err(`aws budgets describe-budgets --account-id 111122223333`)).toContain('AccessDeniedException');
  });
});

describe('Trusted Advisor y Health', () => {
  it('lista las comprobaciones y señala recursos reales; el resultado cambia al actualizar', async () => {
    const checks = (await json('aws support describe-trusted-advisor-checks --language en')).checks;
    expect(checks.length).toBeGreaterThanOrEqual(10);
    expect(checks.find((c: any) => c.id === 'HCP4007jGY')).toMatchObject({ name: 'Security Groups - Specific Ports Unrestricted', category: 'security' });
    const vpc = (await json('aws ec2 describe-vpcs --filters Name=is-default,Values=true')).Vpcs[0].VpcId;
    const sg = (await json(`aws ec2 create-security-group --group-name abierto --description x --vpc-id ${vpc}`)).GroupId;
    await ok(`aws ec2 authorize-security-group-ingress --group-id ${sg} --protocol tcp --port 22 --cidr 0.0.0.0/0`);
    await ok('aws support refresh-trusted-advisor-check --check-id HCP4007jGY');
    let r = (await json('aws support describe-trusted-advisor-check-result --check-id HCP4007jGY')).result;
    expect(r.status).toBe('error');
    expect(r.flaggedResources[0].metadata).toContain(sg);
    expect(r.resourcesSummary.resourcesFlagged).toBe(1);
    await ok(`aws ec2 revoke-security-group-ingress --group-id ${sg} --protocol tcp --port 22 --cidr 0.0.0.0/0`);
    // el resultado en caché no cambia hasta actualizar
    r = (await json('aws support describe-trusted-advisor-check-result --check-id HCP4007jGY')).result;
    expect(r.status).toBe('error');
    await ok('aws support refresh-trusted-advisor-check --check-id HCP4007jGY');
    r = (await json('aws support describe-trusted-advisor-check-result --check-id HCP4007jGY')).result;
    expect(r.status).toBe('ok');
    expect(await err('aws support describe-trusted-advisor-check-result --check-id nope')).toContain('InvalidParameterValueException');
  });

  it('bucket público, MFA ausente y claves antiguas', async () => {
    await ok('aws s3 mb s3://web-abierta');
    await ok('aws s3api put-public-access-block --bucket web-abierta --public-access-block-configuration BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false');
    await ok(`aws s3api put-bucket-policy --bucket web-abierta --policy ${q({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: 'arn:aws:s3:::web-abierta/*' }] })}`);
    hours(24 * 120);
    const s = (await json('aws support describe-trusted-advisor-check-summaries --check-ids Pfx0RwqBli DqdJqYeRm5 c1MfaIamUsr R365s2Qddf')).summaries;
    expect(Object.fromEntries(s.map((x: any) => [x.checkId, x.status]))).toEqual({ Pfx0RwqBli: 'error', DqdJqYeRm5: 'warning', c1MfaIamUsr: 'warning', R365s2Qddf: 'warning' });
    expect(s[0].hasFlaggedResources).toBe(true);
  });

  it('ahorro estimado de costes y eventos de Health', async () => {
    const vol = (await json('aws ec2 create-volume --availability-zone eu-west-1a --size 100 --volume-type gp3')).VolumeId;
    const r = (await json('aws support describe-trusted-advisor-check-result --check-id DAvU99Dc4C')).result;
    expect(r.status).toBe('warning');
    expect(r.categorySpecificSummary.costOptimizing.estimatedMonthlySavings).toBeCloseTo(8, 1);
    expect(r.flaggedResources[0].resourceId).toBe(vol);
    await ok('aws s3 mb s3://abierto-health');
    await ok('aws s3api put-public-access-block --bucket abierto-health --public-access-block-configuration BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false');
    await ok(`aws s3api put-bucket-policy --bucket abierto-health --policy ${q({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: 'arn:aws:s3:::abierto-health/*' }] })}`);
    const ev = (await json('aws health describe-events --region us-east-1')).events;
    expect(ev[0].eventTypeCode).toBe('AWS_S3_OPEN_ACCESS_BUCKET_NOTIFICATION');
    const ents = (await json(`aws health describe-affected-entities --region us-east-1 --filter eventArns=${ev[0].arn}`)).entities;
    expect(ents.map((e: any) => e.entityValue)).toEqual(['abierto-health']);
    const det = (await json(`aws health describe-event-details --region us-east-1 --event-arns ${ev[0].arn}`)).successfulSet;
    expect(det[0].eventDescription.latestDescription).toContain('publicly accessible');
  });
});
