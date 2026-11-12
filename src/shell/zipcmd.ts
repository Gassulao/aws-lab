// `zip` y `unzip` simulados: el «zip» conserva los ficheros en un contenedor propio (el mismo que leen CodeDeploy
// y Lambda). Sirve para empaquetar el código de una función: zip function.zip index.js
import { registerCommand, ok, fail, type CmdResult } from './interp';
import type { Shell } from './interp';
import { VFS } from './fs';
import { packBundle, unpackBundle } from '../engine/services/cicdCommon';

const abs = (sh: Shell, p: string) => VFS.norm(p, sh.cwd);

function collect(sh: Shell, rel: string, recursive: boolean, junk: boolean, out: Record<string, string>, log: string[]): string | null {
  const p = abs(sh, rel);
  if (sh.fs.isFile(p)) {
    out[junk ? rel.split('/').pop()! : rel.replace(/^\.\//, '')] = sh.fs.readFile(p);
    log.push(`  adding: ${junk ? rel.split('/').pop() : rel.replace(/^\.\//, '')} (deflated ${30 + (rel.length % 30)}%)`);
    return null;
  }
  if (sh.fs.isDir(p)) {
    if (!recursive) { log.push(`  adding: ${rel.replace(/\/?$/, '/')} (stored 0%)`); return null; }
    log.push(`  adding: ${rel.replace(/\/?$/, '/')} (stored 0%)`);
    for (const n of sh.fs.list(p)) { const e = collect(sh, rel.replace(/\/$/, '') + '/' + n, true, junk, out, log); if (e) return e; }
    return null;
  }
  return `\tzip warning: name not matched: ${rel}`;
}

registerCommand('zip', (args, { sh }): CmdResult => {
  const flags = args.filter((a) => /^-[a-zA-Z]+$/.test(a)).join('');
  const rest = args.filter((a) => !/^-[a-zA-Z]+$/.test(a));
  if (rest.length < 2) return fail('zip error: Nothing to do!\n\nzip  (in=0) (out=0)\nSkipping: no input files', 12);
  const [archive, ...inputs] = rest;
  const name = archive.endsWith('.zip') ? archive : archive + '.zip';
  const files: Record<string, string> = {};
  const log: string[] = [];
  const warn: string[] = [];
  for (const i of inputs) { const e = collect(sh, i, flags.includes('r'), flags.includes('j'), files, log); if (e) warn.push(e); }
  if (!Object.keys(files).length && !log.length) return fail(warn.join('\n') + '\n\nzip error: Nothing to do! (' + name + ')', 12);
  sh.fs.writeFile(abs(sh, name), packBundle(files));
  return { out: log.join('\n') + '\n', err: warn.length ? warn.join('\n') + '\n' : '', code: warn.length ? 18 : 0 };
});

registerCommand('unzip', (args, { sh }): CmdResult => {
  const dIdx = args.indexOf('-d');
  const dest = dIdx >= 0 ? args[dIdx + 1] : '.';
  const list = args.includes('-l');
  const file = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-d');
  if (!file) return fail('UnZip 6.00 of 20 April 2009\nUsage: unzip [-Z] [-opts[modifiers]] file[.zip] [list] [-x xlist] [-d exdir]', 1);
  const p = abs(sh, file.endsWith('.zip') || sh.fs.exists(abs(sh, file)) ? file : file + '.zip');
  if (!sh.fs.isFile(p)) return fail(`unzip:  cannot find or open ${file}, ${file}.zip or ${file}.ZIP.`, 9);
  const files = unpackBundle(sh.fs.readFile(p));
  if (!files) return fail(`Archive:  ${file}\n  End-of-central-directory signature not found.  Either this file is not\n  a zipfile, or it constitutes one disk of a multi-part archive.`, 9);
  if (list) return ok(`Archive:  ${file}\n  Length      Date    Time    Name\n---------  ---------- -----   ----\n${Object.entries(files).map(([n, c]) => `${String(c.length).padStart(9)}  2026-01-01 00:00   ${n}`).join('\n')}\n---------                     -------\n${String(Object.values(files).reduce((a, c) => a + c.length, 0)).padStart(9)}                     ${Object.keys(files).length} files\n`);
  const out: string[] = [`Archive:  ${file}`];
  for (const [n, c] of Object.entries(files)) {
    const target = VFS.norm(n, abs(sh, dest));
    const dir = target.slice(0, target.lastIndexOf('/')) || '/';
    if (!sh.fs.exists(dir)) sh.fs.mkdir(dir, true);
    sh.fs.writeFile(target, c);
    out.push(`  inflating: ${dest === '.' ? '' : dest.replace(/\/?$/, '/')}${n}`);
  }
  return ok(out.join('\n') + '\n');
});
