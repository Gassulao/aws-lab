// Comando `terraform` del simulador: init, validate, fmt, plan, apply, destroy, output, show, state, version.
import { registerCommand, ok, fail, type Shell, type CmdResult } from '../interp';
import { VFS } from '../fs';
import { UNKNOWN } from './hcl';
import { bold, boldGreen, boldRed, boldYellow, cyan, dim, fmtPlain, fmtValue, green, isMap, jsonOf, red, renderDiag, setColor, yellow, type Diag } from './render';
import { AWS_PROVIDER_VERSION, TF_VERSION, TfFailure, addrOf, applyPlan, apiErrorText, buildPlan, computeOutputs, emptyState, listTf, loadConfig, loadState, makeEnv, removeInstance, resolveVars, saveState, stateInstances, validateConfig, type Action, type Config, type Drift, type Plan, type State } from './core';
import { TfApiError, typeOf, type Attrs } from './resources';

interface Opts { flags: Set<string>; vars: Record<string, string>; varFiles: string[]; pos: string[]; out?: string }

function parseOpts(args: string[]): Opts {
  const o: Opts = { flags: new Set(), vars: {}, varFiles: [], pos: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-') || a === '-') { o.pos.push(a); continue; }
    const name = a.replace(/^--?/, '');
    const [k, ...rest] = name.split('=');
    const inline = rest.length ? rest.join('=') : undefined;
    if (k === 'var' || k === 'var-file' || k === 'out') {
      const val = inline ?? args[++i] ?? '';
      if (k === 'var') { const j = val.indexOf('='); if (j > 0) o.vars[val.slice(0, j)] = val.slice(j + 1); } else if (k === 'var-file') o.varFiles.push(val); else o.out = val;
    } else o.flags.add(inline !== undefined && inline !== 'true' ? `${k}=${inline}` : k);
  }
  return o;
}

const NOCFG = (verb: string) => `${errBox({ severity: 'error', summary: 'No configuration files', detail: `${verb} requires configuration to be present. Applying without a configuration would mark everything for destruction, which is normally not what is desired. If you would like to destroy everything, run 'terraform destroy' instead.` })}`;
const errBox = (d: Diag, cfg?: Config) => renderDiag(d, (f) => cfg?.files[f]);
const initialized = (sh: Shell) => sh.fs.isDir(VFS.norm('.terraform', sh.cwd));
const NOINIT = () => errBox({ severity: 'error', summary: 'Required plugins are not installed', detail: `The installed provider plugins are not consistent with the packages selected in the dependency lock file:\n  - registry.terraform.io/hashicorp/aws: there is no package for registry.terraform.io/hashicorp/aws ${AWS_PROVIDER_VERSION} cached in .terraform/providers\n\nTerraform uses external plugins to integrate with a variety of different infrastructure services. To download the plugins required for this configuration, run:\n  terraform init` });

const render = (diags: Diag[], cfg?: Config) => diags.map((d) => errBox(d, cfg)).join('');

// ------------------------------------------------------------------ plan: texto

const SYM = {
  get create() { return green('+'); },
  get update() { return yellow('~'); },
  get destroy() { return red('-'); },
  get replace() { return red('-/+'); },
};
const symFor = (k: Action['kind']) => SYM[k];
const hasUnknown = (v: any): boolean => v === UNKNOWN || (Array.isArray(v) ? v.some(hasUnknown) : isMap(v) ? Object.values(v).some(hasUnknown) : false);

const kv = (k: string, v: any, ind: string, sym: string, w: number, extra = '') => `${ind}${sym} ${k.padEnd(w)} = ${fmtValue(v, ind + '  ', plainSym(sym))}${extra}`;
const plainSym = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

function listForm(key: string, blocks: Record<string, unknown>): boolean {
  return ['ingress', 'egress', 'route'].includes(key) || !(key in blocks);
}

/** Cuerpo de un recurso nuevo o destruido (todas las claves con el mismo símbolo). */
function bodyLines(a: Attrs, blocks: Record<string, unknown>, ind: string, sym: string, ps: string): string[] {
  const keys = Object.keys(a).filter((k) => a[k] !== undefined && a[k] !== null && !(Array.isArray(a[k]) && !a[k].length && k !== 'tags')).sort();
  const attrKeys = keys.filter((k) => !(Array.isArray(a[k]) && a[k].length && isMap(a[k][0]) && !listForm(k, blocks)));
  const blockKeys = keys.filter((k) => !attrKeys.includes(k));
  const w = Math.max(0, ...attrKeys.map((k) => k.length));
  const lines = attrKeys.map((k) => `${ind}${sym} ${k.padEnd(w)} = ${fmtValue(a[k], ind + '  ', ps)}`);
  for (const k of blockKeys) for (const item of a[k]) {
    lines.push('', `${ind}${sym} ${k} {`, ...bodyLines(item, {}, ind + '    ', sym, ps), `${ind}  }`);
  }
  return lines;
}

