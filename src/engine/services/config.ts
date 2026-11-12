// AWS Config: grabador de configuración, canal de entrega y reglas gestionadas que se evalúan contra el estado real de la cuenta.
// Simplificación documentada: la evaluación es continua (se recalcula al consultar), sin esperar a las ventanas reales de AWS.
import type { CloudState } from '../types';
import { AwsError } from '../errors';
import { authorize, trailed, type Ctx } from '../api';
import { nowIso, randomString } from '../util';
import { gov, type ConfigRecorder, type ConfigRule, type DeliveryChannel } from './govTypes';
import { bucketBlocksAllPublic, bucketPublicRead, bucketPublicWrite, bucketRequiresTls, activeKeyAges, hasConsole, hasMfa, liveInstances, sgOpenToWorldOn, ruleOpensPort, trailLogging } from './govFindings';

const SRC = 'config.amazonaws.com';

export type Compliance = 'COMPLIANT' | 'NON_COMPLIANT' | 'NOT_APPLICABLE' | 'INSUFFICIENT_DATA';
export interface Evaluation { type: string; id: string; name?: string; ok: boolean; annotation?: string }

const T = { bucket: 'AWS::S3::Bucket', sg: 'AWS::EC2::SecurityGroup', user: 'AWS::IAM::User', inst: 'AWS::EC2::Instance', vol: 'AWS::EC2::Volume', acct: 'AWS::::Account', key: 'AWS::KMS::Key' };
export const RESOURCE_TYPES = Object.values(T);

interface Managed {
  description: string;
  types: string[];
  defaults?: Record<string, string>;
  run(s: CloudState, p: Record<string, string>): Evaluation[];
}

const bucketEval = (s: CloudState, f: (b: CloudState['buckets'][number]) => boolean | string): Evaluation[] =>
  s.buckets.map((b) => {
    const r = f(b);
    return { type: T.bucket, id: b.name, name: b.name, ok: r === true, annotation: r === true ? undefined : typeof r === 'string' ? r : undefined };
  });

const userEval = (s: CloudState, f: (u: CloudState['users'][number]) => boolean | string, only?: (u: CloudState['users'][number]) => boolean): Evaluation[] =>
  s.users.filter((u) => !only || only(u)).map((u) => {
    const r = f(u);
    return { type: T.user, id: u.id, name: u.name, ok: r === true, annotation: r === true ? undefined : typeof r === 'string' ? r : undefined };
  });

const acctEval = (s: CloudState, ok: boolean, annotation: string): Evaluation[] => [{ type: T.acct, id: s.account.id, ok, annotation: ok ? undefined : annotation }];

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

