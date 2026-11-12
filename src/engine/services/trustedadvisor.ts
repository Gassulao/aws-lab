// AWS Support: Trusted Advisor (comprobaciones sobre los recursos reales de la cuenta) y AWS Health (eventos derivados del estado).
// Simplificación documentada: en AWS la API de Trusted Advisor exige un plan Business o Enterprise; aquí está siempre disponible.
import type { CloudState } from '../types';
import { AwsError } from '../errors';
import { authorize, trailed, type Ctx } from '../api';
import { nowIso, now } from '../util';
import { gov, type TaFlagged, type TaResult } from './govTypes';
import { bucketPublicRead, bucketPublicWrite, activeKeyAges, hasConsole, hasMfa, liveInstances, sgUnrestrictedRules, ruleOpensPort, trailLogging } from './govFindings';
import { targetHealth } from './elbv2';
import { settle } from './ec2';
import { PUBLIC_IPV4_HOURLY, EBS_PRICE_GB_MONTH, HOURS_PER_MONTH } from '../catalog';

const SRC = 'support.amazonaws.com';

export type TaCategory = 'security' | 'cost_optimizing' | 'fault_tolerance' | 'performance' | 'service_limits';
export interface TaCheck { id: string; name: string; description: string; category: TaCategory; metadata: string[] }

export const CATEGORY_ES: Record<TaCategory, string> = { security: 'Seguridad', cost_optimizing: 'Optimización de costos', fault_tolerance: 'Tolerancia a errores', performance: 'Rendimiento', service_limits: 'Límites de servicio' };

const ALB_MONTHLY = 0.0225 * HOURS_PER_MONTH;
const SENSITIVE_PORTS = [21, 22, 23, 1433, 1434, 3306, 3389, 4333, 5432, 5500];

interface Def extends TaCheck {
  run(s: CloudState): { processed: number; flagged: TaFlagged[]; savings?: number };
}

const portText = (r: { protocol: string; from: number; to: number }) => (r.protocol === '-1' ? 'All' : r.from === r.to ? String(r.from) : `${r.from}-${r.to}`);

