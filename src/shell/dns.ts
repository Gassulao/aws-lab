// `dig` y `nslookup` contra el resolvedor de Route 53 del simulador (zonas públicas y nombres de balanceadores).
import { registerCommand, ok, fail, type CmdResult } from './interp';
import { resolve } from '../engine/services/route53';
import { now } from '../engine/util';

const TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'PTR', 'SOA', 'SRV', 'TXT', 'ANY'];
const pad = (n: number) => String(n).padStart(2, '0');
const when = () => { const d = new Date(now()); return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC ${d.getUTCFullYear()}`; };
const fq = (n: string) => (n.endsWith('.') ? n : n + '.');
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

registerCommand('dig', (args, { sh }): CmdResult => {
  let short = false, type = 'A', name = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '+short') short = true;
    else if (a === '-t') type = (args[++i] ?? 'A').toUpperCase();
    else if (a.startsWith('@') || a.startsWith('+') || a.startsWith('-')) continue;
    else if (TYPES.includes(a.toUpperCase()) && name) type = a.toUpperCase();
    else if (!name) name = a;
  }
  if (!name) return ok(`\n; <<>> DiG 9.18.28 <<>>\n;; global options: +cmd\n;; Got answer:\n;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1\n;; flags: qr rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1\n`);
  const r = resolve(sh.s, name, type);
  if (short) return ok(r.answers.map((a) => a.data).join('\n') + (r.answers.length ? '\n' : ''));
  const id = hash(name + type) % 65536;
  const ans = r.answers.map((a) => `${fq(a.name)}\t${a.ttl}\tIN\t${a.type}\t${a.data}`);
  const soa = r.zone?.records.find((x) => x.type === 'SOA');
  const auth = !r.answers.length && soa ? [`${r.zone!.name}\t${soa.ttl}\tIN\tSOA\t${soa.values[0]}`] : [];
  const flags = 'qr rd ra';
  const out = [
    '', `; <<>> DiG 9.18.28 <<>> ${args.join(' ')}`, ';; global options: +cmd', ';; Got answer:', `;; ->>HEADER<<- opcode: QUERY, status: ${r.rcode}, id: ${id}`,
    `;; flags: ${flags}; QUERY: 1, ANSWER: ${ans.length}, AUTHORITY: ${auth.length}, ADDITIONAL: 1`, '', ';; OPT PSEUDOSECTION:', '; EDNS: version: 0, flags:; udp: 65494', ';; QUESTION SECTION:', `;${fq(name)}\t\t\tIN\t${type}`, '',
    ...(ans.length ? [';; ANSWER SECTION:', ...ans, ''] : []), ...(auth.length ? [';; AUTHORITY SECTION:', ...auth, ''] : []),
    `;; Query time: ${5 + (id % 40)} msec`, ';; SERVER: 127.0.0.53#53(127.0.0.53) (UDP)', `;; WHEN: ${when()}`, `;; MSG SIZE  rcvd: ${60 + ans.join('').length}`, '', '',
  ];
  return ok(out.join('\n'));
});

registerCommand('nslookup', (args, { sh }): CmdResult => {
  let type = 'A';
  const pos: string[] = [];
  for (const a of args) { const m = /^-(?:type|query)=(\w+)$/i.exec(a); if (m) type = m[1].toUpperCase(); else if (!a.startsWith('-')) pos.push(a); }
  const name = pos[0];
  if (!name) return fail('nslookup: interactive mode is not supported in this simulator');
  const head = 'Server:\t\t127.0.0.53\nAddress:\t127.0.0.53#53\n\n';
  const r = resolve(sh.s, name, type);
  if (r.rcode === 'NXDOMAIN' || (!r.answers.length && r.rcode === 'NOERROR' && !r.zone)) return { out: head, err: `** server can't find ${name}: NXDOMAIN\n\n`, code: 1 };
  if (!r.answers.length) return ok(`${head}Non-authoritative answer:\n\n`);
  const lines: string[] = [];
  for (const a of r.answers) {
    if (a.type === 'CNAME') lines.push(`${a.name.replace(/\.$/, '')}\tcanonical name = ${fq(a.data)}`);
    else if (a.type === 'A' || a.type === 'AAAA') lines.push(`Name:\t${a.name.replace(/\.$/, '')}\nAddress: ${a.data}`);
    else if (a.type === 'NS') lines.push(`${a.name.replace(/\.$/, '')}\tnameserver = ${a.data}`);
    else if (a.type === 'MX') lines.push(`${a.name.replace(/\.$/, '')}\tmail exchanger = ${a.data}`);
    else if (a.type === 'TXT') lines.push(`${a.name.replace(/\.$/, '')}\ttext = ${a.data}`);
    else lines.push(`${a.name.replace(/\.$/, '')}\t${a.type.toLowerCase()} = ${a.data}`);
  }
  return ok(`${head}Non-authoritative answer:\n${lines.join('\n')}\n\n`);
});