function renderAction(a: Action): string {
  const rt = typeOf(a.type);
  const blocks = rt?.blocks ?? {};
  const head = (txt: string) => `  ${bold(`# ${a.addr} ${txt}`)}`;
  const ind = '      ';
  const open = (s: string) => `  ${s} resource "${a.type}" "${a.name}" {`;
  if (a.kind === 'create') return [head('will be created'), open(SYM.create), ...bodyLines(a.after!, blocks, ind, SYM.create, '+'), '    }'].join('\n');
  if (a.kind === 'destroy') return [head('will be destroyed'), `  ${dim('# (because ' + (a.res ? 'index is out of range for count' : a.type + '.' + a.name + ' is not in configuration') + ')')}`.replace(/.*/, a.res ? '' : `  # (because ${a.addr} is not in configuration)`), open(SYM.destroy), ...bodyLines(a.before!, blocks, ind, SYM.destroy, '-'), '    }'].filter((x, i) => !(i === 1 && x === '')).join('\n');
  // update / replace
  const before = a.before!, after = a.after!;
  const all = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter((k) => k !== 'tags_all' || a.changed.includes('tags'));
  const lines: string[] = [];
  let hidden = 0;
  const w = Math.max(...all.map((k) => k.length));
  for (const k of all) {
    const b = before[k], n = after[k];
    const isCh = a.changed.includes(k) || (a.kind === 'replace' && n === UNKNOWN && b !== UNKNOWN);
    if (!isCh) { if (k === 'id' || k === 'name') lines.push(`${ind}  ${k.padEnd(w)} = ${fmtValue(b, ind + '    ', '')}`); else if (b !== undefined && b !== null) hidden++; continue; }
    const force = a.replaceKeys.includes(k) ? red('# forces replacement') : '';
    const mark = n === UNKNOWN ? SYM.update : SYM.update;
    if (isMap(b) && isMap(n) && n !== UNKNOWN) { lines.push(`${ind}${mark} ${k.padEnd(w)} = {`, ...mapDiff(b, n, ind + '    '), `${ind}  }`); continue; }
    if (Array.isArray(n) && Array.isArray(b) && (n.some(isMap) || b.some(isMap))) { lines.push(`${ind}${mark} ${k.padEnd(w)} = [`, ...listDiff(b, n, ind + '    '), `${ind}  ]`); continue; }
    const bs = b === undefined || b === null ? 'null' : fmtValue(b, ind + '  ', '');
    const ns = n === undefined || n === null ? 'null' : fmtValue(n, ind + '  ', '');
    lines.push(`${ind}${mark} ${k.padEnd(w)} = ${bs} -> ${ns}${force ? ' ' + force : ''}`);
  }
  if (hidden) lines.push(`${ind}  ${dim(`# (${hidden} unchanged attribute${hidden > 1 ? 's' : ''} hidden)`)}`);
  const hdr = a.kind === 'replace' ? `${SYM.replace} resource "${a.type}" "${a.name}" {` : `  ${SYM.update} resource "${a.type}" "${a.name}" {`;
  return [head(a.kind === 'replace' ? 'must be replaced' : 'will be updated in-place'), hdr, ...lines, '    }'].join('\n');
}

function mapDiff(b: Attrs, n: Attrs, ind: string): string[] {
  const keys = [...new Set([...Object.keys(b), ...Object.keys(n)])].sort();
  const w = Math.max(...keys.map((k) => JSON.stringify(k).length));
  const out: string[] = [];
  let hid = 0;
  for (const k of keys) {
    const q = JSON.stringify(k).padEnd(w);
    if (!(k in b)) out.push(`${ind}${SYM.create} ${q} = ${fmtValue(n[k], ind + '  ', '+')}`);
    else if (!(k in n)) out.push(`${ind}${SYM.destroy} ${q} = ${fmtValue(b[k], ind + '  ', '-')}`);
    else if (JSON.stringify(b[k]) !== JSON.stringify(n[k])) out.push(`${ind}${SYM.update} ${q} = ${fmtValue(b[k], ind + '  ', '')} -> ${fmtValue(n[k], ind + '  ', '')}`);
    else hid++;
  }
  if (hid) out.push(`${ind}  ${dim(`# (${hid} unchanged element${hid > 1 ? 's' : ''} hidden)`)}`);
  return out;
}
function listDiff(b: any[], n: any[], ind: string): string[] {
  const key = (x: any) => JSON.stringify(x, Object.keys(x ?? {}).sort());
  const bk = b.map(key), nk = n.map(key);
  const out: string[] = [];
  for (const x of n) if (!bk.includes(key(x))) out.push(`${ind}${SYM.create} ${fmtValue(x, ind + '  ', '+', true)},`);
  for (const x of b) if (!nk.includes(key(x))) out.push(`${ind}${SYM.destroy} ${fmtValue(x, ind + '  ', '-', true)},`);
  const same = n.filter((x) => bk.includes(key(x))).length;
  if (same) out.push(`${ind}  ${dim(`# (${same} unchanged element${same > 1 ? 's' : ''} hidden)`)}`);
  return out;
}

function renderDrift(d: Drift): string {
  const rt = typeOf(d.type);
  const blocks = rt?.blocks ?? {};
  if (d.kind === 'deleted') return [`  ${bold(`# ${d.addr} has been deleted`)}`, `  ${SYM.destroy} resource "${d.type}" "${d.name}" {`, ...bodyLines(d.before, blocks, '      ', SYM.destroy, '-'), '    }'].join('\n');
  const fake: Action = { addr: d.addr, base: d.addr, res: null, type: d.type, name: d.name, kind: 'update', before: d.before, after: d.after, replaceKeys: [], changed: d.changed, deps: [] };
  return renderAction(fake).replace('will be updated in-place', 'has changed');
}

const RULE = '─'.repeat(77);

export function renderPlan(plan: Plan, verb: 'plan' | 'apply' | 'destroy', saved: boolean): string {
  const out: string[] = [];
  if (plan.drift.length) {
    out.push('', bold('Note: Objects have changed outside of Terraform'), '', 'Terraform detected the following changes made outside of Terraform since the last "terraform apply" which may have affected this plan:', '');
    out.push(plan.drift.map(renderDrift).join('\n\n'), '');
    out.push('', 'Unless you have made equivalent changes to your configuration, or ignored the relevant attributes using ignore_changes, the following plan may include actions to undo or respond to these changes.', '', dim(RULE), '');
  }
  if (!plan.actions.length && !plan.outputs.length) {
    out.push('', bold(boldGreen('No changes.') + ' Your infrastructure matches the configuration.'), '', verb === 'destroy' ? 'Terraform has compared your real infrastructure against your configuration and found no differences, so no changes are needed.' : 'Terraform has compared your real infrastructure against your configuration and found no differences, so no changes are needed.');
    return out.join('\n') + '\n';
  }
  const kinds = new Set(plan.actions.map((a) => a.kind));
  if (plan.actions.length) {
    out.push('Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:');
    if (kinds.has('create')) out.push(`  ${SYM.create} create`);
    if (kinds.has('update')) out.push(`  ${SYM.update} update in-place`);
    if (kinds.has('destroy')) out.push(`  ${SYM.destroy} destroy`);
    if (kinds.has('replace')) out.push(`${SYM.replace} destroy and then create replacement`);
    out.push('', 'Terraform will perform the following actions:', '');
    out.push(plan.actions.map(renderAction).join('\n\n'), '');
    const c = plan.counts;
    out.push(`${bold('Plan:')} ${c.add} to add, ${c.change} to change, ${c.destroy} to destroy.`);
  } else {
    out.push('Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:');
    out.push('', 'Terraform will perform the following actions:', '', `${bold('Plan:')} 0 to add, 0 to change, 0 to destroy.`);
  }
  if (plan.outputs.length) {
    const w = Math.max(...plan.outputs.map((o) => o.name.length));
    out.push('', 'Changes to Outputs:');
    for (const o of plan.outputs) {
      const sym = o.status === 'create' ? SYM.create : o.status === 'destroy' ? SYM.destroy : SYM.update;
      const val = (v: any) => (o.sensitive ? '(sensitive value)' : hasUnknown(v) ? '(known after apply)' : fmtValue(v, '    ', ''));
      out.push(o.status === 'create' ? `  ${sym} ${o.name.padEnd(w)} = ${o.sensitive ? '(sensitive value)' : hasUnknown(o.after) ? '(known after apply)' : fmtValue(o.after, '    ', '+')}` : o.status === 'destroy' ? `  ${sym} ${o.name.padEnd(w)} = ${val(o.before)} ${'->'} null` : `  ${sym} ${o.name.padEnd(w)} = ${val(o.before)} -> ${val(o.after)}`);
    }
  }
  if (verb === 'plan' && !saved) out.push('', dim(RULE), '', `Note: You didn't use the -out option to save this plan, so Terraform can't guarantee to take exactly these actions if you run "terraform apply" now.`);
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------------ preparación común

interface Ready { cfg: Config; vars: Record<string, any>; st: State; env: ReturnType<typeof makeEnv>['env'] }

function prepare(sh: Shell, o: Opts, verb: string): Ready | CmdResult {
  if (!listTf(sh).length) return fail(NOCFG(verb[0].toUpperCase() + verb.slice(1)).trimEnd());
  if (!initialized(sh)) return fail(NOINIT().trimEnd());
  const { cfg, diags } = loadConfig(sh);
  if (diags.length) return fail(render(diags, cfg).trimEnd());
  const sd = validateConfig(cfg);
  if (sd.length) return fail(render(sd, cfg).trimEnd());
  const { values, diags: vd } = resolveVars(sh, cfg, { cli: o.vars, files: o.varFiles });
  if (vd.length) return fail(render(vd, cfg).trimEnd());
  let env;
  try { env = makeEnv(sh, cfg, values).env; } catch (e) { return fail(errBox({ severity: 'error', summary: 'No valid credential sources found', detail: `Please see https://registry.terraform.io/providers/hashicorp/aws\nfor more information about providing credentials.\n\nError: ${(e as Error).message}` }).trimEnd()); }
  const st = loadState(sh) ?? emptyState();
  return { cfg, vars: values, st, env };
}
const isFail = (r: Ready | CmdResult): r is CmdResult => 'code' in r;

function refreshLines(plan: Plan, st: State): string {
  const l: string[] = [];
  for (const si of stateInstances(st)) if (si.res.mode === 'data') l.push(`${bold(si.addr)}: Reading...`, `${bold(si.addr)}: Read complete after 0s${si.inst.attributes.id ? ` [id=${si.inst.attributes.id}]` : ''}`);
  for (const si of stateInstances(st)) if (si.res.mode === 'managed') l.push(`${bold(si.addr)}: Refreshing state...${si.inst.attributes.id ? ` [id=${si.inst.attributes.id}]` : ''}`);
  void plan;
  return l.length ? l.join('\n') + '\n' : '';
}

function runPlan(sh: Shell, o: Opts, destroy: boolean, verb: 'plan' | 'apply' | 'destroy'): CmdResult | { r: Ready; plan: Plan } {
  const r = prepare(sh, o, verb);
  if (isFail(r)) return r;
  try {
    const plan = buildPlan(sh, r.cfg, r.vars, r.env, r.st, { destroy, refresh: !o.flags.has('refresh=false') });
    return { r, plan };
  } catch (e) {
    if (e instanceof TfFailure) return fail(render(e.diags, r.cfg).trimEnd());
    throw e;
  }
}

// ------------------------------------------------------------------ apply

function applyLive(sh: Shell, r: Ready, plan: Plan, destroy: boolean): CmdResult {
  const lines: string[] = [];
  const word = { create: ['Creating...', 'Creation complete'], update: ['Modifying...', 'Modifications complete'], destroy: ['Destroying...', 'Destruction complete'] } as const;
  const res = applyPlan(sh, plan, r.env, {
    start: (a, ph) => {
      const id = ph === 'create' ? '' : ` [id=${a.before?.id ?? ''}]`;
      lines.push(`${bold(a.addr)}: ${word[ph][0]}${id}`);
    },
    done: (a, ph, id, secs) => {
      if (secs >= 10) lines.splice(lines.length, 0, `${bold(a.addr)}: Still ${ph === 'create' ? 'creating' : ph === 'update' ? 'modifying' : 'destroying'}... [${secs >= 20 ? '10s elapsed' : '10s elapsed'}]`);
      lines.push(`${bold(a.addr)}: ${word[ph][1]} after ${secs}s${ph === 'destroy' ? '' : ` [id=${id}]`}`);
    },
  }, destroy);
  const st = plan.state;
  if (destroy) { st.outputs = {}; st.resources = st.resources.filter((x) => x.mode === 'managed'); }
  else if (!res.error) {
    for (const o of computeOutputs(sh, r.cfg, r.vars, st)) st.outputs[o.name] = { value: jsonOf(o.value), type: typeOfValue(o.value), ...(o.sensitive ? { sensitive: true } : {}) };
    for (const n of Object.keys(st.outputs)) if (!(n in r.cfg.outputs)) delete st.outputs[n];
  }
  saveState(sh, st);
  let out = lines.join('\n') + '\n';
  if (res.error) {
    const a = res.error.action, e = res.error.err;
    let d: Diag;
    if (e instanceof TfFailure) d = e.diags[0];
    else {
      const rt = typeOf(a.type);
      const ph = a.kind === 'destroy' ? 'destroy' : a.kind === 'update' ? 'update' : 'create';
      const msg = e instanceof TfApiError ? apiErrorText(e, rt?.noun ?? a.type, ph, ph === 'create' ? (['aws_s3_bucket', 'aws_security_group', 'aws_iam_role', 'aws_iam_user', 'aws_iam_policy', 'aws_instance_profile'].includes(a.type) ? (a.after?.bucket ?? a.after?.name) : undefined) : a.before?.id) : (e as Error).message;
      d = { severity: 'error', summary: msg, detail: '', file: a.res?.file, line: a.res?.line, context: a.res ? `resource "${a.type}" "${a.name}"` : undefined, address: a.addr };
    }
    return { out, err: '\n' + errBox(d, r.cfg), code: 1 };
  }
  if (destroy) out += `\n${boldGreen('Destroy complete!')} Resources: ${res.destroyed} destroyed.\n`;
  else {
    out += `\n${boldGreen('Apply complete!')} Resources: ${res.added} added, ${res.changed} changed, ${res.destroyed} destroyed.\n`;
    const outs = Object.entries(st.outputs);
    if (outs.length) {
      const w = Math.max(...outs.map(([k]) => k.length));
      out += `\n${bold('Outputs:')}\n\n${outs.map(([k, v]) => `${k.padEnd(w)} = ${v.sensitive ? '<sensitive>' : fmtPlain(v.value)}`).join('\n')}\n`;
    }
  }
  return ok(out);
}

function typeOfValue(v: any): any {
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'bool';
  if (Array.isArray(v)) return ['tuple', v.map(typeOfValue)];
  if (isMap(v)) return ['object', Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeOfValue(x)]))];
  return 'dynamic';
}

// ------------------------------------------------------------------ show / state

function stateBlock(r: { mode: string; type: string; name: string }, addr: string, a: Attrs): string {
  const keys = Object.keys(a).filter((k) => a[k] !== undefined && a[k] !== null).sort();
  const blocks = typeOf(r.type)?.blocks ?? {};
  const scalarKeys = keys.filter((k) => !(Array.isArray(a[k]) && a[k].length && isMap(a[k][0]) && !listForm(k, blocks)));
  const w = Math.max(0, ...scalarKeys.map((k) => k.length));
  const lines = scalarKeys.map((k) => `    ${k.padEnd(w)} = ${fmtValue(a[k], '    ', '')}`);
  for (const k of keys.filter((x) => !scalarKeys.includes(x))) for (const item of a[k]) lines.push(`    ${k} {`, ...Object.keys(item).sort().filter((x) => item[x] !== undefined && item[x] !== null).map((x) => `        ${x} = ${fmtValue(item[x], '        ', '')}`), '    }');
  return `# ${addr}:\n${r.mode === 'data' ? 'data' : 'resource'} "${r.type}" "${r.name}" {\n${lines.join('\n')}\n}`;
}

function cmdOutput(sh: Shell, o: Opts): CmdResult {
  const st = loadState(sh);
  const outs = st?.outputs ?? {};
  const name = o.pos[0];
  if (name) {
    const x = outs[name];
    if (!x) return fail(errBox({ severity: 'error', summary: 'Output not found', detail: `The output variable requested could not be found in the state file. If you recently added this to your configuration, be sure to run \`terraform apply\`, since the state won't be updated with new output variables until that command is run.` }).trimEnd());
    if (o.flags.has('json')) return ok(JSON.stringify(x.value, null, 2) + '\n');
    if (o.flags.has('raw')) return typeof x.value === 'object' ? fail(errBox({ severity: 'error', summary: 'Unsupported value for raw output', detail: `The -raw option only supports strings, numbers, and boolean values, but output value "${name}" is ${Array.isArray(x.value) ? 'tuple' : 'object'}.\n\nUse the -json option for machine-readable representations of output values that have complex types.` }).trimEnd()) : ok(String(x.value));
    return ok(x.sensitive ? '<sensitive>\n' : fmtPlain(x.value) + '\n');
  }
  if (!Object.keys(outs).length) return { out: '', err: errBox({ severity: 'warning', summary: 'No outputs found', detail: `The state file either has no outputs defined, or all the defined outputs are empty. Please define an output in your configuration with the \`output\` keyword and run \`terraform refresh\` for it to become available. If you are using interpolation, please verify the interpolated value is not empty. You can use the \`terraform console\` command to assist.` }), code: 0 };
  if (o.flags.has('json')) return ok(JSON.stringify(Object.fromEntries(Object.entries(outs).map(([k, v]) => [k, { sensitive: !!v.sensitive, type: v.type, value: v.value }])), null, 2) + '\n');
  const w = Math.max(...Object.keys(outs).map((k) => k.length));
  return ok(Object.entries(outs).map(([k, v]) => `${k.padEnd(w)} = ${v.sensitive ? '<sensitive>' : fmtPlain(v.value)}`).join('\n') + '\n');
}

function cmdState(sh: Shell, o: Opts): CmdResult {
  const [sub, ...rest] = o.pos;
  const st = loadState(sh);
  if (!sub) return fail('Usage: terraform [global options] state <subcommand> [options] [args]\n\n  This command has subcommands for advanced state management.\n\nSubcommands:\n    list    List resources in the state\n    mv      Move an item in the state\n    rm      Remove instances from the state\n    show    Show a resource in the state');
  if (!st || !st.resources.length) {
    if (sub === 'list') return fail(errBox({ severity: 'error', summary: 'No state file was found!', detail: `State management commands require a state file. Run this command in a directory where Terraform has been run or use the -state flag to point the command to a specific state location.` }).trimEnd());
  }
  const insts = st ? stateInstances(st) : [];
  if (sub === 'list') {
    const f = rest[0];
    const l = insts.filter((i) => !f || i.addr === f || i.base === f || i.addr.startsWith(f + '.')).map((i) => i.addr);
    if (f && !l.length) return fail(`No matching objects found.`);
    return ok(l.length ? l.join('\n') + '\n' : '');
  }
  if (sub === 'show') {
    const a = rest[0];
    if (!a) return fail('Exactly one argument expected.\n');
    const i = insts.find((x) => x.addr === a);
    if (!i) return fail(`No instance found for the given address!\n\nThis command requires that the address references one specific instance.\nTo view the available instances, use "terraform state list". Please modify\nthe address to reference a specific instance.`);
    return ok(stateBlock(i.res, i.addr, i.inst.attributes) + '\n');
  }
  if (sub === 'rm') {
    if (!rest.length || !st) return fail('At least one address is required.\n');
    let n = 0;
    const lines: string[] = [];
    for (const a of rest) for (const i of insts.filter((x) => x.addr === a || x.base === a)) { removeInstance(st, i.res.mode, i.res.type, i.res.name, i.inst.index_key); lines.push(`Removed ${i.addr}`); n++; }
    if (!n) return fail(`No matching objects found.`);
    saveState(sh, st);
    return ok(lines.join('\n') + `\nSuccessfully removed ${n} resource instance(s).\n`);
  }
  return fail(`Unknown subcommand "${sub}". Run "terraform state -help" for usage.`);
}

function cmdShow(sh: Shell): CmdResult {
  const st = loadState(sh);
  if (!st || !st.resources.length) return ok('The state file is empty. No resources are represented.\n');
  const blocks = stateInstances(st).map((i) => stateBlock(i.res, i.addr, i.inst.attributes));
  let out = blocks.join('\n\n') + '\n';
  const outs = Object.entries(st.outputs);
  if (outs.length) { const w = Math.max(...outs.map(([k]) => k.length)); out += `\n\nOutputs:\n\n${outs.map(([k, v]) => `${k.padEnd(w)} = ${v.sensitive ? '(sensitive value)' : fmtPlain(v.value)}`).join('\n')}\n`; }
  return ok(out);
}

// ------------------------------------------------------------------ init / validate / fmt

function cmdInit(sh: Shell): CmdResult {
  if (!listTf(sh).length) return fail(errBox({ severity: 'error', summary: 'No configuration files', detail: `Terraform initialized in an empty directory!\n\nThe directory has no Terraform configuration files. You may begin working\nwith Terraform immediately by creating Terraform configuration files.` }).trimEnd());
  const { cfg, diags } = loadConfig(sh);
  if (diags.length) return fail(render(diags, cfg).trimEnd());
  const lockPath = VFS.norm('.terraform.lock.hcl', sh.cwd);
  const had = sh.fs.isFile(lockPath);
  const find = cfg.providerConstraint ? `- Finding hashicorp/aws versions matching "${cfg.providerConstraint}"...` : '- Finding latest version of hashicorp/aws...';
  sh.fs.mkdir(VFS.norm('.terraform/providers', sh.cwd), true);
  sh.fs.writeFile(VFS.norm('.terraform/terraform.tfstate', sh.cwd), '{}\n');
  if (!had) sh.fs.writeFile(lockPath, `# This file is maintained automatically by "terraform init".\n# Manual edits may be lost in future updates.\n\nprovider "registry.terraform.io/hashicorp/aws" {\n  version     = "${AWS_PROVIDER_VERSION}"\n${cfg.providerConstraint ? `  constraints = "${cfg.providerConstraint}"\n` : ''}  hashes = [\n    "h1:Zk3dF9mQe8bq0Nn1m0m3o6yq4e3k0v5z2o8xVwFtB1A=",\n  ]\n}\n`);
  let out = `\nInitializing the backend...\n\nInitializing provider plugins...\n`;
  out += had ? `- Reusing previous version of hashicorp/aws from the dependency lock file\n- Using previously-installed hashicorp/aws v${AWS_PROVIDER_VERSION}\n` : `${find}\n- Installing hashicorp/aws v${AWS_PROVIDER_VERSION}...\n- Installed hashicorp/aws v${AWS_PROVIDER_VERSION} (signed by HashiCorp)\n`;
  if (!had) out += `\nTerraform has created a lock file ${bold('.terraform.lock.hcl')} to record the provider\nselections it made above. Include this file in your version control repository\nso that Terraform can guarantee to make the same selections by default when\nyou run "terraform init" in the future.\n`;
  out += `\n${boldGreen('Terraform has been successfully initialized!')}\n\n${green('You may now begin working with Terraform. Try running "terraform plan" to see\nany changes that are required for your infrastructure. All Terraform commands\nshould now work.')}\n\nIf you ever set or change modules or backend configuration for Terraform,\nrerun this command to reinitialize your working directory. If you forget, other\ncommands will detect it and remind you to do so if necessary.\n`;
  return ok(out);
}

function cmdValidate(sh: Shell, o: Opts): CmdResult {
  if (!listTf(sh).length) return ok(`${boldGreen('Success!')} The configuration is valid.\n\n`.replace('Success!', 'Success!'));
  if (!initialized(sh)) return fail(NOINIT().trimEnd());
  const { cfg, diags } = loadConfig(sh);
  const all = [...diags, ...(diags.length ? [] : validateConfig(cfg))];
  if (o.flags.has('json')) return { out: JSON.stringify({ format_version: '1.0', valid: !all.length, error_count: all.length, warning_count: 0, diagnostics: all.map((d) => ({ severity: d.severity, summary: d.summary, detail: d.detail })) }, null, 2) + '\n', err: '', code: all.length ? 1 : 0 };
  if (all.length) return { out: '', err: `\n${render(all, cfg)}`, code: 1 };
  return ok(`${boldGreen('Success!')} The configuration is valid.\n\n`);
}

/** Formateador mínimo: sangría de 2 espacios y alineación de `=` en grupos de atributos contiguos. */
export function formatHcl(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let depth = 0;
  let heredoc: string | null = null;
  const stripStr = (l: string) => l.replace(/"(\\.|[^"\\])*"/g, '""').replace(/#.*$|\/\/.*$/, '');
  for (const raw of lines) {
    if (heredoc) { out.push(raw); if (raw.trim() === heredoc) heredoc = null; continue; }
    const t = raw.trim();
    if (!t) { out.push(''); continue; }
    const s = stripStr(t);
    const closers = (s.match(/^[}\])]+/) ?? [''])[0].length;
    const d = Math.max(0, depth - closers);
    out.push('  '.repeat(d) + t.replace(/^([A-Za-z_][\w-]*)\s*=\s*/, '$1 = '));
    const opens = (s.match(/[{[(]/g) ?? []).length, closes = (s.match(/[}\])]/g) ?? []).length;
    depth = Math.max(0, depth + opens - closes);
    const h = t.match(/<<-?\s*([A-Z_]+)\s*$/) ?? t.match(/<<-?([A-Z_]+)/);
    if (h) heredoc = h[1];
  }
  // alinear '='
  const re = /^(\s*)([A-Za-z_][\w-]*) = (.*)$/;
  for (let i = 0; i < out.length;) {
    const m = out[i].match(re);
    if (!m || /[{[(]\s*$/.test(out[i])) { i++; continue; }
    let j = i;
    while (j < out.length) { const mm = out[j].match(re); if (!mm || mm[1] !== m[1] || /[{[(]\s*$/.test(out[j])) break; j++; }
    const w = Math.max(...out.slice(i, j).map((l) => l.match(re)![2].length));
    for (let k = i; k < j; k++) { const mm = out[k].match(re)!; out[k] = `${mm[1]}${mm[2].padEnd(w)} = ${mm[3]}`; }
    i = Math.max(j, i + 1);
  }
  return out.join('\n').replace(/\n*$/, '\n');
}

function cmdFmt(sh: Shell, o: Opts): CmdResult {
  const changed: string[] = [];
  for (const f of listTf(sh)) {
    const p = VFS.norm(f, sh.cwd);
    const src = sh.fs.readFile(p);
    const nu = formatHcl(src);
    if (nu !== src) { changed.push(f); if (!o.flags.has('check')) sh.fs.writeFile(p, nu); }
  }
  return { out: changed.length ? changed.join('\n') + '\n' : '', err: '', code: o.flags.has('check') && changed.length ? 3 : 0 };
}

// ------------------------------------------------------------------ comando

registerCommand('terraform', (args, { sh, stdin }): CmdResult => {
  setColor(!args.includes('-no-color'));
  try {
    const rest = args.filter((a) => a !== '-no-color');
    const cmd = rest[0];
    const o = parseOpts(rest.slice(1));
    if (!cmd || cmd === '-help' || cmd === '--help' || cmd === 'help') return ok(`Usage: terraform [global options] <subcommand> [args]\n\nThe available commands for execution are listed below.\nThe primary workflow commands are given first, followed by\nless common or more advanced commands.\n\nMain commands:\n  init          Prepare your working directory for other commands\n  validate      Check whether the configuration is valid\n  plan          Show changes required by the current configuration\n  apply         Create or update infrastructure\n  destroy       Destroy previously-created infrastructure\n\nAll other commands:\n  fmt           Reformat your configuration in the standard style\n  output        Show output values from your root module\n  show          Show the current state or a saved plan\n  state         Advanced state management\n  version       Show the current Terraform version\n`);
    if (cmd === 'version' || cmd === '-version' || cmd === '--version') return ok(`Terraform v${TF_VERSION}\non linux_amd64${initialized(sh) ? `\n+ provider registry.terraform.io/hashicorp/aws v${AWS_PROVIDER_VERSION}` : ''}\n`);
    switch (cmd) {
      case 'init': return cmdInit(sh);
      case 'validate': return cmdValidate(sh, o);
      case 'fmt': return cmdFmt(sh, o);
      case 'output': return cmdOutput(sh, o);
      case 'show': return cmdShow(sh);
      case 'state': return cmdState(sh, o);
      case 'plan': {
        const x = runPlan(sh, o, o.flags.has('destroy'), 'plan');
        if ('code' in x) return x;
        if (o.out) sh.fs.writeFile(VFS.norm(o.out, sh.cwd), JSON.stringify({ planned: true, at: new Date().toISOString() }));
        const out = refreshLines(x.plan, x.plan.state) + renderPlan(x.plan, 'plan', !!o.out);
        const changes = x.plan.actions.length > 0 || x.plan.outputs.length > 0;
        return { out, err: '', code: o.flags.has('detailed-exitcode') && changes ? 2 : 0 };
      }
      case 'apply':
      case 'destroy': {
        const destroy = cmd === 'destroy' || o.flags.has('destroy');
        const x = runPlan(sh, o, destroy, destroy ? 'destroy' : 'apply');
        if ('code' in x) return x;
        const auto = o.flags.has('auto-approve') || o.pos.length > 0 || stdin.trim() === 'yes';
        const pre = refreshLines(x.plan, x.plan.state);
        const planTxt = renderPlan(x.plan, destroy ? 'destroy' : 'apply', true);
        if (!x.plan.actions.length && !x.plan.outputs.length) return ok(pre + planTxt + (destroy ? `\n${boldGreen('Destroy complete!')} Resources: 0 destroyed.\n` : `\n${boldGreen('Apply complete!')} Resources: 0 added, 0 changed, 0 destroyed.\n`));
        if (!auto) {
          const prompt = destroy ? `\nDo you really want to destroy all resources?\n  Terraform will destroy all your managed infrastructure, as shown above.\n  There is no undo. Only 'yes' will be accepted to confirm.\n\n  ${bold('Enter a value:')} ` : `\nDo you want to perform these actions?\n  Terraform will perform the actions described above.\n  Only 'yes' will be accepted to approve.\n\n  ${bold('Enter a value:')} `;
          return { out: pre + planTxt + prompt + `\n\n${destroy ? 'Destroy' : 'Apply'} cancelled.\n`, err: '', code: 1 };
        }
        const done = applyLive(sh, x.r, x.plan, destroy);
        const drift = x.plan.drift.length || !x.plan.actions.length ? '' : '';
        void drift;
        return { ...done, out: pre + planTxt + '\n' + done.out };
      }
      case 'refresh': {
        const x = runPlan(sh, o, false, 'plan');
        if ('code' in x) return x;
        saveState(sh, x.plan.state);
        return ok(refreshLines(x.plan, x.plan.state) + `\n${boldGreen('Apply complete!')} Resources: 0 added, 0 changed, 0 destroyed.\n`);
      }
      default:
        return fail(`Terraform has no command named "${cmd}".\n\nTo see all of Terraform's top-level commands, run:\n  terraform -help\n`);
    }
    return ok();
  } finally {
    setColor(true);
  }
});

void cyan; void boldRed; void boldYellow; void addrOf;