const DEFS: Def[] = [
  {
    id: 'Pfx0RwqBli', name: 'Amazon S3 Bucket Permissions', category: 'security', metadata: ['Region', 'Bucket Name', 'Public Read', 'Public Write'],
    description: 'Checks buckets in Amazon Simple Storage Service (Amazon S3) that have open access permissions.',
    run: (s) => ({ processed: s.buckets.length, flagged: s.buckets.filter((b) => bucketPublicRead(b) || bucketPublicWrite(b)).map((b) => ({ status: 'error', region: b.region, resourceId: b.name, metadata: [b.region, b.name, bucketPublicRead(b) ? 'Yes' : 'No', bucketPublicWrite(b) ? 'Yes' : 'No'] })) }),
  },
  {
    id: '1iG5NDGVre', name: 'Security Groups - Unrestricted Access', category: 'security', metadata: ['Region', 'Security Group Name', 'Security Group ID', 'Protocol', 'Port', 'Status', 'IP Range'],
    description: 'Checks security groups for rules that allow unrestricted access (0.0.0.0/0) to specific ports.',
    run: (s) => {
      const flagged: TaFlagged[] = [];
      for (const g of s.securityGroups) for (const r of sgUnrestrictedRules(g)) flagged.push({ status: 'error', region: g.region, resourceId: `${g.id}/${r.id}`, metadata: [g.region, g.name, g.id, r.protocol === '-1' ? 'All' : r.protocol.toUpperCase(), portText(r), 'Red', r.cidr ?? ''] });
      return { processed: s.securityGroups.length, flagged };
    },
  },
  {
    id: 'HCP4007jGY', name: 'Security Groups - Specific Ports Unrestricted', category: 'security', metadata: ['Region', 'Security Group Name', 'Security Group ID', 'Protocol', 'Port', 'Status', 'IP Range'],
    description: 'Checks security groups for rules that allow unrestricted access (0.0.0.0/0) to specific ports such as SSH (22), RDP (3389) and database ports.',
    run: (s) => {
      const flagged: TaFlagged[] = [];
      for (const g of s.securityGroups) for (const r of g.ingress) {
        const hit = SENSITIVE_PORTS.filter((p) => ruleOpensPort(r, p));
        if (hit.length) flagged.push({ status: 'error', region: g.region, resourceId: `${g.id}/${r.id}`, metadata: [g.region, g.name, g.id, r.protocol === '-1' ? 'All' : r.protocol.toUpperCase(), portText(r), 'Red', r.cidr ?? ''] });
      }
      return { processed: s.securityGroups.length, flagged };
    },
  },
  {
    id: 'DqdJqYeRm5', name: 'IAM Access Key Rotation', category: 'security', metadata: ['Status', 'IAM User', 'Access Key ID', 'Key Last Rotated', 'Reason'],
    description: 'Checks for active IAM access keys that have not been rotated in the last 90 days.',
    run: (s) => {
      const flagged: TaFlagged[] = [];
      for (const u of s.users) for (const k of activeKeyAges(u)) if (k.days > 90) {
        const st = k.days > 730 ? 'error' : 'warning';
        flagged.push({ status: st, region: 'us-east-1', resourceId: k.id, metadata: [st === 'error' ? 'Red' : 'Yellow', u.name, k.id, `${k.days} days ago`, st === 'error' ? 'Access key not rotated in 2 years' : 'Access key not rotated in 90 days'] });
      }
      return { processed: s.users.reduce((a, u) => a + u.accessKeys.filter((k) => k.status === 'Active').length, 0), flagged };
    },
  },
  {
    id: 'c1MfaIamUsr', name: 'IAM Users Without MFA', category: 'security', metadata: ['Status', 'IAM User', 'Console Access'],
    description: 'Checks for IAM users that can sign in to the console without multi-factor authentication (MFA). Comprobación propia del simulador.',
    run: (s) => ({ processed: s.users.length, flagged: s.users.filter((u) => hasConsole(u) && !hasMfa(u)).map((u) => ({ status: 'warning', region: 'us-east-1', resourceId: u.name, metadata: ['Yellow', u.name, 'Yes'] })) }),
  },
  {
    id: 'Yw2K9puPzl', name: 'IAM Password Policy', category: 'security', metadata: ['Password Policy', 'Uppercase', 'Lowercase', 'Number', 'Non-alphanumeric', 'Minimum Length'],
    description: 'Checks the password policy for your account and warns when a password policy is not enabled, or if password content requirements have not been enabled.',
    run: (s) => {
      const pp = s.passwordPolicy;
      const weak = !pp || !pp.RequireUppercaseCharacters || !pp.RequireLowercaseCharacters || !pp.RequireNumbers || !pp.RequireSymbols || pp.MinimumPasswordLength < 8;
      const yn = (b?: boolean) => (b ? 'Enabled' : 'Disabled');
      return { processed: 1, flagged: weak ? [{ status: 'warning', region: 'us-east-1', resourceId: s.account.id, metadata: [pp ? 'Enabled' : 'Disabled', yn(pp?.RequireUppercaseCharacters), yn(pp?.RequireLowercaseCharacters), yn(pp?.RequireNumbers), yn(pp?.RequireSymbols), String(pp?.MinimumPasswordLength ?? 6)] }] : [] };
    },
  },
  {
    id: 'vjafUGJ9H0', name: 'AWS CloudTrail Logging', category: 'security', metadata: ['Region', 'Trail Name', 'Status'],
    description: 'Checks for your use of AWS CloudTrail. CloudTrail provides increased visibility into activity in your AWS account by recording information about AWS API calls.',
    run: (s) => {
      if (!s.trails.length) return { processed: 1, flagged: [{ status: 'error', region: s.region, resourceId: 'no-trail', metadata: [s.region, '-', 'No trail'] }] };
      const off = s.trails.filter((t) => !t.logging);
      return { processed: s.trails.length, flagged: trailLogging(s) ? [] : off.map((t) => ({ status: 'error' as const, region: t.homeRegion, resourceId: t.name, metadata: [t.homeRegion, t.name, 'Not logging'] })) };
    },
  },
  {
    id: 'a2sEc6ILx', name: 'ELB Listener Security', category: 'security', metadata: ['Region', 'Load Balancer Name', 'Load Balancer Port', 'Reason'],
    description: 'Checks for load balancers with listeners that do not use recommended security configurations for encrypted communication.',
    run: (s) => ({
      processed: s.listeners.length,
      flagged: s.listeners.filter((l) => l.protocol === 'HTTP').map((l) => { const lb = s.loadBalancers.find((x) => x.arn === l.lbArn); return { status: 'warning' as const, region: lb?.region ?? s.region, resourceId: lb?.name ?? l.arn, metadata: [lb?.region ?? s.region, lb?.name ?? '-', String(l.port), 'No encryption (HTTP listener)'] }; }),
    }),
  },
  {
    id: 'Z4AUBRNSmz', name: 'Unassociated Elastic IP Addresses', category: 'cost_optimizing', metadata: ['Region', 'IP Address'],
    description: 'Checks for Elastic IP addresses (EIPs) that are not associated with a running Amazon Elastic Compute Cloud (Amazon EC2) instance.',
    run: (s) => { const f = s.elasticIps.filter((e) => !e.associatedInstanceId); return { processed: s.elasticIps.length, flagged: f.map((e) => ({ status: 'warning', region: e.region, resourceId: e.publicIp, metadata: [e.region, e.publicIp] })), savings: f.length * PUBLIC_IPV4_HOURLY * HOURS_PER_MONTH }; },
  },
  {
    id: 'hjLMh88uM8', name: 'Idle Load Balancers', category: 'cost_optimizing', metadata: ['Region', 'Load Balancer Name', 'Reason', 'Estimated Monthly Savings'],
    description: 'Checks your Elastic Load Balancing configuration for load balancers that are not actively used.',
    run: (s) => {
      settle(s);
      const idle = s.loadBalancers.filter((lb) => {
        const tgs = s.listeners.filter((l) => l.lbArn === lb.arn).map((l) => s.targetGroups.find((g) => g.arn === l.tgArn)).filter(Boolean) as CloudState['targetGroups'];
        return !tgs.some((g) => g.targets.some((x) => targetHealth(s, g, x).state === 'healthy'));
      });
      return { processed: s.loadBalancers.length, flagged: idle.map((lb) => ({ status: 'warning', region: lb.region, resourceId: lb.name, metadata: [lb.region, lb.name, 'No healthy instances', `$${ALB_MONTHLY.toFixed(2)}`] })), savings: idle.length * ALB_MONTHLY };
    },
  },
  {
    id: 'DAvU99Dc4C', name: 'Underutilized Amazon EBS Volumes', category: 'cost_optimizing', metadata: ['Region', 'Volume ID', 'Volume Name', 'Volume Type', 'Volume Size', 'Monthly Storage Cost'],
    description: 'Checks Amazon Elastic Block Store (Amazon EBS) volume configurations and warns when volumes appear to be underused (not attached to any instance).',
    run: (s) => {
      const f = s.volumes.filter((v) => v.state === 'available');
      const cost = (v: CloudState['volumes'][number]) => v.sizeGiB * (EBS_PRICE_GB_MONTH[v.type] ?? 0);
      return { processed: s.volumes.length, flagged: f.map((v) => ({ status: 'warning', region: v.region, resourceId: v.id, metadata: [v.region, v.id, v.tags.Name ?? '', v.type, `${v.sizeGiB} GiB`, `$${cost(v).toFixed(2)}`] })), savings: f.reduce((a, v) => a + cost(v), 0) };
    },
  },
  {
    id: 'R365s2Qddf', name: 'Amazon S3 Bucket Versioning', category: 'fault_tolerance', metadata: ['Region', 'Bucket Name', 'Versioning'],
    description: 'Checks for Amazon Simple Storage Service buckets that do not have versioning enabled, or have versioning suspended.',
    run: (s) => ({ processed: s.buckets.length, flagged: s.buckets.filter((b) => b.versioning !== 'Enabled').map((b) => ({ status: 'warning', region: b.region, resourceId: b.name, metadata: [b.region, b.name, b.versioning === 'Suspended' ? 'Suspended' : 'Disabled'] })) }),
  },
  {
    id: 'H7IgTzjTYb', name: 'Amazon EBS Snapshots', category: 'fault_tolerance', metadata: ['Region', 'Volume ID', 'Volume Name', 'Snapshot ID', 'Reason'],
    description: 'Checks the age of the snapshots for your Amazon EBS volumes (available or in-use) and warns volumes with no snapshot.',
    run: (s) => ({ processed: s.volumes.length, flagged: s.volumes.filter((v) => !s.snapshots.some((x) => x.volumeId === v.id)).map((v) => ({ status: 'warning', region: v.region, resourceId: v.id, metadata: [v.region, v.id, v.tags.Name ?? '', '-', 'No snapshot'] })) }),
  },
];

