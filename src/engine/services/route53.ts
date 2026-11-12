// Amazon Route 53: zonas alojadas, registros (simple, alias, ponderado, conmutación por error), comprobaciones de estado
// y un resolvedor DNS determinista que usan `dig`, `nslookup`, `test-dns-answer` y `curl`.
import type { CloudState, HealthCheck, HostedZone, RecordSet } from '../types';
import { AwsError } from '../errors';
import { trailed, authorize, type Ctx } from '../api';
import { guid, nowIso, randomString } from '../util';
import { reachableFromInternet } from './ec2';
import { elbByDns, elbHealthy, elbIps, isServing } from './elbv2';

const SRC = 'route53.amazonaws.com';
const UP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const zoneArn = (id: string) => `arn:aws:route53:::hostedzone/${id}`;
const fqdn = (n: string) => (n.toLowerCase().replace(/\\052/g, '*').replace(/\.$/, '')) + '.';
const TYPES = ['A', 'AAAA', 'CAA', 'CNAME', 'MX', 'NS', 'PTR', 'SOA', 'SPF', 'SRV', 'TXT'];

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
function nameServers(id: string): string[] {
  const h = hash(id);
  const tlds = ['org', 'co.uk', 'com', 'net'];
  return tlds.map((t, i) => `ns-${(h + i * 397) % 2048}.awsdns-${((h >> 3) + i * 7) % 64}.${t}.`);
}