export const MANAGED: Record<string, Managed> = {
  S3_BUCKET_PUBLIC_READ_PROHIBITED: { description: 'Checks that your S3 buckets do not allow public read access.', types: [T.bucket], run: (s) => bucketEval(s, (b) => !bucketPublicRead(b) || 'The S3 bucket allows public read access.') },
  S3_BUCKET_PUBLIC_WRITE_PROHIBITED: { description: 'Checks that your S3 buckets do not allow public write access.', types: [T.bucket], run: (s) => bucketEval(s, (b) => !bucketPublicWrite(b) || 'The S3 bucket allows public write access.') },
  S3_BUCKET_LEVEL_PUBLIC_ACCESS_PROHIBITED: { description: 'Checks that S3 buckets have all four Block Public Access settings enabled.', types: [T.bucket], run: (s) => bucketEval(s, (b) => bucketBlocksAllPublic(b) || 'The bucket does not block all public access.') },
  S3_BUCKET_SERVER_SIDE_ENCRYPTION_ENABLED: { description: 'Checks that your S3 buckets have default server-side encryption configured.', types: [T.bucket], run: (s) => bucketEval(s, (b) => !!b.encryption || 'Default encryption is not configured.') },
  S3_BUCKET_VERSIONING_ENABLED: { description: 'Checks whether versioning is enabled for your S3 buckets.', types: [T.bucket], run: (s) => bucketEval(s, (b) => b.versioning === 'Enabled' || 'Versioning is not enabled.') },
  S3_BUCKET_SSL_REQUESTS_ONLY: { description: 'Checks whether S3 buckets have policies that require requests to use SSL.', types: [T.bucket], run: (s) => bucketEval(s, (b) => bucketRequiresTls(b) || 'The bucket policy does not deny non-TLS requests.') },
  INCOMING_SSH_DISABLED: {
    description: 'Checks whether the incoming SSH traffic for the security groups is accessible. The rule is COMPLIANT when IP addresses of the incoming SSH traffic in the security groups are restricted.',
    types: [T.sg],
    run: (s) => s.securityGroups.map((g) => ({ type: T.sg, id: g.id, name: g.name, ok: !sgOpenToWorldOn(g, 22), annotation: sgOpenToWorldOn(g, 22) ? 'The security group allows SSH (port 22) from 0.0.0.0/0.' : undefined })),
  },
  RESTRICTED_INCOMING_TRAFFIC: {
    description: 'Checks whether security groups that are in use disallow unrestricted incoming TCP traffic to the specified ports.',
    types: [T.sg],
    defaults: { blockedPort1: '20', blockedPort2: '21', blockedPort3: '3389', blockedPort4: '3306', blockedPort5: '4333' },
    run: (s, p) => {
      const ports = [1, 2, 3, 4, 5].map((i) => num(p[`blockedPort${i}`], 0)).filter(Boolean);
      return s.securityGroups.map((g) => {
        const bad = ports.filter((port) => g.ingress.some((r) => ruleOpensPort(r, port)));
        return { type: T.sg, id: g.id, name: g.name, ok: !bad.length, annotation: bad.length ? `Unrestricted incoming traffic on port(s) ${bad.join(', ')}.` : undefined };
      });
    },
  },
  VPC_DEFAULT_SECURITY_GROUP_CLOSED: {
    description: 'Checks that the default security group of any Amazon Virtual Private Cloud (VPC) does not allow inbound or outbound traffic.',
    types: [T.sg],
    run: (s) => s.securityGroups.filter((g) => g.name === 'default').map((g) => ({ type: T.sg, id: g.id, name: g.name, ok: !g.ingress.length && !g.egress.length, annotation: g.ingress.length || g.egress.length ? 'The default security group has inbound or outbound rules.' : undefined })),
  },
  IAM_USER_MFA_ENABLED: { description: 'Checks whether the AWS Identity and Access Management users have multi-factor authentication (MFA) enabled.', types: [T.user], run: (s) => userEval(s, (u) => hasMfa(u) || 'The user has no MFA device.') },
  MFA_ENABLED_FOR_IAM_CONSOLE_ACCESS: { description: 'Checks whether AWS Multi-Factor Authentication (MFA) is enabled for all IAM users that use a console password.', types: [T.user], run: (s) => userEval(s, (u) => hasMfa(u) || 'The user can sign in to the console without MFA.', hasConsole) },
  ACCESS_KEYS_ROTATED: {
    description: 'Checks whether the active access keys are rotated within the number of days specified in maxAccessKeyAge.',
    types: [T.user],
    defaults: { maxAccessKeyAge: '90' },
    run: (s, p) => {
      const max = num(p.maxAccessKeyAge, 90);
      return userEval(s, (u) => { const old = activeKeyAges(u).filter((k) => k.days > max); return !old.length || `Access key ${old[0].id} has not been rotated for ${old[0].days} days.`; });
    },
  },
  IAM_USER_NO_POLICIES_CHECK: { description: 'Checks that none of your IAM users have policies attached. IAM users must inherit permissions from IAM groups or roles.', types: [T.user], run: (s) => userEval(s, (u) => (!u.attached.length && !Object.keys(u.inline).length) || 'The user has policies attached directly.') },
  IAM_PASSWORD_POLICY: {
    description: 'Checks whether the account password policy for IAM users meets the specified requirements.',
    types: [T.acct],
    defaults: { RequireUppercaseCharacters: 'true', RequireLowercaseCharacters: 'true', RequireSymbols: 'true', RequireNumbers: 'true', MinimumPasswordLength: '14' },
    run: (s, p) => {
      const pp = s.passwordPolicy;
      const need = (k: string) => (p[k] ?? 'true') !== 'false';
      const ok = !!pp && (!need('RequireUppercaseCharacters') || pp.RequireUppercaseCharacters) && (!need('RequireLowercaseCharacters') || pp.RequireLowercaseCharacters) && (!need('RequireSymbols') || pp.RequireSymbols) && (!need('RequireNumbers') || pp.RequireNumbers) && pp.MinimumPasswordLength >= num(p.MinimumPasswordLength, 14);
      return acctEval(s, ok, pp ? 'The account password policy does not meet the requirements.' : 'The account has no password policy.');
    },
  },
  EC2_IMDSV2_CHECK: { description: 'Checks whether your Amazon EC2 instance metadata version is configured with Instance Metadata Service Version 2 (IMDSv2).', types: [T.inst], run: (s) => liveInstances(s).map((i) => ({ type: T.inst, id: i.id, name: i.tags.Name, ok: i.httpTokens === 'required', annotation: i.httpTokens === 'required' ? undefined : 'HttpTokens is optional: IMDSv2 is not required.' })) },
  EC2_INSTANCE_NO_PUBLIC_IP: { description: 'Checks whether Amazon EC2 instances have a public IP association.', types: [T.inst], run: (s) => liveInstances(s).map((i) => ({ type: T.inst, id: i.id, name: i.tags.Name, ok: !i.publicIp, annotation: i.publicIp ? 'The instance has a public IP address.' : undefined })) },
  ENCRYPTED_VOLUMES: { description: 'Checks whether the EBS volumes that are in an attached state are encrypted.', types: [T.vol], run: (s) => s.volumes.filter((v) => v.state === 'in-use').map((v) => ({ type: T.vol, id: v.id, ok: v.encrypted, annotation: v.encrypted ? undefined : 'The EBS volume is not encrypted.' })) },
  CLOUD_TRAIL_ENABLED: { description: 'Checks whether AWS CloudTrail is enabled in your AWS account.', types: [T.acct], run: (s) => acctEval(s, trailLogging(s), 'No CloudTrail trail is logging.') },
  CMK_BACKING_KEY_ROTATION_ENABLED: { description: 'Checks that key rotation is enabled for each customer managed key that is in the Enabled state.', types: [T.key], run: (s) => s.kmsKeys.filter((k) => k.manager === 'CUSTOMER' && k.state === 'Enabled').map((k) => ({ type: T.key, id: k.id, ok: k.rotation, annotation: k.rotation ? undefined : 'Key rotation is not enabled.' })) },
  REQUIRED_TAGS: {
    description: 'Checks whether your resources have the tags that you specify.',
    types: [T.inst, T.vol, T.sg, T.bucket],
    defaults: { tag1Key: 'Entorno' },
    run: (s, p) => {
      const req: { k: string; v?: string[] }[] = [1, 2, 3, 4, 5, 6].filter((i) => p[`tag${i}Key`]).map((i) => ({ k: p[`tag${i}Key`], v: p[`tag${i}Value`] ? p[`tag${i}Value`].split(',').map((x) => x.trim()) : undefined }));
      const chk = (tags: Record<string, string>) => { const miss = req.filter((r) => tags[r.k] === undefined || (r.v && !r.v.includes(tags[r.k]))).map((r) => r.k); return miss.length ? `Missing or invalid tag(s): ${miss.join(', ')}.` : true; };
      const out: Evaluation[] = [];
      for (const i of liveInstances(s)) { const r = chk(i.tags); out.push({ type: T.inst, id: i.id, name: i.tags.Name, ok: r === true, annotation: r === true ? undefined : r }); }
      for (const v of s.volumes) { const r = chk(v.tags); out.push({ type: T.vol, id: v.id, ok: r === true, annotation: r === true ? undefined : r }); }
      for (const g of s.securityGroups) { const r = chk(g.tags); out.push({ type: T.sg, id: g.id, name: g.name, ok: r === true, annotation: r === true ? undefined : r }); }
      for (const b of s.buckets) { const r = chk(b.tags); out.push({ type: T.bucket, id: b.name, name: b.name, ok: r === true, annotation: r === true ? undefined : r }); }
      return out;
    },
  },
};