export const CHECKS: TaCheck[] = DEFS.map(({ id, name, description, category, metadata }) => ({ id, name, description, category, metadata }));

const sup = (s: CloudState) => gov(s).support;
const needCheck = (id: string): Def => {
  const d = DEFS.find((x) => x.id === id);
  if (!d) throw new AwsError('InvalidParameterValueException', `Invalid checkId: ${id}`, 400);
  return d;
};

export function computeCheck(s: CloudState, d: Def): TaResult {
  const r = d.run(s);
  const status: TaResult['status'] = r.flagged.some((f) => f.status === 'error') ? 'error' : r.flagged.length ? 'warning' : 'ok';
  return { checkId: d.id, timestamp: nowIso(), status, processed: r.processed, flagged: r.flagged.length, savings: r.savings, flaggedResources: r.flagged };
}

/** Último resultado guardado de una comprobación (se calcula la primera vez que se consulta). */
export function checkResult(s: CloudState, id: string): TaResult {
  const d = needCheck(id);
  const c = (sup(s).cache ??= {});
  return (c[id] ??= computeCheck(s, d));
}
export function refreshCheck(s: CloudState, id: string): TaResult {
  const d = needCheck(id);
  const c = (sup(s).cache ??= {});
  c[id] = computeCheck(s, d);
  sup(s).refreshed[id] = c[id].timestamp;
  return c[id];
}

