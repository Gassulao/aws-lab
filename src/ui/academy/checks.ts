// Contexto de validación de los laboratorios: consultas sobre la nube simulada, los comandos ejecutados y los ficheros.
import type { CloudState, CommandLogEntry, IamRole, IamUser, PolicyDocument, PolicyStatement, S3Bucket, SecurityGroup, Subnet, Vpc, Instance, RouteTable } from '../../engine/types';
import { VFS } from '../../shell/fs';
import { homeDir } from '../../engine/store';
import { anonymousGet } from '../../engine/services/s3';
import { s3Target } from '../../shell/commands';
import { settle, isPublicSubnet, reachableFromInternet, canReachInternet, routeTableOfSubnet } from '../../engine/services/ec2';
import { check as iamCheck, type Caller } from '../../engine/api';
import { wildcardMatch } from '../../engine/util';
import { kmsDenial } from '../../engine/services/kms';
import { settleCw } from '../../engine/services/cloudwatch';
import type { KmsKey, Secret, HostedZone, LoadBalancer, TargetGroup, Asg } from '../../engine/types';
import { targetHealth } from '../../engine/services/elbv2';
import { groupInstances } from '../../engine/services/autoscaling';

export class CheckCtx {
  private fsCache: VFS | null = null;
  constructor(public s: CloudState, public since: number) {}

  // ---------------------------------------------------------------- comandos
  cmds(source?: CommandLogEntry['source'][]): CommandLogEntry[] {
    return this.s.cli.commandLog.filter((c) => c.ts >= this.since && (!source || source.includes(c.source)));
  }
  /** ¿Se ejecutó con éxito un comando que cumple el patrón? */
  ran(re: RegExp): boolean {
    return this.cmds(['typed', 'shell']).some((c) => re.test(c.cmd) && c.ok);
  }
  /** ¿Se intentó (aunque fallara)? */
  tried(re: RegExp): boolean {
    return this.cmds(['typed', 'shell']).some((c) => re.test(c.cmd));
  }
  /** ¿Falló un comando que cumple el patrón? */
  failed(re: RegExp): boolean {
    return this.cmds(['typed', 'shell']).some((c) => re.test(c.cmd) && !c.ok);
  }

  // ---------------------------------------------------------------- cuenta
  get account() {
    return this.s.account.id;
  }
  get me() {
    return this.s.me;
  }
  /** Evento de CloudTrail correcto (o con error) desde que empezó el laboratorio. */
  trail(eventName: string, opts: { error?: string | boolean } = {}) {
    return this.s.trail.filter((e) => e.eventName === eventName && Date.parse(e.time) >= this.since && (opts.error === undefined ? true : opts.error === true ? !!e.errorCode : opts.error === false ? !e.errorCode : e.errorCode === opts.error));
  }

  /** Eventos de CloudTrail generados por un usuario o rol concretos (por nombre de principal). */
  trailBy(who: string, eventName: string, opts: { error?: string | boolean } = {}) {
    return this.trail(eventName, opts).filter((e) => e.userName === who || e.principalArn.endsWith('/' + who) || e.principalArn.includes(`/${who}/`));
  }

  // ---------------------------------------------------------------- IAM
  /** Decisión de IAM para un usuario o rol: 'Allow' | 'ImplicitDeny' | 'ExplicitDeny' (sin dejar rastro en CloudTrail). */
  decide(principal: string, action: string, resource = '*', context: Record<string, any> = {}): string {
    const u = this.user(principal);
    const r = u ? undefined : this.role(principal);
    if (!u && !r) return 'NoSuchPrincipal';
    const caller: Caller = u
      ? { type: 'IAMUser', arn: u.arn, userName: u.name, mfa: false, sourceIp: '203.0.113.10' }
      : { type: 'AssumedRole', arn: `arn:aws:sts::${this.s.account.id}:assumed-role/${r!.name}/lab`, userName: 'lab', roleName: r!.name, mfa: false, sourceIp: '203.0.113.10' };
    return iamCheck({ s: this.s, caller, region: this.s.region }, action, resource, { context }).decision;
  }
  /** Sentencias de una política de cliente. */
  statements(policyName: string): PolicyStatement[] {
    const d: PolicyDocument | undefined = this.policy(policyName)?.document;
    if (!d) return [];
    return ([] as PolicyStatement[]).concat(d.Statement as any);
  }
  /** ¿Alguna sentencia con ese efecto cubre la acción (comodines incluidos)? */
  stmtCovers(sts: PolicyStatement[], effect: 'Allow' | 'Deny', action: string, pred: (st: PolicyStatement) => boolean = () => true): boolean {
    return sts.some((st) => st.Effect === effect && ([] as string[]).concat((st.Action as any) ?? []).some((a) => wildcardMatch(a, action, true)) && pred(st));
  }
  accessKeys(userName: string) {
    return this.user(userName)?.accessKeys ?? [];
  }

