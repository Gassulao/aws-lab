// Peticiones HTTP simuladas hacia instancias, balanceadores y nombres de Route 53 (para `curl`).
import type { CloudState, Instance } from '../types';
import { reachableFromInternet } from './ec2';
import { elbByDns, elbIps, healthyInstances, ipTargets, isServing, lbState } from './elbv2';
import { resolve } from './route53';

export type WebResult = { kind: 'ok'; status: number; headers: Record<string, string>; body: string } | { kind: 'nohost' | 'refused' | 'timeout' | 'ssl'; host: string; port: number };

const hostnameOf = (i: Instance) => `ip-${i.privateIp.replace(/\./g, '-')}.${i.region}.compute.internal`;
let rr = 0;

function instanceResponse(s: CloudState, i: Instance, host: string, port: number): WebResult {
  const r = reachableFromInternet(s, i, port);
  if (!r.ok) return { kind: 'timeout', host, port };
  if (!isServing(i)) return { kind: 'refused', host, port };
  return { kind: 'ok', status: 200, headers: { server: 'Apache/2.4.62 ()', 'content-type': 'text/html; charset=UTF-8' }, body: `<h1>Hola desde ${hostnameOf(i)}</h1>\n` };
}

/** Otros módulos (Docker en localhost, Services de Kubernetes) atienden sus propios nombres de host. */
export const webHooks: ((s: CloudState, host: string, port: number, scheme: string, rawUrl?: string) => WebResult | null)[] = [];

/** Método, cabeceras y cuerpo de la petición en curso (los fija `curl -X/-H/-d` antes de llamar a webGet). */
export const webRequest: { method: string; headers: Record<string, string>; body: string } = { method: 'GET', headers: {}, body: '' };

export function webGet(s: CloudState, rawUrl: string): WebResult | null {
  const u = /^(https?):\/\/([^/:?#]+)(?::(\d+))?/.exec(rawUrl);
  if (!u) return null;
  const host = u[2].toLowerCase();
  const port = Number(u[3] ?? (u[1] === 'https' ? 443 : 80));
  for (const h of webHooks) { const r = h(s, host, port, u[1], rawUrl); if (r) return r; }
  let ips: string[];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) ips = [host];
  else {
    const r = resolve(s, host, 'A');
    ips = r.answers.filter((a) => a.type === 'A').map((a) => a.data);
    if (!ips.length) return { kind: 'nohost', host, port };
  }
  const ip = ips[0];
  const lb = s.loadBalancers.find((l) => elbIps(l).includes(ip) || elbByDns(s, host)?.arn === l.arn);
  if (lb) {
    const l = s.listeners.find((x) => x.lbArn === lb.arn && x.port === port);
    if (!l || lbState(lb) !== 'active') return { kind: 'refused', host, port };
    if (u[1] === 'https') return { kind: 'ssl', host, port };
    const sgOpen = lb.securityGroups.some((id) => s.securityGroups.find((g) => g.id === id)?.ingress.some((r) => r.cidr === '0.0.0.0/0' && (r.protocol === '-1' || (r.protocol === 'tcp' && r.from <= port && port <= r.to))));
    if (lb.scheme === 'internal' || !sgOpen) return { kind: 'timeout', host, port };
    const pool = healthyInstances(s, lb, port);
    const ipPool = ipTargets.backends ? ipTargets.backends(s, lb, port) : [];
    if (!pool.length && ipPool.length) { const b = ipPool[rr++ % ipPool.length]; return { kind: 'ok', status: 200, headers: { server: b.server, 'content-type': 'text/html; charset=UTF-8' }, body: b.body }; }
    if (!pool.length) return { kind: 'ok', status: 503, headers: { server: 'awselb/2.0', 'content-type': 'text/html' }, body: '<html>\r\n<head><title>503 Service Temporarily Unavailable</title></head>\r\n<body>\r\n<center><h1>503 Service Temporarily Unavailable</h1></center>\r\n</body>\r\n</html>\r\n' };
    const inst = pool[rr++ % pool.length];
    return { kind: 'ok', status: 200, headers: { server: 'Apache/2.4.62 ()', 'content-type': 'text/html; charset=UTF-8' }, body: `<h1>Hola desde ${hostnameOf(inst)}</h1>\n` };
  }
  const inst = s.instances.find((i) => i.publicIp === ip && i.state !== 'terminated');
  if (!inst) return { kind: 'timeout', host, port };
  if (u[1] === 'https') return { kind: 'ssl', host, port };
  return instanceResponse(s, inst, host, port);
}
