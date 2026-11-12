// Marco del CLI `aws`: análisis de argumentos (--opciones, sintaxis abreviada, JSON, file://), resolución de
// credenciales y perfiles, formatos de salida (json, text, table, yaml) y --query (JMESPath).
import jmespath from 'jmespath';
import yaml from 'js-yaml';
import type { CloudState } from '../../engine/types';
import { AwsError, cliErrorText } from '../../engine/errors';
import { resolveCaller, type Ctx } from '../../engine/api';
import * as iam from '../../engine/services/iam';
import { REGIONS, isRegion } from '../../engine/catalog';
import type { Shell, CmdResult } from '../interp';
import { ok, fail } from '../interp';
import { VFS } from '../fs';

export type Params = Record<string, any>;

export interface AwsCommand {
  /** Servicio y comando en la forma del CLI: "ec2", "describe-vpcs". */
  service: string;
  name: string;
  /** Nombre de la operación de la API, para los mensajes de error. */
  op: string;
  run(ctx: Ctx, p: Params, sh: Shell, positional: string[]): any;
  /** Opciones que son listas de valores (--vpc-ids a b c). */
  list?: string[];
  /** Opciones que son banderas booleanas sin valor (--no-paginate). */
  bool?: string[];
  /** Opciones cuyo valor es JSON o sintaxis abreviada. */
  structured?: string[];
  /** La salida ya es texto final (aws s3 ...), sin formato ni --query. */
  raw?: boolean;
}

const commands = new Map<string, AwsCommand>();
export function defineCommand(c: AwsCommand) {
  commands.set(`${c.service} ${c.name}`, c);
}
export function listCommands(service?: string): AwsCommand[] {
  return [...commands.values()].filter((c) => !service || c.service === service);
}
export function services(): string[] {
  return [...new Set([...commands.values()].map((c) => c.service))].sort();
}

const pascal = (s: string) => s.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('');

export interface Parsed {
  params: Params;
  global: { region?: string; profile?: string; output?: string; query?: string; noPaginate?: boolean; endpointUrl?: string; debug?: boolean };
  positional: string[];
}

/** Sintaxis abreviada: Key=a,Value=b  |  Name=x,Values=y,z  (lista de estructuras separadas por espacios). */
export function parseShorthand(s: string): any {
  const [obj] = parsePairs(s, 0, '');
  return obj;
}

const KEY_AHEAD = /^,(?=[A-Za-z][A-Za-z0-9_.:-]*=)/;

/** Pares Clave=Valor hasta `end` (o el final). Los valores pueden ser cadenas, listas [..] o estructuras {..}. */
function parsePairs(s: string, start: number, end: string): [Record<string, any>, number] {
  const obj: Record<string, any> = {};
  let i = start;
  while (i < s.length && s[i] !== end) {
    const eq = s.indexOf('=', i);
    if (eq < 0) throw new Error(`Error parsing parameter: Expected: '=', received: 'EOF' for input:\n${s}`);
    const key = s.slice(i, eq);
    const [val, j] = parseValue(s, eq + 1, end);
    obj[key] = val;
    i = j;
    if (s[i] === ',') i++;
  }
  return [obj, i];
}

function parseValue(s: string, i: number, end: string): [any, number] {
  const c = s[i];
  if (c === '"' || c === "'") {
    const e = s.indexOf(c, i + 1);
    return [s.slice(i + 1, e), e + 1];
  }
  if (c === '{') {
    const [o, j] = parsePairs(s, i + 1, '}');
    return [o, j + 1];
  }
  if (c === '[') {
    const items: any[] = [];
    let j = i + 1;
    while (j < s.length && s[j] !== ']') {
      if (s[j] === ',') { j++; continue; }
      if (s[j] === '{' || s[j] === '[' || s[j] === '"' || s[j] === "'") {
        const [v, k] = parseValue(s, j, ']');
        items.push(v);
        j = k;
      } else {
        let k = j;
        while (k < s.length && s[k] !== ',' && s[k] !== ']') k++;
        items.push(s.slice(j, k));
        j = k;
      }
    }
    return [items, j + 1];
  }
  // Valor sin comillas: hasta la coma que precede a otra "Clave=" o hasta el cierre del contenedor.
  let j = i;
  while (j < s.length) {
    if (end && s[j] === end) break;
    if (s[j] === ',' && KEY_AHEAD.test(s.slice(j))) break;
    j++;
  }
  const raw = s.slice(i, j);
  return [raw.includes(',') ? raw.split(',') : raw, j];
}