// ------------------------------------------------------------------ acceso al estado

const cfg = (s: CloudState) => gov(s).config;
const ruleArn = (ctx: Ctx, id: string) => `arn:aws:config:${ctx.region}:${ctx.s.account.id}:config-rule/${id}`;

/** Evaluaciones actuales de una regla (vacío si el grabador no está grabando). */
export function evaluateRule(s: CloudState, rule: ConfigRule): Evaluation[] {
  const rec = cfg(s).recorder;
  if (!rec?.recording) return [];
  const def = MANAGED[rule.identifier];
  const types = rule.scopeTypes?.length ? rule.scopeTypes : def.types;
  return def.run(s, { ...def.defaults, ...rule.inputParameters }).filter((e) => types.includes(e.type));
}

export function ruleCompliance(s: CloudState, rule: ConfigRule): Compliance {
  const ev = evaluateRule(s, rule);
  if (!ev.length) return 'INSUFFICIENT_DATA';
  return ev.some((e) => !e.ok) ? 'NON_COMPLIANT' : 'COMPLIANT';
}

export const ruleByName = (s: CloudState, name: string) => cfg(s).rules.find((r) => r.name === name);

function needRule(ctx: Ctx, name: string): ConfigRule {
  const r = ruleByName(ctx.s, name);
  if (!r) throw new AwsError('NoSuchConfigRuleException', `The ConfigRule '${name}' provided in the request is invalid. Please check the configRule name`, 400);
  return r;
}