// ------------------------------------------------------------------ API de Support

export function describeChecks(ctx: Ctx, p: { language?: string }): TaCheck[] {
  return trailed(ctx, SRC, 'DescribeTrustedAdvisorChecks', [], p, () => {
    authorize(ctx, 'support:DescribeTrustedAdvisorChecks', '*');
    if (!p.language) throw new AwsError('ParamValidationError', 'the following arguments are required: --language', 400);
    return CHECKS;
  });
}
export function describeCheckResult(ctx: Ctx, p: { checkId: string }): TaResult {
  return trailed(ctx, SRC, 'DescribeTrustedAdvisorCheckResult', [], p, () => {
    authorize(ctx, 'support:DescribeTrustedAdvisorCheckResult', '*');
    return checkResult(ctx.s, p.checkId);
  });
}
export function describeCheckSummaries(ctx: Ctx, p: { checkIds: string[] }): TaResult[] {
  return trailed(ctx, SRC, 'DescribeTrustedAdvisorCheckSummaries', [], p, () => {
    authorize(ctx, 'support:DescribeTrustedAdvisorCheckSummaries', '*');
    return (p.checkIds ?? []).map((id) => checkResult(ctx.s, id));
  });
}
export function refreshTrustedAdvisorCheck(ctx: Ctx, p: { checkId: string }): void {
  trailed(ctx, SRC, 'RefreshTrustedAdvisorCheck', [], p, () => {
    authorize(ctx, 'support:RefreshTrustedAdvisorCheck', '*');
    refreshCheck(ctx.s, p.checkId);
  });
}