  user(name: string): IamUser | undefined {
    return this.s.users.find((u) => u.name === name);
  }
  group(name: string) {
    return this.s.groups.find((g) => g.name === name);
  }
  role(name: string): IamRole | undefined {
    return this.s.roles.find((r) => r.name === name);
  }
  policy(name: string) {
    return this.s.policies.find((p) => p.name === name && p.managed === 'customer');
  }
  userHas(name: string, policyArnOrName: string): boolean {
    const u = this.user(name);
    return !!u && u.attached.some((a) => a === policyArnOrName || a.endsWith('/' + policyArnOrName));
  }
  roleHas(name: string, policyArnOrName: string): boolean {
    const r = this.role(name);
    return !!r && r.attached.some((a) => a === policyArnOrName || a.endsWith('/' + policyArnOrName));
  }

  // ---------------------------------------------------------------- S3
  bucket(name: string): S3Bucket | undefined {
    return this.s.buckets.find((b) => b.name === name);
  }
  bucketLike(re: RegExp): S3Bucket | undefined {
    return this.s.buckets.find((b) => re.test(b.name));
  }
  object(bucket: string, key: string) {
    return this.bucket(bucket)?.objects[key];
  }
  /** Petición HTTP anónima a una URL de S3, como la haría un navegador. */
  http(url: string): { status: number; body: string } {
    const t = s3Target(url);
    if (!t) return { status: 0, body: '' };
    return anonymousGet(this.s, t.bucket, t.key, t.website);
  }
  httpOk(url: string, contains?: string | RegExp): boolean {
    const r = this.http(url);
    if (r.status !== 200) return false;
    if (!contains) return true;
    return typeof contains === 'string' ? r.body.includes(contains) : contains.test(r.body);
  }

  bucketPolicyText(name: string): string {
    const b = this.bucket(name);
    return b?.policy ? JSON.stringify(b.policy) : '';
  }

  // ---------------------------------------------------------------- red y EC2
  routeTableOf(sub: Subnet): RouteTable {
    return routeTableOfSubnet(this.s, sub);
  }
  /** Alcance desde internet por TCP (IP de origen del alumno por defecto 203.0.113.50). */
  reach(inst: Instance, port: number, src = '203.0.113.50') {
    return reachableFromInternet(this.s, inst, port, src);
  }
  egress(inst: Instance) {
    return canReachInternet(this.s, inst);
  }
  sgById(id: string): SecurityGroup | undefined {
    return this.s.securityGroups.find((g) => g.id === id);
  }
  vpc(cidrOrName: string): Vpc | undefined {
    return this.s.vpcs.find((v) => !v.isDefault && (v.cidr === cidrOrName || v.tags.Name === cidrOrName || v.id === cidrOrName));
  }
  vpcs(): Vpc[] {
    return this.s.vpcs.filter((v) => !v.isDefault);
  }
  subnets(vpcId: string): Subnet[] {
    return this.s.subnets.filter((x) => x.vpcId === vpcId);
  }
  isPublic(sub: Subnet): boolean {
    return isPublicSubnet(this.s, sub);
  }
  sg(name: string, vpcId?: string): SecurityGroup | undefined {
    return this.s.securityGroups.find((g) => g.name === name && (!vpcId || g.vpcId === vpcId));
  }
  sgAllows(sg: SecurityGroup, port: number, cidr: string): boolean {
    return sg.ingress.some((r) => r.cidr === cidr && (r.protocol === '-1' || (r.protocol === 'tcp' && r.from <= port && port <= r.to)));
  }
  instances(pred: (i: Instance) => boolean = () => true): Instance[] {
    settle(this.s);
    return this.s.instances.filter((i) => i.state !== 'terminated' && pred(i));
  }
  instance(pred: (i: Instance) => boolean = () => true): Instance | undefined {
    return this.instances(pred)[0];
  }