// ------------------------------------------------------------------ grabador y canal de entrega

const ROLE_ARN = /^arn:aws:iam::(\d{12}):role\/(.+)$/;

export function putConfigurationRecorder(ctx: Ctx, p: { name?: string; roleARN: string; recordingGroup?: { allSupported?: boolean; includeGlobalResourceTypes?: boolean; resourceTypes?: string[] } }): void {
  trailed(ctx, SRC, 'PutConfigurationRecorder', [], { name: p.name }, () => {
    authorize(ctx, 'config:PutConfigurationRecorder', '*');
    const c = cfg(ctx.s);
    const name = p.name ?? 'default';
    const m = ROLE_ARN.exec(p.roleARN ?? '');
    if (!m) throw new AwsError('ValidationException', `1 validation error detected: Value '${p.roleARN}' at 'configurationRecorder.roleARN' failed to satisfy constraint: Member must satisfy regular expression pattern`, 400);
    const slr = m[2].startsWith('aws-service-role/config.amazonaws.com/');
    if (!slr && !ctx.s.roles.some((r) => r.arn === p.roleARN)) throw new AwsError('InvalidRoleException', `Provided role ${p.roleARN} is invalid: role does not exist.`, 400);
    if (c.recorder && c.recorder.name !== name) throw new AwsError('MaxNumberOfConfigurationRecordersExceededException', 'Failed to put configuration recorder because you have reached the limit for the maximum number of configuration recorders: 1. Delete the existing recorder before creating a new one.', 400);
    const rg = p.recordingGroup ?? { allSupported: true, includeGlobalResourceTypes: true };
    const allSupported = rg.allSupported ?? !rg.resourceTypes?.length;
    if (!allSupported && !rg.resourceTypes?.length) throw new AwsError('InvalidRecordingGroupException', 'Provide at least one resource type in resourceTypes or set allSupported=true.', 400);
    const rec: ConfigRecorder = { name, roleArn: p.roleARN, allSupported, includeGlobal: rg.includeGlobalResourceTypes ?? allSupported, resourceTypes: allSupported ? [] : rg.resourceTypes ?? [], recording: c.recorder?.recording ?? false, lastStartAt: c.recorder?.lastStartAt, lastStopAt: c.recorder?.lastStopAt };
    c.recorder = rec;
  });
}
export function describeConfigurationRecorders(ctx: Ctx): ConfigRecorder[] {
  return trailed(ctx, SRC, 'DescribeConfigurationRecorders', [], {}, () => {
    authorize(ctx, 'config:DescribeConfigurationRecorders', '*');
    const r = cfg(ctx.s).recorder;
    return r ? [r] : [];
  });
}
export function startConfigurationRecorder(ctx: Ctx, p: { ConfigurationRecorderName: string }, on: boolean): void {
  trailed(ctx, SRC, on ? 'StartConfigurationRecorder' : 'StopConfigurationRecorder', [], p, () => {
    authorize(ctx, on ? 'config:StartConfigurationRecorder' : 'config:StopConfigurationRecorder', '*');
    const c = cfg(ctx.s);
    if (!c.recorder || c.recorder.name !== p.ConfigurationRecorderName) throw new AwsError('NoSuchConfigurationRecorderException', `Cannot find configuration recorder with the specified name '${p.ConfigurationRecorderName}'.`, 400);
    if (on) {
      if (!c.channel) throw new AwsError('NoAvailableDeliveryChannelException', 'Cannot find a delivery channel to start the configuration recorder. Create a delivery channel first.', 400);
      c.recorder.recording = true;
      c.recorder.lastStartAt = nowIso();
    } else {
      c.recorder.recording = false;
      c.recorder.lastStopAt = nowIso();
    }
  });
}
export function deleteConfigurationRecorder(ctx: Ctx, p: { ConfigurationRecorderName: string }): void {
  trailed(ctx, SRC, 'DeleteConfigurationRecorder', [], p, () => {
    authorize(ctx, 'config:DeleteConfigurationRecorder', '*');
    const c = cfg(ctx.s);
    if (!c.recorder || c.recorder.name !== p.ConfigurationRecorderName) throw new AwsError('NoSuchConfigurationRecorderException', `Cannot find configuration recorder with the specified name '${p.ConfigurationRecorderName}'.`, 400);
    delete c.recorder;
  });
}
export function putDeliveryChannel(ctx: Ctx, p: { name?: string; s3BucketName: string; s3KeyPrefix?: string; snsTopicARN?: string }): void {
  trailed(ctx, SRC, 'PutDeliveryChannel', [], { name: p.name, s3BucketName: p.s3BucketName }, () => {
    authorize(ctx, 'config:PutDeliveryChannel', '*');
    const c = cfg(ctx.s);
    if (!c.recorder) throw new AwsError('NoAvailableConfigurationRecorderException', 'Configuration recorder is not available to put delivery channel.', 400);
    if (!ctx.s.buckets.some((b) => b.name === p.s3BucketName)) throw new AwsError('NoSuchBucketException', `Cannot find a S3 bucket with an name ${p.s3BucketName}`, 400);
    if (p.snsTopicARN && !ctx.s.topics.some((t) => t.arn === p.snsTopicARN)) throw new AwsError('InsufficientDeliveryPolicyException', `Insufficient delivery policy to SNS topic: ${p.snsTopicARN}`, 400);
    const name = p.name ?? 'default';
    if (c.channel && c.channel.name !== name) throw new AwsError('MaxNumberOfDeliveryChannelsExceededException', 'Failed to put delivery channel because the maximum number of delivery channels: 1 is reached.', 400);
    c.channel = { name, s3Bucket: p.s3BucketName, s3Prefix: p.s3KeyPrefix, snsTopicArn: p.snsTopicARN };
  });
}
export function describeDeliveryChannels(ctx: Ctx): DeliveryChannel[] {
  return trailed(ctx, SRC, 'DescribeDeliveryChannels', [], {}, () => {
    authorize(ctx, 'config:DescribeDeliveryChannels', '*');
    const ch = cfg(ctx.s).channel;
    return ch ? [ch] : [];
  });
}
export function deleteDeliveryChannel(ctx: Ctx, p: { DeliveryChannelName: string }): void {
  trailed(ctx, SRC, 'DeleteDeliveryChannel', [], p, () => {
    authorize(ctx, 'config:DeleteDeliveryChannel', '*');
    const c = cfg(ctx.s);
    if (!c.channel || c.channel.name !== p.DeliveryChannelName) throw new AwsError('NoSuchDeliveryChannelException', `Cannot find delivery channel with specified name '${p.DeliveryChannelName}'.`, 400);
    if (c.recorder?.recording) throw new AwsError('LastDeliveryChannelDeleteFailedException', `Failed to delete last specified delivery channel with name '${p.DeliveryChannelName}', because there, is a running configuration recorder.`, 400);
    delete c.channel;
  });
}