// ------------------------------------------------------------------ AWS Health

export interface HealthEvent { arn: string; service: string; eventTypeCode: string; eventTypeCategory: 'scheduledChange' | 'accountNotification' | 'issue'; region: string; startTime: string; lastUpdatedTime: string; description: string; entities: { value: string; status: 'IMPAIRED' | 'UNIMPAIRED' }[] }

/** Eventos de salud derivados del estado actual: retirada programada de instancias antiguas y buckets abiertos. */
export function healthEvents(s: CloudState): HealthEvent[] {
  const out: HealthEvent[] = [];
  const t = nowIso();
  const old = liveInstances(s).filter((i) => (i.billedMs + (i.runningSince ? now() - i.runningSince : 0)) > 14 * 86_400_000);
  for (const i of old) {
    out.push({
      arn: `arn:aws:health:${i.region}::event/EC2/AWS_EC2_INSTANCE_RETIREMENT_SCHEDULED/AWS_EC2_INSTANCE_RETIREMENT_SCHEDULED_${i.id}`, service: 'EC2', eventTypeCode: 'AWS_EC2_INSTANCE_RETIREMENT_SCHEDULED', eventTypeCategory: 'scheduledChange', region: i.region, startTime: t, lastUpdatedTime: t,
      description: `The instance ${i.id} is running on degraded hardware and is scheduled for retirement. Stop and start the instance to move it to healthy hardware.`, entities: [{ value: i.id, status: 'IMPAIRED' }],
    });
  }
  const open = s.buckets.filter((b) => bucketPublicRead(b) || bucketPublicWrite(b));
  if (open.length) {
    out.push({
      arn: `arn:aws:health:global::event/S3/AWS_S3_OPEN_ACCESS_BUCKET_NOTIFICATION/AWS_S3_OPEN_ACCESS_BUCKET_NOTIFICATION_${s.account.id}`, service: 'S3', eventTypeCode: 'AWS_S3_OPEN_ACCESS_BUCKET_NOTIFICATION', eventTypeCategory: 'accountNotification', region: 'global', startTime: t, lastUpdatedTime: t,
      description: 'Amazon S3 buckets in your account are publicly accessible. Review the bucket policies and ACLs, and enable S3 Block Public Access unless public access is intended.', entities: open.map((b) => ({ value: b.name, status: 'IMPAIRED' as const })),
    });
  }
  return out;
}

export function describeEvents(ctx: Ctx): HealthEvent[] {
  return trailed(ctx, 'health.amazonaws.com', 'DescribeEvents', [], {}, () => {
    authorize(ctx, 'health:DescribeEvents', '*');
    return healthEvents(ctx.s);
  });
}
export function describeEventDetails(ctx: Ctx, p: { eventArns: string[] }) {
  return trailed(ctx, 'health.amazonaws.com', 'DescribeEventDetails', [], p, () => {
    authorize(ctx, 'health:DescribeEventDetails', '*');
    const all = healthEvents(ctx.s);
    return { ok: (p.eventArns ?? []).map((a) => all.find((e) => e.arn === a)).filter(Boolean) as HealthEvent[], failed: (p.eventArns ?? []).filter((a) => !all.some((e) => e.arn === a)) };
  });
}
export function describeAffectedEntities(ctx: Ctx, p: { filter: { eventArns: string[] } }) {
  return trailed(ctx, 'health.amazonaws.com', 'DescribeAffectedEntities', [], p, () => {
    authorize(ctx, 'health:DescribeAffectedEntities', '*');
    if (!p.filter?.eventArns?.length) throw new AwsError('InvalidPaginationToken', 'filter.eventArns is required.', 400);
    return healthEvents(ctx.s).filter((e) => p.filter.eventArns.includes(e.arn)).flatMap((e) => e.entities.map((x) => ({ ...x, event: e })));
  });
}