  // ---------------------------------------------------------------- KMS y Secrets Manager
  /** Clave de KMS por alias (con o sin `alias/`) o por id. Sin efectos laterales. */
  kmsKey(ref: string): KmsKey | undefined {
    const al = this.s.kmsAliases.find((a) => a.name === (ref.startsWith('alias/') ? ref : `alias/${ref}`));
    const id = al?.keyId ?? ref;
    return this.s.kmsKeys.find((k) => k.id === id || k.arn === id);
  }
  /** ¿Puede ese usuario o rol ejecutar la acción de KMS sobre la clave según su política, grants e IAM? */
  kmsCan(principal: string, action: string, key: KmsKey): boolean {
    const u = this.user(principal);
    const r = u ? undefined : this.role(principal);
    if (!u && !r) return false;
    const caller: Caller = u
      ? { type: 'IAMUser', arn: u.arn, userName: u.name, mfa: false, sourceIp: '203.0.113.10' }
      : { type: 'AssumedRole', arn: `arn:aws:sts::${this.s.account.id}:assumed-role/${r!.name}/lab`, userName: 'lab', roleName: r!.name, mfa: false, sourceIp: '203.0.113.10' };
    return kmsDenial({ s: this.s, caller, region: this.s.region } as any, key, action) === null;
  }
  /** Alarma de CloudWatch tras reevaluarla con el reloj actual. */
  alarm(name: string) {
    settleCw(this.s, true);
    return this.s.alarms.find((a) => a.name === name);
  }
  topic(name: string) {
    return this.s.topics.find((t) => t.name === name);
  }
  logGroup(name: string) {
    return this.s.logGroups.find((g) => g.name === name);
  }
  secret(name: string): Secret | undefined {
    return this.s.secrets.find((x) => x.name === name);
  }

  // ---------------------------------------------------------------- ficheros
  get home() {
    return homeDir(this.s);
  }
  private fs(): VFS {
    if (!this.fsCache) this.fsCache = new VFS(this.s.fs);
    return this.fsCache;
  }
  // ---------------------------------------------------------------- Route 53, ELB y Auto Scaling
  zone(name: string): HostedZone | undefined {
    const n = name.endsWith('.') ? name : name + '.';
    return this.s.zones.find((z) => z.name === n);
  }
  lb(name: string): LoadBalancer | undefined {
    return this.s.loadBalancers.find((l) => l.name === name);
  }
  tg(name: string): TargetGroup | undefined {
    return this.s.targetGroups.find((g) => g.name === name);
  }
  /** Estado de salud de cada destino de un grupo de destino (instancia -> estado). */
  targetStates(name: string): Record<string, string> {
    const g = this.tg(name);
    settle(this.s);
    return Object.fromEntries((g?.targets ?? []).map((t) => [t.id, targetHealth(this.s, g!, t).state]));
  }
  asg(name: string): Asg | undefined {
    settle(this.s);
    return this.s.asgs.find((g) => g.name === name);
  }
  asgInstances(name: string) {
    const g = this.asg(name);
    return g ? groupInstances(this.s, g) : [];
  }

  /** Estado de Terraform (`terraform.tfstate`) de un directorio del usuario, o null si no existe. */
  tf(dir: string): { addrs: string[]; attr: (addr: string, key: string) => any } | null {
    const raw = this.file(`${dir.replace(/\/$/, '')}/terraform.tfstate`);
    if (!raw) return null;
    try {
      const st = JSON.parse(raw);
      const insts = (st.resources as any[]).flatMap((r) => r.instances.map((i: any) => ({ addr: `${r.mode === 'data' ? 'data.' : ''}${r.type}.${r.name}${i.index_key === undefined ? '' : typeof i.index_key === 'number' ? `[${i.index_key}]` : `["${i.index_key}"]`}`, attrs: i.attributes })));
      return { addrs: insts.map((i) => i.addr).sort(), attr: (addr, key) => insts.find((i) => i.addr === addr)?.attrs?.[key] };
    } catch {
      return null;
    }
  }

  /** Permisos octales de un fichero o carpeta del sistema de archivos simulado (null si no existe). */
  fileMode(path: string): number | null {
    const abs = path.startsWith('/') ? path : `${this.home}/${path.replace(/^~\//, '')}`;
    try {
      return this.fs().stat(abs)?.mode ?? null;
    } catch {
      return null;
    }
  }

  file(path: string): string | null {
    const abs = path.startsWith('/') ? path : `${this.home}/${path.replace(/^~\//, '')}`;
    try {
      return this.fs().isFile(abs) ? this.fs().readFile(abs) : null;
    } catch {
      return null;
    }
  }
}