// ------------------------------------------------------------------ reglas

export function putConfigRule(ctx: Ctx, p: { ConfigRule: { ConfigRuleName: string; Description?: string; Scope?: { ComplianceResourceTypes?: string[] }; Source: { Owner: string; SourceIdentifier: string }; InputParameters?: string | Record<string, string>; MaximumExecutionFrequency?: string } }): void {
  trailed(ctx, SRC, 'PutConfigRule', [], { ConfigRuleName: p.ConfigRule?.ConfigRuleName }, () => {
    authorize(ctx, 'config:PutConfigRule', '*');
    const r = p.ConfigRule;
    if (!r?.ConfigRuleName || !r.Source) throw new AwsError('ParamValidationError', 'Parameter validation failed:\nMissing required parameter in ConfigRule: "ConfigRuleName" / "Source"', 400);
    if (r.Source.Owner !== 'AWS') throw new AwsError('InvalidParameterValueException', `Este simulador solo admite reglas gestionadas (Owner=AWS), no ${r.Source.Owner}.`, 400);
    const def = MANAGED[r.Source.SourceIdentifier];
    if (!def) throw new AwsError('InvalidParameterValueException', `The sourceIdentifier ${r.Source.SourceIdentifier} is invalid. Please refer to the documentation for a list of valid sourceIdentifiers that can be used when AWS is the Owner.`, 400);
    const c = cfg(ctx.s);
    if (!c.recorder) throw new AwsError('NoAvailableConfigurationRecorderException', 'Configuration recorder is not available to put AWS Config rules. Create a configuration recorder before putting AWS Config rules.', 400);
    let params: Record<string, string> = {};
    if (r.InputParameters) {
      try {
        const raw = typeof r.InputParameters === 'string' ? JSON.parse(r.InputParameters) : r.InputParameters;
        for (const [k, v] of Object.entries(raw)) params[k] = String(v);
      } catch {
        throw new AwsError('InvalidParameterValueException', 'The InputParameters is not a valid JSON string.', 400);
      }
      const valid = new Set(Object.keys(def.defaults ?? {}));
      if (r.Source.SourceIdentifier === 'REQUIRED_TAGS') for (let i = 1; i <= 6; i++) { valid.add(`tag${i}Key`); valid.add(`tag${i}Value`); }
      if (r.Source.SourceIdentifier === 'RESTRICTED_INCOMING_TRAFFIC') for (let i = 1; i <= 5; i++) valid.add(`blockedPort${i}`);
      if (r.Source.SourceIdentifier === 'IAM_PASSWORD_POLICY') for (const k of ['MaxPasswordAge', 'PasswordReusePrevention']) valid.add(k);
      for (const k of Object.keys(params)) if (!valid.has(k)) throw new AwsError('InvalidParameterValueException', `The parameter ${k} is not valid for the rule ${r.Source.SourceIdentifier}.`, 400);
    }
    const types = r.Scope?.ComplianceResourceTypes;
    const old = c.rules.find((x) => x.name === r.ConfigRuleName);
    if (old) {
      Object.assign(old, { description: r.Description, identifier: r.Source.SourceIdentifier, inputParameters: params, scopeTypes: types });
      return;
    }
    const id = `config-rule-${randomString(6)}`;
    c.rules.push({ name: r.ConfigRuleName, id, arn: ruleArn(ctx, id), description: r.Description ?? def.description, identifier: r.Source.SourceIdentifier, inputParameters: params, scopeTypes: types, createdAt: nowIso(), lastEvaluatedAt: nowIso() });
  });
}
export function describeConfigRules(ctx: Ctx, p: { ConfigRuleNames?: string[] }): ConfigRule[] {
  return trailed(ctx, SRC, 'DescribeConfigRules', [], p, () => {
    authorize(ctx, 'config:DescribeConfigRules', '*');
    if (p.ConfigRuleNames) return p.ConfigRuleNames.map((n) => needRule(ctx, n));
    return cfg(ctx.s).rules;
  });
}
export function deleteConfigRule(ctx: Ctx, p: { ConfigRuleName: string }): void {
  trailed(ctx, SRC, 'DeleteConfigRule', [], p, () => {
    authorize(ctx, 'config:DeleteConfigRule', '*');
    const r = needRule(ctx, p.ConfigRuleName);
    cfg(ctx.s).rules = cfg(ctx.s).rules.filter((x) => x !== r);
  });
}
export function startConfigRulesEvaluation(ctx: Ctx, p: { ConfigRuleNames: string[] }): void {
  trailed(ctx, SRC, 'StartConfigRulesEvaluation', [], p, () => {
    authorize(ctx, 'config:StartConfigRulesEvaluation', '*');
    const rules = p.ConfigRuleNames.map((n) => needRule(ctx, n));
    for (const r of rules) r.lastEvaluatedAt = nowIso();
  });
}
export function describeComplianceByConfigRule(ctx: Ctx, p: { ConfigRuleNames?: string[]; ComplianceTypes?: string[] }) {
  return trailed(ctx, SRC, 'DescribeComplianceByConfigRule', [], p, () => {
    authorize(ctx, 'config:DescribeComplianceByConfigRule', '*');
    const rules = p.ConfigRuleNames ? p.ConfigRuleNames.map((n) => needRule(ctx, n)) : cfg(ctx.s).rules;
    return rules
      .map((r) => ({ rule: r, type: ruleCompliance(ctx.s, r), noncompliant: evaluateRule(ctx.s, r).filter((e) => !e.ok).length }))
      .filter((x) => !p.ComplianceTypes?.length || p.ComplianceTypes.includes(x.type));
  });
}
export function getComplianceDetailsByConfigRule(ctx: Ctx, p: { ConfigRuleName: string; ComplianceTypes?: string[] }) {
  return trailed(ctx, SRC, 'GetComplianceDetailsByConfigRule', [], p, () => {
    authorize(ctx, 'config:GetComplianceDetailsByConfigRule', '*');
    const r = needRule(ctx, p.ConfigRuleName);
    return evaluateRule(ctx.s, r)
      .map((e) => ({ rule: r, e, type: (e.ok ? 'COMPLIANT' : 'NON_COMPLIANT') as Compliance }))
      .filter((x) => !p.ComplianceTypes?.length || p.ComplianceTypes.includes(x.type));
  });
}
export function describeRuleEvaluationStatus(ctx: Ctx, p: { ConfigRuleNames?: string[] }): ConfigRule[] {
  return trailed(ctx, SRC, 'DescribeConfigRuleEvaluationStatus', [], p, () => {
    authorize(ctx, 'config:DescribeConfigRuleEvaluationStatus', '*');
    return p.ConfigRuleNames ? p.ConfigRuleNames.map((n) => needRule(ctx, n)) : cfg(ctx.s).rules;
  });
}
/** Evaluaciones de todas las reglas agrupadas por recurso. */
export function complianceByResource(ctx: Ctx, p: { ResourceType?: string; ResourceId?: string; ComplianceTypes?: string[] }) {
  return trailed(ctx, SRC, 'DescribeComplianceByResource', [], p, () => {
    authorize(ctx, 'config:DescribeComplianceByResource', '*');
    return resourceCompliance(ctx.s).filter((x) => (!p.ResourceType || x.type === p.ResourceType) && (!p.ResourceId || x.id === p.ResourceId) && (!p.ComplianceTypes?.length || p.ComplianceTypes.includes(x.compliance)));
  });
}
export function resourceCompliance(s: CloudState) {
  const map = new Map<string, { type: string; id: string; name?: string; compliance: Compliance; evals: { rule: ConfigRule; e: Evaluation }[] }>();
  for (const r of cfg(s).rules) {
    for (const e of evaluateRule(s, r)) {
      const key = `${e.type}|${e.id}`;
      const cur = map.get(key) ?? { type: e.type, id: e.id, name: e.name, compliance: 'COMPLIANT' as Compliance, evals: [] };
      cur.evals.push({ rule: r, e });
      if (!e.ok) cur.compliance = 'NON_COMPLIANT';
      map.set(key, cur);
    }
  }
  return [...map.values()];
}
export function getComplianceDetailsByResource(ctx: Ctx, p: { ResourceType: string; ResourceId: string; ComplianceTypes?: string[] }) {
  return trailed(ctx, SRC, 'GetComplianceDetailsByResource', [], p, () => {
    authorize(ctx, 'config:GetComplianceDetailsByResource', '*');
    const x = resourceCompliance(ctx.s).find((q) => q.type === p.ResourceType && q.id === p.ResourceId);
    return (x?.evals ?? []).map((v) => ({ rule: v.rule, e: v.e, type: (v.e.ok ? 'COMPLIANT' : 'NON_COMPLIANT') as Compliance })).filter((v) => !p.ComplianceTypes?.length || p.ComplianceTypes.includes(v.type));
  });
}
export function complianceSummary(ctx: Ctx) {
  return trailed(ctx, SRC, 'GetComplianceSummaryByConfigRule', [], {}, () => {
    authorize(ctx, 'config:GetComplianceSummaryByConfigRule', '*');
    const types = cfg(ctx.s).rules.map((r) => ruleCompliance(ctx.s, r));
    return { compliant: types.filter((t) => t === 'COMPLIANT').length, nonCompliant: types.filter((t) => t === 'NON_COMPLIANT').length };
  });
}
/** Recursos de un tipo que el grabador conoce. */
export function listDiscoveredResources(ctx: Ctx, p: { resourceType: string }): { type: string; id: string; name?: string }[] {
  return trailed(ctx, SRC, 'ListDiscoveredResources', [], p, () => {
    authorize(ctx, 'config:ListDiscoveredResources', '*');
    if (!RESOURCE_TYPES.includes(p.resourceType)) throw new AwsError('ValidationException', `1 validation error detected: Value '${p.resourceType}' at 'resourceType' failed to satisfy constraint: Member must satisfy enum value set`, 400);
    const s = ctx.s;
    if (!cfg(s).recorder?.recording) return [];
    switch (p.resourceType) {
      case T.bucket: return s.buckets.map((b) => ({ type: T.bucket, id: b.name, name: b.name }));
      case T.sg: return s.securityGroups.map((g) => ({ type: T.sg, id: g.id, name: g.name }));
      case T.user: return s.users.map((u) => ({ type: T.user, id: u.id, name: u.name }));
      case T.inst: return liveInstances(s).map((i) => ({ type: T.inst, id: i.id }));
      case T.vol: return s.volumes.map((v) => ({ type: T.vol, id: v.id }));
      case T.key: return s.kmsKeys.filter((k) => k.manager === 'CUSTOMER').map((k) => ({ type: T.key, id: k.id }));
      default: return [{ type: T.acct, id: s.account.id }];
    }
  });
}