/** Marca que antepone readValue a los datos leídos con fileb:// (bytes sin interpretar). */
export const BIN = '\u0000fileb\u0000';

function readValue(raw: string, sh: Shell): any {
  if (raw.startsWith('fileb://')) {
    const path = VFS.norm(raw.slice(8), sh.cwd);
    try {
      return BIN + sh.fs.readFile(path);
    } catch {
      throw new Error(`Error parsing parameter: Unable to load paramfile ${raw}: [Errno 2] No such file or directory: '${raw.slice(8)}'`);
    }
  }
  if (raw.startsWith('file://')) {
    const path = VFS.norm(raw.slice(7), sh.cwd);
    try {
      return sh.fs.readFile(path);
    } catch {
      throw new Error(`Error parsing parameter: Unable to load paramfile ${raw}: [Errno 2] No such file or directory: '${raw.slice(7)}'`);
    }
  }
  return raw;
}

function coerce(v: string): any {
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

export function parseArgs(cmd: AwsCommand, args: string[], sh: Shell): Parsed {
  const params: Params = {};
  const global: Parsed['global'] = {};
  const positional: string[] = [];
  const list = new Set(cmd.list ?? []);
  const boolOpts = new Set(cmd.bool ?? []);
  const structured = new Set(cmd.structured ?? []);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const raw = a.slice(2);
    const eq = raw.indexOf('=');
    const name = eq >= 0 ? raw.slice(0, eq) : raw;
    const inline = eq >= 0 ? raw.slice(eq + 1) : undefined;
    const take = (): string => {
      if (inline !== undefined) return inline;
      const v = args[++i];
      if (v === undefined) throw new Error(`argument --${name}: expected one argument`);
      return v;
    };
    switch (name) {
      case 'region': global.region = take(); continue;
      case 'profile': global.profile = take(); continue;
      case 'output': global.output = take(); continue;
      case 'query': global.query = take(); continue;
      case 'endpoint-url': global.endpointUrl = take(); continue;
      case 'no-paginate': case 'no-cli-pager': case 'no-sign-request': case 'no-verify-ssl': continue;
      case 'debug': global.debug = true; continue;
      case 'cli-input-json': {
        const doc = readValue(take(), sh);
        let obj: Record<string, unknown>;
        try { obj = JSON.parse(String(doc).replace(BIN, '')); } catch (e) { throw new Error(`Error parsing parameter '--cli-input-json': Invalid JSON: ${(e as Error).message}`); }
        for (const [k, v] of Object.entries(obj)) params[k[0].toUpperCase() + k.slice(1)] ??= v;
        continue;
      }
      case 'cli-input-yaml': continue;
    }
    const key = pascal(name);
    if (boolOpts.has(name)) {
      params[key] = true;
      continue;
    }
    if (name.startsWith('no-') && boolOpts.has(name.slice(3))) {
      params[pascal(name.slice(3))] = false;
      continue;
    }
    if (list.has(name)) {
      const vals: string[] = [];
      if (inline !== undefined) vals.push(inline);
      while (i + 1 < args.length && !args[i + 1].startsWith('--')) vals.push(args[++i]);
      if (!vals.length) throw new Error(`argument --${name}: expected at least one argument`);
      params[key] = vals.map((v) => (structured.has(name) ? parseStructured(readValue(v, sh)) : readValue(v, sh)));
      continue;
    }
    const val = readValue(take(), sh);
    params[key] = structured.has(name) ? parseStructured(val) : val;
  }
  return { params, global, positional };
}

function parseStructured(v: string): any {
  const t = v.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(t);
    } catch (e) {
      throw new Error(`Error parsing parameter: Invalid JSON: ${(e as Error).message}\nJSON received: ${v}`);
    }
  }
  return parseShorthand(t);
}

// ------------------------------------------------------------------ credenciales

export interface Resolved {
  accessKeyId?: string;
  secret?: string;
  token?: string;
  region: string;
  output: string;
  mfa: boolean;
}

