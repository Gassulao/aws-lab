// Elastic Load Balancing v2 (solo Application Load Balancer): balanceadores, grupos de destino, destinos y oyentes.
// La salud de cada destino se deriva del estado de la instancia, de sus grupos de seguridad y de si sirve tráfico web.
import type { CloudState, Instance, Listener, LoadBalancer, TargetGroup } from '../types';
import { AwsError } from '../errors';
import { trailed, authorize, type Ctx } from '../api';
import { digits, hex, now, nowIso } from '../util';
import { speedFactor } from '../store';
import { cidrWithin, isPublicSubnet, settle } from './ec2';
import { cs } from './containerCore';

const SRC = 'elasticloadbalancing.amazonaws.com';
const ZONES: Record<string, string> = { 'eu-west-1': 'Z32O12XQLNTSW2', 'us-east-1': 'Z35SXDOTRQ7X7K', 'eu-west-3': 'Z3Q77PNBQS71R4', 'eu-central-1': 'Z215JYRZR1TBD5', 'eu-south-2': 'Z0956581394HF5D5LXGAP' };
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const lbArnOf = (ctx: Ctx, n: string, id: string) => `arn:aws:elasticloadbalancing:${ctx.region}:${ctx.s.account.id}:loadbalancer/app/${n}/${id}`;

// ------------------------------------------------------------------ utilidades compartidas

export const elbByDns = (s: CloudState, dns: string) => { const d = dns.toLowerCase().replace(/\.$/, '').replace(/^dualstack\./, ''); return s.loadBalancers.find((l) => l.dnsName === d); };
export const elbIps = (lb: LoadBalancer): string[] => { const h = hash(lb.arn); return [0, 1].map((i) => `${3 + ((h >> (i * 4)) % 40)}.${(h >> (i + 3)) % 250}.${(h >> (i + 5)) % 250}.${1 + ((h >> (i + 7)) % 250)}`); };

/** ¿Responde la instancia a peticiones web? (servidor instalado por user-data o etiqueta de laboratorio) */
export function isServing(inst: Instance): boolean {
  if (inst.tags['simulador:web'] === 'ok') return true;
  let ud = inst.userData ?? '';
  try { ud += '\n' + atob(ud); } catch { /* texto plano */ }
  return /httpd|nginx|apache|http\.server|nodejs|node\s|python3?\s+-m/i.test(ud);
}

export interface TargetState { state: 'initial' | 'healthy' | 'unhealthy' | 'unused' | 'draining'; reason?: string; description?: string }

/** Destinos de tipo `ip` (tareas de ECS con awsvpc): los registra el módulo de ECS. */
export const ipTargets: { health: ((s: CloudState, tg: TargetGroup, t: TargetGroup['targets'][number]) => TargetState) | null; backends: ((s: CloudState, lb: LoadBalancer, port: number) => { body: string; server: string }[]) | null } = { health: null, backends: null };