export const changeId = () => `/change/C${randomString(20, UP)}`;
export function getZone(ctx: Ctx, id: string): HostedZone {
  const z = ctx.s.zones.find((x) => x.id === id.replace(/^\/hostedzone\//, ''));
  if (!z) throw new AwsError('NoSuchHostedZone', `No hosted zone found with ID: ${id.replace(/^\/hostedzone\//, '')}`, 404);
  return z;
}

export function createHostedZone(ctx: Ctx, p: { Name: string; CallerReference: string; HostedZoneConfig?: { Comment?: string; PrivateZone?: boolean }; VPC?: { VPCRegion: string; VPCId: string } }): { zone: HostedZone; change: { id: string; submitted: string } } {
  const id = 'Z' + randomString(19, UP);
  return trailed(ctx, SRC, 'CreateHostedZone', [{ type: 'AWS::Route53::HostedZone', name: id }], { name: p.Name, callerReference: p.CallerReference }, () => {
    authorize(ctx, 'route53:CreateHostedZone', '*');
    if (!p.Name) throw new AwsError('InvalidInput', 'Invalid request: Expected exactly one of [Name], but found none');
    const name = fqdn(p.Name);
    if (!/^([a-z0-9_*-]+\.)+$/.test(name) || name.length > 254) throw new AwsError('InvalidDomainName', `${p.Name} is not a valid DNS name.`);
    if (ctx.s.zones.some((z) => z.callerRef === p.CallerReference)) throw new AwsError('HostedZoneAlreadyExists', `A hosted zone has already been created with the specified caller reference.`, 409);
    const priv = !!p.HostedZoneConfig?.PrivateZone;
    if (priv && !p.VPC) throw new AwsError('InvalidInput', 'When creating private hosted zone, user must provide a VPC id and region');
    if (priv && !ctx.s.vpcs.some((v) => v.id === p.VPC!.VPCId)) throw new AwsError('InvalidVPCId', `The VPC ID '${p.VPC!.VPCId}' that you provided is invalid or not found`);
    if (!priv && p.VPC) throw new AwsError('InvalidInput', 'A VPC can only be associated with a private hosted zone');
    const ns = nameServers(id);
    const z: HostedZone = {
      id, name, comment: p.HostedZoneConfig?.Comment, isPrivate: priv, vpcs: priv ? [{ id: p.VPC!.VPCId, region: p.VPC!.VPCRegion }] : [], callerRef: p.CallerReference, createdAt: nowIso(), nameServers: ns,
      records: [
        { name, type: 'NS', ttl: 172800, values: ns },
        { name, type: 'SOA', ttl: 900, values: [`${ns[0]} awsdns-hostmaster.amazon.com. 1 7200 900 1209600 86400`] },
      ],
    };
    ctx.s.zones.push(z);
    return { zone: z, change: { id: changeId(), submitted: nowIso() } };
  });
}
export function listHostedZones(ctx: Ctx): HostedZone[] {
  return trailed(ctx, SRC, 'ListHostedZones', [], {}, () => { authorize(ctx, 'route53:ListHostedZones', '*'); return ctx.s.zones; });
}
export function getHostedZone(ctx: Ctx, p: { Id: string }): HostedZone {
  return trailed(ctx, SRC, 'GetHostedZone', [], { id: p.Id }, () => { authorize(ctx, 'route53:GetHostedZone', zoneArn(p.Id.replace(/^\/hostedzone\//, ''))); return getZone(ctx, p.Id); });
}
export function deleteHostedZone(ctx: Ctx, p: { Id: string }): { id: string; submitted: string } {
  return trailed(ctx, SRC, 'DeleteHostedZone', [{ type: 'AWS::Route53::HostedZone', name: p.Id }], { id: p.Id }, () => {
    const z = getZone(ctx, p.Id);
    authorize(ctx, 'route53:DeleteHostedZone', zoneArn(z.id));
    if (z.records.some((r) => r.type !== 'NS' && r.type !== 'SOA')) throw new AwsError('HostedZoneNotEmpty', `The specified hosted zone contains non-required resource record sets and so cannot be deleted.`, 400);
    ctx.s.zones = ctx.s.zones.filter((x) => x !== z);
    return { id: changeId(), submitted: nowIso() };
  });
}

export interface Change { Action: 'CREATE' | 'DELETE' | 'UPSERT'; ResourceRecordSet: any }
const desc = (r: { name: string; type: string; setId?: string }) => `[name='${r.name}', type='${r.type}'${r.setId ? `, set-identifier='${r.setId}'` : ''}]`;

function toRecord(z: HostedZone, rr: any): RecordSet {
  const name = fqdn(rr.Name ?? '');
  const type = String(rr.Type ?? '').toUpperCase();
  if (!TYPES.includes(type)) throw new AwsError('InvalidInput', `Invalid XML ; cvc-enumeration-valid: Value '${rr.Type}' is not facet-valid with respect to enumeration '[SOA, A, TXT, NS, CNAME, MX, NAPTR, PTR, SRV, SPF, AAAA, CAA, DS]'. It must be a value from the enumeration.`);
  if (name !== z.name && !name.endsWith('.' + z.name)) throw new AwsError('InvalidChangeBatch', `RRSet with DNS name ${name} is not permitted in zone ${z.name}`);
  const rec: RecordSet = { name, type, values: [] };
  if (rr.SetIdentifier) rec.setId = rr.SetIdentifier;
  if (rr.Weight !== undefined) rec.weight = Number(rr.Weight);
  if (rr.Failover) rec.failover = rr.Failover;
  if (rr.HealthCheckId) rec.healthCheckId = rr.HealthCheckId;
  const routed = rec.weight !== undefined || rec.failover;
  if (routed && !rec.setId) throw new AwsError('InvalidChangeBatch', `Invalid request: RRSet with DNS name ${name}, type ${type} has a routing policy but no SetIdentifier. Set identifiers are required when using routing policies.`.replace('Invalid request: ', ''));
  if (rec.setId && !routed) throw new AwsError('InvalidChangeBatch', `RRSet with DNS name ${name}, type ${type} has a SetIdentifier but no routing policy`);
  if (rec.weight !== undefined && (rec.weight < 0 || rec.weight > 255)) throw new AwsError('InvalidInput', `Invalid XML ; cvc-maxInclusive-valid: Value '${rec.weight}' is not facet-valid with respect to maxInclusive '255' for type 'RRSetWeight'.`);
  if (rr.AliasTarget) {
    if (rr.TTL !== undefined || rr.ResourceRecords) throw new AwsError('InvalidInput', 'Invalid request: Expected exactly one of [AliasTarget, all of [TTL, and ResourceRecords], or TrafficPolicyInstanceId], but you specified more than one');
    rec.alias = { zoneId: rr.AliasTarget.HostedZoneId, dnsName: fqdn(rr.AliasTarget.DNSName), evalHealth: rr.AliasTarget.EvaluateTargetHealth === true || rr.AliasTarget.EvaluateTargetHealth === 'true' };
    if (!['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'SRV', 'CAA', 'PTR', 'SPF'].includes(type)) throw new AwsError('InvalidChangeBatch', `Alias is not permitted for type ${type}`);
  } else {
    if (rr.TTL === undefined || !rr.ResourceRecords?.length) throw new AwsError('InvalidInput', 'Invalid request: Expected exactly one of [AliasTarget, all of [TTL, and ResourceRecords], or TrafficPolicyInstanceId], but found none');
    rec.ttl = Number(rr.TTL);
    rec.values = rr.ResourceRecords.map((v: any) => String(v.Value));
    if (type === 'A') for (const v of rec.values) if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(v) || v.split('.').some((o) => Number(o) > 255)) throw new AwsError('InvalidChangeBatch', `Invalid Resource Record: FATAL problem: ARRecordIPAddressNotValid (Value is not a valid IPv4 address) encountered with '${v}'`);
    if (type === 'CNAME' && rec.values.length > 1) throw new AwsError('InvalidChangeBatch', `RRSet of type CNAME with DNS name ${name} is not permitted to have multiple values`.replace('RRSet', 'RRSet'));
  }
  if (type === 'CNAME' && name === z.name) throw new AwsError('InvalidChangeBatch', `RRSet of type CNAME with DNS name ${name} is not permitted at apex in zone ${z.name}`);
  return rec;
}

export function changeResourceRecordSets(ctx: Ctx, p: { HostedZoneId: string; ChangeBatch: { Comment?: string; Changes: Change[] } }) {
  const zid = p.HostedZoneId.replace(/^\/hostedzone\//, '');
  return trailed(ctx, SRC, 'ChangeResourceRecordSets', [{ type: 'AWS::Route53::HostedZone', name: zid }], { hostedZoneId: zid, changeBatch: p.ChangeBatch }, () => {
    const z = getZone(ctx, zid);
    authorize(ctx, 'route53:ChangeResourceRecordSets', zoneArn(z.id));
    const batch = p.ChangeBatch?.Changes;
    if (!batch?.length) throw new AwsError('InvalidInput', 'Invalid request: Expected exactly one of [Changes], but found none'.replace('exactly one of ', ''));
    const work = z.records.map((r) => ({ ...r }));
    const same = (a: RecordSet, b: RecordSet) => a.name === b.name && a.type === b.type && (a.setId ?? '') === (b.setId ?? '');
    for (const ch of batch) {
      const rec = toRecord(z, ch.ResourceRecordSet);
      const i = work.findIndex((x) => same(x, rec));
      if (ch.Action === 'CREATE') {
        if (i >= 0) throw new AwsError('InvalidChangeBatch', `Tried to create resource record set ${desc(rec)} but it already exists`);
        work.push(rec);
      } else if (ch.Action === 'DELETE') {
        if (i < 0) throw new AwsError('InvalidChangeBatch', `Tried to delete resource record set ${desc(rec)}, but it was not found`);
        const cur = work[i];
        if (cur.type === 'NS' && cur.name === z.name || cur.type === 'SOA') throw new AwsError('InvalidChangeBatch', `Tried to delete the apex ${cur.type} record of the hosted zone`.replace('the apex', 'a required'));
        if (JSON.stringify([cur.values, cur.ttl, cur.alias?.dnsName]) !== JSON.stringify([rec.values, rec.ttl, rec.alias?.dnsName])) throw new AwsError('InvalidChangeBatch', `Tried to delete resource record set ${desc(rec)} but the values provided do not match the current values`);
        work.splice(i, 1);
      } else if (ch.Action === 'UPSERT') {
        if (i >= 0) work[i] = rec; else work.push(rec);
      } else throw new AwsError('InvalidInput', `Invalid XML ; cvc-enumeration-valid: Value '${ch.Action}' is not facet-valid with respect to enumeration '[DELETE, CREATE, UPSERT]'. It must be a value from the enumeration.`);
      // CNAME no puede coexistir con otros tipos con el mismo nombre.
      const sameName = work.filter((x) => x.name === rec.name);
      if (rec.type === 'CNAME' && sameName.some((x) => x.type !== 'CNAME') && ch.Action !== 'DELETE') throw new AwsError('InvalidChangeBatch', `RRSet of type CNAME with DNS name ${rec.name} is not permitted as it conflicts with other records with the same DNS name in zone ${z.name}`);
      if (rec.type !== 'CNAME' && ch.Action !== 'DELETE' && sameName.some((x) => x.type === 'CNAME')) throw new AwsError('InvalidChangeBatch', `RRSet of type ${rec.type} with DNS name ${rec.name} is not permitted as it conflicts with other records with the same DNS name in zone ${z.name}`);
    }
    z.records = work;
    return { id: changeId(), submitted: nowIso() };
  });
}

export function listResourceRecordSets(ctx: Ctx, p: { HostedZoneId: string }): RecordSet[] {
  return trailed(ctx, SRC, 'ListResourceRecordSets', [], { hostedZoneId: p.HostedZoneId }, () => {
    const z = getZone(ctx, p.HostedZoneId);
    authorize(ctx, 'route53:ListResourceRecordSets', zoneArn(z.id));
    return [...z.records].sort((a, b) => a.name.split('.').reverse().join('.').localeCompare(b.name.split('.').reverse().join('.')) || a.type.localeCompare(b.type));
  });
}

// ------------------------------------------------------------------ comprobaciones de estado

export function createHealthCheck(ctx: Ctx, p: { CallerReference: string; HealthCheckConfig: any }): HealthCheck {
  return trailed(ctx, SRC, 'CreateHealthCheck', [], { callerReference: p.CallerReference }, () => {
    authorize(ctx, 'route53:CreateHealthCheck', '*');
    const c = p.HealthCheckConfig ?? {};
    const type = String(c.Type ?? '').toUpperCase();
    if (!['HTTP', 'HTTPS', 'TCP'].includes(type)) throw new AwsError('InvalidInput', `Invalid XML ; cvc-enumeration-valid: Value '${c.Type}' is not facet-valid with respect to enumeration '[HTTP, HTTPS, HTTP_STR_MATCH, HTTPS_STR_MATCH, TCP, CALCULATED, CLOUDWATCH_METRIC, RECOVERY_CONTROL]'. It must be a value from the enumeration.`);
    if (!c.IPAddress && !c.FullyQualifiedDomainName) throw new AwsError('InvalidInput', 'Invalid request: Expected exactly one of [IPAddress, FullyQualifiedDomainName], but found none'.replace('Expected exactly one of', 'Expected at least one of'));
    const ex = ctx.s.healthChecks.find((h) => h.callerRef === p.CallerReference);
    if (ex) throw new AwsError('HealthCheckAlreadyExists', `A health check with the same caller reference already exists`, 409);
    const h: HealthCheck = { id: guid(), callerRef: p.CallerReference, type: type as HealthCheck['type'], ip: c.IPAddress, fqdn: c.FullyQualifiedDomainName, port: Number(c.Port ?? (type === 'HTTPS' ? 443 : 80)), path: type === 'TCP' ? undefined : (c.ResourcePath ?? '/'), interval: Number(c.RequestInterval ?? 30), threshold: Number(c.FailureThreshold ?? 3) };
    ctx.s.healthChecks.push(h);
    return h;
  });
}
export const listHealthChecks = (ctx: Ctx) => trailed(ctx, SRC, 'ListHealthChecks', [], {}, () => { authorize(ctx, 'route53:ListHealthChecks', '*'); return ctx.s.healthChecks; });
export function deleteHealthCheck(ctx: Ctx, p: { HealthCheckId: string }): void {
  return trailed(ctx, SRC, 'DeleteHealthCheck', [], { id: p.HealthCheckId }, () => {
    authorize(ctx, 'route53:DeleteHealthCheck', `arn:aws:route53:::healthcheck/${p.HealthCheckId}`);
    if (!ctx.s.healthChecks.some((h) => h.id === p.HealthCheckId)) throw new AwsError('NoSuchHealthCheck', `No health check exists with the specified ID.`, 404);
    if (ctx.s.zones.some((z) => z.records.some((r) => r.healthCheckId === p.HealthCheckId))) throw new AwsError('HealthCheckInUse', `This health check is still associated with a resource record set.`, 400);
    ctx.s.healthChecks = ctx.s.healthChecks.filter((h) => h.id !== p.HealthCheckId);
  });
}
/** Estado del punto de enlace: alcanzable desde Internet y con un servidor web (para HTTP/HTTPS). */
export function hcStatus(s: CloudState, h: HealthCheck): { ok: boolean; report: string } {
  const inst = h.ip ? s.instances.find((i) => i.publicIp === h.ip && i.state !== 'terminated') : undefined;
  if (!h.ip) return { ok: true, report: h.type === 'TCP' ? 'Success: TCP connection successful' : 'Success: HTTP Status Code 200, OK' };
  if (!inst) return { ok: false, report: 'Failure: Connection timed out. The endpoint did not respond to the health check request in the time allowed' };
  const r = reachableFromInternet(s, inst, h.port);
  if (!r.ok) return { ok: false, report: 'Failure: Connection timed out. The endpoint did not respond to the health check request in the time allowed' };
  if (h.type !== 'TCP' && !isServing(inst)) return { ok: false, report: 'Failure: HTTP Status Code 502, Bad Gateway. The endpoint must respond with a 2xx or 3xx status code' };
  return { ok: true, report: h.type === 'TCP' ? 'Success: TCP connection successful' : 'Success: HTTP Status Code 200, OK' };
}
export function getHealthCheckStatus(ctx: Ctx, p: { HealthCheckId: string }) {
  return trailed(ctx, SRC, 'GetHealthCheckStatus', [], { id: p.HealthCheckId }, () => {
    authorize(ctx, 'route53:GetHealthCheckStatus', `arn:aws:route53:::healthcheck/${p.HealthCheckId}`);
    const h = ctx.s.healthChecks.find((x) => x.id === p.HealthCheckId);
    if (!h) throw new AwsError('NoSuchHealthCheck', `No health check exists with the specified ID.`, 404);
    return { h, ...hcStatus(ctx.s, h) };
  });
}

// ------------------------------------------------------------------ resolvedor

export interface DnsAnswer { name: string; ttl: number; type: string; data: string }
export interface DnsResult { rcode: 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL'; answers: DnsAnswer[]; zone?: HostedZone }

let queries = 0;
const recHealthy = (s: CloudState, r: RecordSet): boolean => {
  if (r.healthCheckId) { const h = s.healthChecks.find((x) => x.id === r.healthCheckId); return h ? hcStatus(s, h).ok : true; }
  if (r.alias?.evalHealth) { const lb = elbByDns(s, r.alias.dnsName); return lb ? elbHealthy(s, lb) : true; }
  return true;
};
function pick(s: CloudState, rs: RecordSet[]): RecordSet[] {
  if (rs.length <= 1 || !rs.some((r) => r.setId)) return rs;
  if (rs.some((r) => r.failover)) {
    const prim = rs.find((r) => r.failover === 'PRIMARY'), sec = rs.find((r) => r.failover === 'SECONDARY');
    if (prim && recHealthy(s, prim)) return [prim];
    if (sec && (recHealthy(s, sec) || (prim && !recHealthy(s, prim)))) return [sec];
    return [prim ?? sec!];
  }
  const healthy = rs.filter((r) => recHealthy(s, r));
  const pool = (healthy.length ? healthy : rs).filter((r) => (r.weight ?? 0) > 0);
  if (!pool.length) return [(healthy.length ? healthy : rs)[0]];
  const total = pool.reduce((a, r) => a + (r.weight ?? 0), 0);
  let n = hash(String(queries++) + 'w') % total;
  for (const r of pool) { if (n < (r.weight ?? 0)) return [r]; n -= r.weight ?? 0; }
  return [pool[0]];
}

export function zoneFor(s: CloudState, name: string, vpcId?: string): HostedZone | undefined {
  return s.zones.filter((z) => (name === z.name || name.endsWith('.' + z.name)) && (!z.isPrivate || (vpcId && z.vpcs.some((v) => v.id === vpcId)))).sort((a, b) => b.name.length - a.name.length)[0];
}

export function resolve(s: CloudState, rawName: string, type = 'A', opts: { vpcId?: string } = {}, depth = 0): DnsResult {
  const name = fqdn(rawName);
  type = type.toUpperCase();
  const elb = elbByDns(s, name);
  if (elb) return { rcode: 'NOERROR', answers: type === 'A' ? elbIps(elb).map((ip) => ({ name, ttl: 60, type: 'A', data: ip })) : [] };
  const zone = zoneFor(s, name, opts.vpcId);
  if (!zone) return { rcode: 'NXDOMAIN', answers: [] };
  const wild = (n: string) => '*.' + n.split('.').slice(1).join('.');
  const named = (n: string) => zone.records.filter((r) => r.name === n);
  let atName = named(name);
  if (!atName.length) atName = named(wild(name));
  if (!atName.length) return { rcode: 'NXDOMAIN', answers: [], zone };
  const out: DnsAnswer[] = [];
  const direct = atName.filter((r) => r.type === type);
  const cname = atName.filter((r) => r.type === 'CNAME');
  if (direct.length) {
    for (const r of pick(s, direct)) {
      if (r.alias) {
        const a = r.alias;
        const lb = elbByDns(s, a.dnsName);
        if (lb) { if (type === 'A') out.push(...elbIps(lb).map((ip) => ({ name, ttl: 60, type: 'A', data: ip }))); }
        else if (a.zoneId === zone.id || zoneFor(s, a.dnsName, opts.vpcId)) { if (depth < 8) out.push(...resolve(s, a.dnsName, type, opts, depth + 1).answers.map((x) => ({ ...x, name }))); }
        else out.push({ name, ttl: 60, type: 'A', data: `52.218.${hash(a.dnsName) % 250}.${hash(a.dnsName + 'b') % 250}` });
      } else for (const v of r.values) out.push({ name, ttl: r.ttl ?? 300, type: r.type, data: v });
    }
  } else if (cname.length && type !== 'CNAME') {
    const r = pick(s, cname)[0];
    out.push({ name, ttl: r.ttl ?? 300, type: 'CNAME', data: r.values[0] });
    if (depth < 8) out.push(...resolve(s, r.values[0], type, opts, depth + 1).answers);
  }
  return { rcode: 'NOERROR', answers: out, zone };
}

export function testDnsAnswer(ctx: Ctx, p: { HostedZoneId: string; RecordName: string; RecordType: string }) {
  return trailed(ctx, SRC, 'TestDNSAnswer', [], { hostedZoneId: p.HostedZoneId, recordName: p.RecordName, recordType: p.RecordType }, () => {
    const z = getZone(ctx, p.HostedZoneId);
    authorize(ctx, 'route53:TestDNSAnswer', zoneArn(z.id));
    const r = resolve(ctx.s, p.RecordName, p.RecordType, { vpcId: z.vpcs[0]?.id });
    return { z, r };
  });
}