export function resolveSettings(s: CloudState, g: Parsed['global'], env: Record<string, string>): Resolved {
  const profName = g.profile ?? env.AWS_PROFILE ?? s.cli.activeProfile;
  const prof = s.cli.profiles[profName];
  if (g.profile && !prof) throw new AwsError('ProfileNotFound', `The config profile (${g.profile}) could not be found`);
  const region = g.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? prof?.region ?? '';
  const output = g.output ?? env.AWS_DEFAULT_OUTPUT ?? prof?.output ?? 'json';
  return { accessKeyId: env.AWS_ACCESS_KEY_ID ?? prof?.accessKeyId, secret: env.AWS_SECRET_ACCESS_KEY ?? prof?.secret, token: env.AWS_SESSION_TOKEN ?? prof?.token, region, output, mfa: false };
}

// ------------------------------------------------------------------ salida

function tableOf(data: any): string {
  const rows = Array.isArray(data) ? data : [data];
  if (!rows.length) return '';
  if (rows.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => typeof r[k] !== 'object' || r[k] === null)))];
    if (!cols.length) return '';
    const cells = rows.map((r) => cols.map((c) => String(r[c] ?? '')));
    const w = cols.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i].length)));
    const sep = '+' + w.map((x) => '-'.repeat(x + 2)).join('+') + '+';
    const fmt = (r: string[]) => '|' + r.map((x, i) => ' ' + x.padEnd(w[i]) + ' ').join('|') + '|';
    return [sep, fmt(cols), sep, ...cells.map(fmt), sep].join('\n') + '\n';
  }
  return rows.map((r) => String(r)).join('\n') + '\n';
}

function textOf(data: any): string {
  const flat = (v: any): string => (Array.isArray(v) ? v.map(flat).join('\t') : v && typeof v === 'object' ? Object.values(v).map(flat).join('\t') : v === null || v === undefined ? 'None' : String(v));
  if (Array.isArray(data)) return data.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? Object.values(r).map(flat).join('\t') : flat(r))).join('\n') + (data.length ? '\n' : '');
  if (data && typeof data === 'object') {
    return Object.entries(data)
      .map(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k.toUpperCase()}\t${flat(x)}`).join('\n') : `${k.toUpperCase()}\t${flat(v)}`))
      .join('\n') + '\n';
  }
  return data === null || data === undefined ? '' : String(data) + '\n';
}

export function render(data: any, output: string, query?: string): string {
  let d = data;
  if (query) {
    try {
      d = jmespath.search(data ?? {}, query);
    } catch (e) {
      throw new Error(`\nbad jmespath expression: ${(e as Error).message}\n${query}`);
    }
  }
  if (d === undefined || d === null) return output === 'json' ? (query ? 'null\n' : '') : output === 'text' ? '' : '';
  switch (output) {
    case 'text': return textOf(d);
    case 'table': return tableOf(d);
    case 'yaml': return yaml.dump(d);
    case 'yaml-stream': return yaml.dump(d);
    default: return JSON.stringify(d, null, 4) + '\n';
  }
}

// ------------------------------------------------------------------ ejecución

export function buildCtx(sh: Shell, g: Parsed['global'], needRegion = true): { ctx: Ctx; settings: Resolved } {
  const settings = resolveSettings(sh.s, g, { ...sh.s.cli.env, ...sh.vars });
  if (needRegion && !settings.region) throw new Error('You must specify a region. You can also configure your region by running "aws configure".');
  if (settings.region && !isRegion(settings.region) && !/^[a-z]{2}-[a-z]+-\d$/.test(settings.region)) {
    throw new Error(`Provided region_name '${settings.region}' doesn't match a supported format.`);
  }
  const caller = resolveCaller(sh.s, settings.accessKeyId, settings.token);
  return { ctx: { s: sh.s, caller, region: settings.region || 'us-east-1' }, settings };
}