export function targetHealth(s: CloudState, tg: TargetGroup, t: TargetGroup['targets'][number]): TargetState {
  settle(s);
  if (tg.targetType === 'ip') return ipTargets.health ? ipTargets.health(s, tg, t) : { state: 'unused', reason: 'Target.NotInUse', description: 'Target group is not configured to receive traffic from the load balancer' };
  const inst = s.instances.find((i) => i.id === t.id);
  if (!inst || inst.state === 'terminated') return { state: 'unused', reason: 'Target.InvalidState', description: 'Target is in the terminated state' };
  if (inst.state === 'stopped' || inst.state === 'stopping' || inst.state === 'shutting-down') return { state: 'unused', reason: 'Target.InvalidState', description: `Target is in the ${inst.state} state` };
  const ls = s.listeners.filter((l) => l.tgArn === tg.arn);
  if (!ls.length) return { state: 'unused', reason: 'Target.NotInUse', description: 'Target group is not configured to receive traffic from the load balancer' };
  const lbs = ls.map((l) => s.loadBalancers.find((x) => x.arn === l.lbArn)).filter(Boolean) as LoadBalancer[];
  const azs = new Set(lbs.flatMap((l) => l.subnets.map((id) => s.subnets.find((x) => x.id === id)?.az)));
  if (!azs.has(inst.az)) return { state: 'unused', reason: 'Target.NotInUse', description: 'Target is in an Availability Zone that is not enabled for the load balancer' };
  if (inst.state === 'pending') return { state: 'initial', reason: 'Elb.RegistrationInProgress', description: 'Target registration is in progress' };
  const f = speedFactor();
  if (f > 0 && now() - t.since < Math.min(tg.hc.healthy * tg.hc.interval, 150) * 1000 * f) return { state: 'initial', reason: 'Elb.InitialHealthChecking', description: 'Initial health checking in progress' };
  const port = tg.hc.port === 'traffic-port' ? t.port : Number(tg.hc.port);
  const lbSubs = lbs.flatMap((l) => l.subnets.map((id) => s.subnets.find((x) => x.id === id)!.cidr));
  const allowed = inst.securityGroupIds.some((id) => s.securityGroups.find((g) => g.id === id)?.ingress.some((r) =>
    (r.protocol === '-1' || (r.protocol === 'tcp' && r.from <= port && port <= r.to)) && ((r.sourceSg && lbs.some((l) => l.securityGroups.includes(r.sourceSg!))) || (r.cidr && lbSubs.some((c) => cidrWithin(c, r.cidr!))))));
  if (!allowed) return { state: 'unhealthy', reason: 'Target.Timeout', description: 'Request timed out' };
  if (!isServing(inst)) return { state: 'unhealthy', reason: 'Target.FailedHealthChecks', description: 'Health checks failed' };
  return { state: 'healthy' };
}
export function elbHealthy(s: CloudState, lb: LoadBalancer): boolean {
  return s.listeners.filter((l) => l.lbArn === lb.arn).some((l) => { const tg = s.targetGroups.find((g) => g.arn === l.tgArn); return !!tg && tg.targets.some((t) => targetHealth(s, tg, t).state === 'healthy'); });
}
/** Instancias sanas que atenderían la petición, para balanceo por turnos. */
export function healthyInstances(s: CloudState, lb: LoadBalancer, port: number): Instance[] {
  const l = s.listeners.find((x) => x.lbArn === lb.arn && x.port === port);
  const tg = l && s.targetGroups.find((g) => g.arn === l.tgArn);
  if (!tg || tg.targetType === 'ip') return [];
  return tg.targets.filter((t) => targetHealth(s, tg, t).state === 'healthy').map((t) => s.instances.find((i) => i.id === t.id)!);
}

// ------------------------------------------------------------------ balanceadores

const lbNotFound = (a: string) => new AwsError('LoadBalancerNotFound', `Load balancers '[${a}]' not found`, 400);
export function getLb(ctx: Ctx, arn: string): LoadBalancer {
  const l = ctx.s.loadBalancers.find((x) => x.arn === arn);
  if (!l) throw lbNotFound(arn);
  return l;
}
export function lbState(lb: LoadBalancer): 'provisioning' | 'active' {
  const f = speedFactor();
  return f === 0 || now() - Date.parse(lb.createdAt) >= 20_000 * f ? 'active' : 'provisioning';
}