export async function runAws(sh: Shell, args: string[]): Promise<CmdResult> {
  if (!args.length || args[0] === 'help' || args[0] === '--help') {
    return fail(`usage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\nTo see help text, you can run:\n\n  aws help\n  aws <command> help\n  aws <command> <subcommand> help\n\naws: error: the following arguments are required: command`, 252);
  }
  if (args[0] === '--version') return ok('aws-cli/2.17.0 Python/3.11.8 Linux/6.1.0 exe/x86_64.amzn.2023 prompt/off\n');
  const [service, name, ...rest] = args;
  if (service === 'configure') return configureCmd(sh, [name, ...rest].filter((x) => x !== undefined));
  const known = services();
  if (!known.includes(service)) {
    return fail(`\naws: [ERROR]: argument command: Invalid choice, valid choices are:\n\n${known.map((k) => '* ' + k).join('\n')}\n\n\nTo see help text, you can run:\n\n  aws help\n  aws <command> help\n  aws <command> <subcommand> help`, 252);
  }
  if (!name || name === 'help') {
    return ok(`${service.toUpperCase()}\n\nAVAILABLE COMMANDS\n\n${listCommands(service).map((c) => '       o ' + c.name).join('\n')}\n`);
  }
  const cmd = commands.get(`${service} ${name}`);
  if (!cmd) {
    return fail(`\naws: [ERROR]: argument operation: Found invalid choice '${name}'\n\nusage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]`, 252);
  }
  let parsed: Parsed;
  try {
    parsed = parseArgs(cmd, rest, sh);
  } catch (e) {
    return fail(`\n${(e as Error).message}`, 252);
  }
  try {
    const { ctx, settings } = buildCtx(sh, parsed.global, service !== 'sts' && service !== 'iam' ? true : false);
    const out = cmd.run(ctx, parsed.params, sh, parsed.positional);
    const result = out instanceof Promise ? await out : out;
    if (result === undefined) return ok('');
    if (cmd.raw) return typeof result === 'string' ? ok(result) : ok('');
    return ok(render(result, settings.output, parsed.global.query));
  } catch (e) {
    if (e instanceof AwsError) return fail(`\n${cliErrorText(e, cmd.op)}`, 254);
    return fail(`\n${(e as Error).message}`, 255);
  }
}

// ------------------------------------------------------------------ aws configure

function configureCmd(sh: Shell, args: string[]): CmdResult {
  const [sub, ...rest] = args;
  const s = sh.s;
  if (sub === 'list') {
    const g = resolveSettings(s, {}, { ...s.cli.env, ...sh.vars });
    const mask = (v?: string) => (v ? '****************' + v.slice(-4) : '<not set>');
    const row = (n: string, v: string, ty: string, loc: string) => `${n.padStart(10)} ${v.padStart(24)} ${ty.padStart(24)}    ${loc}\n`;
    const prof = s.cli.activeProfile === 'default' ? '<not set>' : s.cli.activeProfile;
    return ok(
      row('Name', 'Value', 'Type', 'Location') +
        row('----', '-----', '----', '--------') +
        row('profile', prof, 'None', 'None') +
        row('access_key', mask(g.accessKeyId), 'shared-credentials-file', '') +
        row('secret_key', mask(g.secret), 'shared-credentials-file', '') +
        row('region', g.region || '<not set>', 'config-file', '~/.aws/config'),
    );
  }
  if (sub === 'get') {
    const p = s.cli.profiles[s.cli.activeProfile];
    const v = rest[0] === 'region' ? p?.region : rest[0] === 'output' ? p?.output : undefined;
    return v ? ok(v + '\n') : { out: '', err: '', code: 1 };
  }
  if (sub === 'set') {
    const [k, v] = rest;
    const profName = rest.includes('--profile') ? rest[rest.indexOf('--profile') + 1] : s.cli.activeProfile;
    const p = (s.cli.profiles[profName] ??= {});
    if (k === 'region') p.region = v;
    else if (k === 'output') p.output = v;
    else if (k === 'aws_access_key_id') p.accessKeyId = v;
    else if (k === 'aws_secret_access_key') p.secret = v;
    else if (k === 'aws_session_token') p.token = v;
    else return fail(`configure set: unsupported key ${k}`);
    return ok();
  }
  if (sub === 'list-profiles') return ok(Object.keys(s.cli.profiles).join('\n') + '\n');
  return fail('aws configure: interactive mode is not supported here; use `aws configure set <key> <value>`.');
}

export { REGIONS, iam };