export function createLoadBalancer(ctx: Ctx, p: { Name: string; Subnets?: string[]; SecurityGroups?: string[]; Scheme?: string; Type?: string; Tags?: { Key: string; Value: string }[] }): LoadBalancer {
  const id = hex(16);
  return trailed(ctx, SRC, 'CreateLoadBalancer', [{ type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', name: p.Name }], { name: p.Name, subnets: p.Subnets, securityGroups: p.SecurityGroups, scheme: p.Scheme }, () => {
    authorize(ctx, 'elasticloadbalancing:CreateLoadBalancer', '*');
    const name = p.Name ?? '';
    if (name.length > 32) throw new AwsError('ValidationError', `Load balancer name '${name}' cannot be longer than '32' characters`);
    if (!/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(name)) throw new AwsError('ValidationError', `Load balancer name '${name}' can only contain characters that are alphanumeric characters or hyphens(-)`);
    if ((p.Type ?? 'application') !== 'application') throw new AwsError('ValidationError', `Load balancer type '${p.Type}' is not supported by this simulator (only 'application')`);
    const subs = p.Subnets ?? [];
    const found = subs.map((sid) => { const sn = ctx.s.subnets.find((x) => x.id === sid && x.region === ctx.region); if (!sn) throw new AwsError('SubnetNotFound', `The subnet ID '${sid}' does not exist`); return sn; });
    if (new Set(found.map((x) => x.az)).size < 2) throw new AwsError('ValidationError', 'At least two subnets in two different Availability Zones must be specified');
    if (new Set(found.map((x) => x.vpcId)).size > 1) throw new AwsError('ValidationError', 'The subnets must belong to the same VPC'.replace('The subnets', 'Subnets'));
    const sgs = p.SecurityGroups?.length ? p.SecurityGroups : [ctx.s.vpcs.find((v) => v.id === found[0].vpcId)!.defaultSecurityGroupId];
    for (const g of sgs) if (!ctx.s.securityGroups.some((x) => x.id === g)) throw new AwsError('SecurityGroupNotFound', `The security group '${g}' does not exist`);
    const scheme = (p.Scheme ?? 'internet-facing') as LoadBalancer['scheme'];
    const ex = ctx.s.loadBalancers.find((l) => l.name === name && l.region === ctx.region);
    if (ex) {
      if (ex.scheme === scheme && [...ex.subnets].sort().join() === [...subs].sort().join()) return ex;
      throw new AwsError('DuplicateLoadBalancerName', `A load balancer with the same name '${name}' exists, but with different settings`);
    }
    if (scheme === 'internet-facing') {
      const bad = found.filter((sn) => !isPublicSubnet(ctx.s, sn));
      if (bad.length) throw new AwsError('InvalidSubnet', `VPC ${bad[0].vpcId} has no internet gateway`);
    }
    const lb: LoadBalancer = { arn: lbArnOf(ctx, name, id), name, dnsName: `${scheme === 'internal' ? 'internal-' : ''}${name}-${digits(9)}.${ctx.region}.elb.amazonaws.com`, scheme, vpcId: found[0].vpcId, subnets: subs, securityGroups: sgs, createdAt: nowIso(), region: ctx.region, zoneId: ZONES[ctx.region] ?? 'Z3AADJGX6KTTL2', tags: Object.fromEntries((p.Tags ?? []).map((t) => [t.Key, t.Value])) };
    ctx.s.loadBalancers.push(lb);
    return lb;
  });
}
export function describeLoadBalancers(ctx: Ctx, p: { LoadBalancerArns?: string[]; Names?: string[] } = {}): LoadBalancer[] {
  return trailed(ctx, SRC, 'DescribeLoadBalancers', [], p, () => {
    authorize(ctx, 'elasticloadbalancing:DescribeLoadBalancers', '*');
    for (const n of p.Names ?? []) if (!ctx.s.loadBalancers.some((l) => l.name === n && l.region === ctx.region)) throw new AwsError('LoadBalancerNotFound', `Load balancers '[${n}]' not found`);
    for (const a of p.LoadBalancerArns ?? []) getLb(ctx, a);
    return ctx.s.loadBalancers.filter((l) => l.region === ctx.region && (!p.LoadBalancerArns?.length || p.LoadBalancerArns.includes(l.arn)) && (!p.Names?.length || p.Names.includes(l.name)));
  });
}
export function deleteLoadBalancer(ctx: Ctx, p: { LoadBalancerArn: string }): void {
  return trailed(ctx, SRC, 'DeleteLoadBalancer', [{ type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', name: p.LoadBalancerArn }], { loadBalancerArn: p.LoadBalancerArn }, () => {
    authorize(ctx, 'elasticloadbalancing:DeleteLoadBalancer', p.LoadBalancerArn);
    const lb = ctx.s.loadBalancers.find((l) => l.arn === p.LoadBalancerArn);
    if (!lb) return; // la API real es idempotente
    ctx.s.listeners = ctx.s.listeners.filter((l) => l.lbArn !== lb.arn);
    ctx.s.loadBalancers = ctx.s.loadBalancers.filter((l) => l !== lb);
  });
}

// ------------------------------------------------------------------ grupos de destino

const tgNotFound = (a: string) => new AwsError('TargetGroupNotFound', `Target groups '[${a}]' not found`, 400);
export function getTg(ctx: Ctx, arn: string): TargetGroup {
  const g = ctx.s.targetGroups.find((x) => x.arn === arn);
  if (!g) throw tgNotFound(arn);
  return g;
}
export function createTargetGroup(ctx: Ctx, p: { Name: string; Protocol?: string; Port?: number; VpcId?: string; HealthCheckPath?: string; HealthCheckPort?: string; HealthCheckProtocol?: string; HealthCheckIntervalSeconds?: number; HealthCheckTimeoutSeconds?: number; HealthyThresholdCount?: number; UnhealthyThresholdCount?: number; Matcher?: { HttpCode: string }; TargetType?: string }): TargetGroup {
  return trailed(ctx, SRC, 'CreateTargetGroup', [{ type: 'AWS::ElasticLoadBalancingV2::TargetGroup', name: p.Name }], { name: p.Name, protocol: p.Protocol, port: p.Port, vpcId: p.VpcId }, () => {
    authorize(ctx, 'elasticloadbalancing:CreateTargetGroup', '*');
    const name = p.Name ?? '';
    if (name.length > 32) throw new AwsError('ValidationError', `Target group name '${name}' cannot be longer than '32' characters`);
    if (!/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(name)) throw new AwsError('ValidationError', `Target group name '${name}' can only contain characters that are alphanumeric characters or hyphens(-)`);
    const ttype = p.TargetType ?? 'instance';
    if (!['instance', 'ip'].includes(ttype)) throw new AwsError('ValidationError', `Target type '${ttype}' is not supported by this simulator (use 'instance' or 'ip')`);
    if (!p.Protocol || !p.Port || !p.VpcId) throw new AwsError('ValidationError', `You must specify Protocol, Port and VpcId for target groups of type '${ttype}'`);
    if (!['HTTP', 'HTTPS'].includes(p.Protocol)) throw new AwsError('ValidationError', `Protocol '${p.Protocol}' is not supported by Application Load Balancers in this simulator (use HTTP or HTTPS)`);
    if (p.Port < 1 || p.Port > 65535) throw new AwsError('ValidationError', `Port '${p.Port}' not valid`);
    if (!ctx.s.vpcs.some((v) => v.id === p.VpcId)) throw new AwsError('ValidationError', `The VPC ID '${p.VpcId}' is not valid`.replace('is not valid', 'does not exist'));
    const hc = { protocol: p.HealthCheckProtocol ?? p.Protocol, port: p.HealthCheckPort ?? 'traffic-port', path: p.HealthCheckPath ?? '/', interval: p.HealthCheckIntervalSeconds ?? 30, timeout: p.HealthCheckTimeoutSeconds ?? 5, healthy: p.HealthyThresholdCount ?? 5, unhealthy: p.UnhealthyThresholdCount ?? 2, matcher: p.Matcher?.HttpCode ?? '200' };
    if (hc.timeout >= hc.interval) throw new AwsError('ValidationError', `Health check timeout '${hc.timeout}' must be smaller than the interval '${hc.interval}'`);
    const ex = ctx.s.targetGroups.find((g) => g.name === name && g.region === ctx.region);
    if (ex) {
      if (ex.protocol === p.Protocol && ex.port === p.Port && ex.vpcId === p.VpcId && ex.targetType === ttype) return ex;
      throw new AwsError('DuplicateTargetGroupName', `A target group with the same name '${name}' exists, but with different attributes`);
    }
    const g: TargetGroup = { arn: `arn:aws:elasticloadbalancing:${ctx.region}:${ctx.s.account.id}:targetgroup/${name}/${hex(16)}`, name, protocol: p.Protocol, port: Number(p.Port), vpcId: p.VpcId, region: ctx.region, targetType: ttype as TargetGroup['targetType'], hc, targets: [], tags: {} };
    ctx.s.targetGroups.push(g);
    return g;
  });
}
export function modifyTargetGroup(ctx: Ctx, p: { TargetGroupArn: string; HealthCheckPath?: string; HealthCheckPort?: string; HealthCheckIntervalSeconds?: number; HealthCheckTimeoutSeconds?: number; HealthyThresholdCount?: number; UnhealthyThresholdCount?: number; Matcher?: { HttpCode: string } }): TargetGroup {
  return trailed(ctx, SRC, 'ModifyTargetGroup', [{ type: 'AWS::ElasticLoadBalancingV2::TargetGroup', name: p.TargetGroupArn }], { targetGroupArn: p.TargetGroupArn }, () => {
    authorize(ctx, 'elasticloadbalancing:ModifyTargetGroup', p.TargetGroupArn);
    const g = getTg(ctx, p.TargetGroupArn);
    if (p.HealthCheckPath) g.hc.path = p.HealthCheckPath;
    if (p.HealthCheckPort) g.hc.port = p.HealthCheckPort;
    if (p.HealthCheckIntervalSeconds) g.hc.interval = p.HealthCheckIntervalSeconds;
    if (p.HealthCheckTimeoutSeconds) g.hc.timeout = p.HealthCheckTimeoutSeconds;
    if (p.HealthyThresholdCount) g.hc.healthy = p.HealthyThresholdCount;
    if (p.UnhealthyThresholdCount) g.hc.unhealthy = p.UnhealthyThresholdCount;
    if (p.Matcher) g.hc.matcher = p.Matcher.HttpCode;
    return g;
  });
}
export function describeTargetGroups(ctx: Ctx, p: { TargetGroupArns?: string[]; Names?: string[]; LoadBalancerArn?: string } = {}): TargetGroup[] {
  return trailed(ctx, SRC, 'DescribeTargetGroups', [], p, () => {
    authorize(ctx, 'elasticloadbalancing:DescribeTargetGroups', '*');
    for (const a of p.TargetGroupArns ?? []) getTg(ctx, a);
    for (const n of p.Names ?? []) if (!ctx.s.targetGroups.some((g) => g.name === n && g.region === ctx.region)) throw new AwsError('TargetGroupNotFound', `One or more target groups not found`);
    let list = ctx.s.targetGroups.filter((g) => g.region === ctx.region && (!p.TargetGroupArns?.length || p.TargetGroupArns.includes(g.arn)) && (!p.Names?.length || p.Names.includes(g.name)));
    if (p.LoadBalancerArn) { getLb(ctx, p.LoadBalancerArn); const used = ctx.s.listeners.filter((l) => l.lbArn === p.LoadBalancerArn).map((l) => l.tgArn); list = list.filter((g) => used.includes(g.arn)); }
    return list;
  });
}
export function deleteTargetGroup(ctx: Ctx, p: { TargetGroupArn: string }): void {
  return trailed(ctx, SRC, 'DeleteTargetGroup', [{ type: 'AWS::ElasticLoadBalancingV2::TargetGroup', name: p.TargetGroupArn }], { targetGroupArn: p.TargetGroupArn }, () => {
    authorize(ctx, 'elasticloadbalancing:DeleteTargetGroup', p.TargetGroupArn);
    const g = ctx.s.targetGroups.find((x) => x.arn === p.TargetGroupArn);
    if (!g) return;
    if (ctx.s.listeners.some((l) => l.tgArn === g.arn)) throw new AwsError('ResourceInUse', `Target group '${g.arn}' is currently in use by a listener or a rule`);
    if (ctx.s.asgs.some((a) => a.tgArns.includes(g.arn))) throw new AwsError('ResourceInUse', `Target group '${g.arn}' is currently in use by an Auto Scaling group`);
    if (cs(ctx.s).ecsServices.some((sv) => sv.loadBalancers.some((l) => l.targetGroupArn === g.arn))) throw new AwsError('ResourceInUse', `Target group '${g.arn}' is currently in use by an ECS service`);
    ctx.s.targetGroups = ctx.s.targetGroups.filter((x) => x !== g);
  });
}

export function registerTargets(ctx: Ctx, p: { TargetGroupArn: string; Targets: { Id: string; Port?: number }[] }): void {
  return trailed(ctx, SRC, 'RegisterTargets', [{ type: 'AWS::ElasticLoadBalancingV2::TargetGroup', name: p.TargetGroupArn }], { targetGroupArn: p.TargetGroupArn, targets: p.Targets }, () => {
    authorize(ctx, 'elasticloadbalancing:RegisterTargets', p.TargetGroupArn);
    const g = getTg(ctx, p.TargetGroupArn);
    settle(ctx.s);
    for (const t of p.Targets ?? []) {
      if (g.targetType === 'ip') {
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(t.Id)) throw new AwsError('ValidationError', `Target IP '${t.Id}' is not a valid IPv4 address`);
        if (!g.targets.some((x) => x.id === t.Id && x.port === (t.Port ?? g.port))) g.targets.push({ id: t.Id, port: Number(t.Port ?? g.port), since: now() });
        continue;
      }
      const i = ctx.s.instances.find((x) => x.id === t.Id);
      if (!i || i.state === 'terminated') throw new AwsError('InvalidTarget', `The following targets are not in a running state and cannot be registered: '${t.Id}'`);
      // Mensaje conservador: la API real rechaza instancias de otra VPC con un InvalidTarget.
      if (i.vpcId !== g.vpcId) throw new AwsError('InvalidTarget', `You cannot register instances '${t.Id}' because they are in a different VPC than the target group's VPC`);
      if (!g.targets.some((x) => x.id === t.Id && x.port === (t.Port ?? g.port))) g.targets.push({ id: t.Id, port: Number(t.Port ?? g.port), since: now() });
    }
  });
}
export function deregisterTargets(ctx: Ctx, p: { TargetGroupArn: string; Targets: { Id: string; Port?: number }[] }): void {
  return trailed(ctx, SRC, 'DeregisterTargets', [{ type: 'AWS::ElasticLoadBalancingV2::TargetGroup', name: p.TargetGroupArn }], { targetGroupArn: p.TargetGroupArn, targets: p.Targets }, () => {
    authorize(ctx, 'elasticloadbalancing:DeregisterTargets', p.TargetGroupArn);
    const g = getTg(ctx, p.TargetGroupArn);
    for (const t of p.Targets ?? []) g.targets = g.targets.filter((x) => !(x.id === t.Id && x.port === (t.Port ?? g.port)));
  });
}
export function describeTargetHealth(ctx: Ctx, p: { TargetGroupArn: string; Targets?: { Id: string; Port?: number }[] }) {
  return trailed(ctx, SRC, 'DescribeTargetHealth', [], { targetGroupArn: p.TargetGroupArn }, () => {
    authorize(ctx, 'elasticloadbalancing:DescribeTargetHealth', p.TargetGroupArn);
    const g = getTg(ctx, p.TargetGroupArn);
    const want = p.Targets?.length ? p.Targets : g.targets.map((t) => ({ Id: t.id, Port: t.port }));
    return want.map((w) => {
      const t = g.targets.find((x) => x.id === w.Id && x.port === (w.Port ?? g.port));
      if (!t) return { g, id: w.Id, port: w.Port ?? g.port, h: { state: 'unused', reason: 'Target.NotRegistered', description: 'Target is not registered to the target group' } as TargetState };
      return { g, id: t.id, port: t.port, h: targetHealth(ctx.s, g, t) };
    });
  });
}

// ------------------------------------------------------------------ oyentes

export function createListener(ctx: Ctx, p: { LoadBalancerArn: string; Protocol?: string; Port?: number; DefaultActions: { Type: string; TargetGroupArn?: string }[]; Certificates?: any[] }): Listener {
  return trailed(ctx, SRC, 'CreateListener', [{ type: 'AWS::ElasticLoadBalancingV2::Listener', name: p.LoadBalancerArn }], { loadBalancerArn: p.LoadBalancerArn, protocol: p.Protocol, port: p.Port }, () => {
    authorize(ctx, 'elasticloadbalancing:CreateListener', p.LoadBalancerArn);
    const lb = getLb(ctx, p.LoadBalancerArn);
    const protocol = p.Protocol ?? 'HTTP';
    if (!['HTTP', 'HTTPS'].includes(protocol)) throw new AwsError('ValidationError', `Protocol '${protocol}' is not supported by Application Load Balancers`);
    if (protocol === 'HTTPS' && !p.Certificates?.length) throw new AwsError('ValidationError', 'A certificate must be specified for HTTPS listeners');
    if (!p.Port || p.Port < 1 || p.Port > 65535) throw new AwsError('ValidationError', `Port '${p.Port}' not valid`);
    const act = p.DefaultActions?.[0];
    if (!act) throw new AwsError('ValidationError', "Default actions are required for listeners");
    if (act.Type !== 'forward' || !act.TargetGroupArn) throw new AwsError('ValidationError', `Only 'forward' actions with a TargetGroupArn are supported by this simulator`);
    const g = getTg(ctx, act.TargetGroupArn);
    if (g.vpcId !== lb.vpcId) throw new AwsError('ValidationError', `Target group '${g.arn}' is not in the same VPC as the load balancer`);
    if (ctx.s.listeners.some((l) => l.lbArn === lb.arn && l.port === Number(p.Port))) throw new AwsError('DuplicateListener', `A listener already exists on this port for this load balancer '${lb.arn}'`);
    const lid = lb.arn.split('/').slice(-2).join('/');
    const l: Listener = { arn: `arn:aws:elasticloadbalancing:${ctx.region}:${ctx.s.account.id}:listener/app/${lb.name}/${lid.split('/')[1]}/${hex(16)}`, lbArn: lb.arn, port: Number(p.Port), protocol, tgArn: g.arn };
    ctx.s.listeners.push(l);
    return l;
  });
}
export function describeListeners(ctx: Ctx, p: { LoadBalancerArn?: string; ListenerArns?: string[] }): Listener[] {
  return trailed(ctx, SRC, 'DescribeListeners', [], p, () => {
    authorize(ctx, 'elasticloadbalancing:DescribeListeners', '*');
    if (p.LoadBalancerArn) getLb(ctx, p.LoadBalancerArn);
    if (!p.LoadBalancerArn && !p.ListenerArns?.length) throw new AwsError('ValidationError', 'You must specify either listener ARNs or a load balancer ARN');
    return ctx.s.listeners.filter((l) => (!p.LoadBalancerArn || l.lbArn === p.LoadBalancerArn) && (!p.ListenerArns?.length || p.ListenerArns.includes(l.arn)));
  });
}
export function deleteListener(ctx: Ctx, p: { ListenerArn: string }): void {
  return trailed(ctx, SRC, 'DeleteListener', [], { listenerArn: p.ListenerArn }, () => {
    authorize(ctx, 'elasticloadbalancing:DeleteListener', p.ListenerArn);
    if (!ctx.s.listeners.some((l) => l.arn === p.ListenerArn)) throw new AwsError('ListenerNotFound', `Listeners '[${p.ListenerArn}]' not found`);
    ctx.s.listeners = ctx.s.listeners.filter((l) => l.arn !== p.ListenerArn);
  });
}
