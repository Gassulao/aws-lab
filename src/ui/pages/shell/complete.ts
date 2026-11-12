// Autocompletado básico con Tab: comandos, `aws <servicio> <operación>`, opciones globales y rutas.
import type { Shell } from '../../../shell';
import { listCommands, services } from '../../../shell/aws/framework';
import { VFS } from '../../../shell/fs';

const LINUX = ['aws', 'terraform', 'dig', 'nslookup', 'cat', 'cd', 'clear', 'cp', 'curl', 'cut', 'date', 'echo', 'env', 'export', 'grep', 'head', 'history', 'hostname', 'jq', 'ls', 'mkdir', 'mv', 'printf', 'pwd', 'rm', 'sed', 'seq', 'sleep', 'sort', 'tail', 'tee', 'touch', 'tr', 'uname', 'uniq', 'unset', 'wc', 'which', 'whoami', 'xargs', 'base64', 'basename', 'dirname', 'test'];
const AWS_GLOBAL = ['--region', '--output', '--query', '--profile', '--no-cli-pager', '--debug', '--no-paginate'];
const FS_CMDS = new Set(['cat', 'cd', 'cp', 'head', 'ls', 'mkdir', 'mv', 'rm', 'tail', 'touch', 'wc', 'sort', 'grep', 'tee', 'sed', 'cut']);

export interface Completion {
  /** Nueva línea completa (hasta el cursor). */
  line: string;
  /** Candidatos para mostrar si hay varios. */
  options: string[];
}

const common = (xs: string[]) => {
  let p = xs[0] ?? '';
  for (const x of xs) while (!x.startsWith(p)) p = p.slice(0, -1);
  return p;
};

export function complete(sh: Shell, before: string): Completion | null {
  const m = /^(.*?)(\S*)$/s.exec(before)!;
  const head = m[1];
  const word = m[2];
  const toks = head.trim() ? head.trim().split(/\s+/) : [];
  let cands: string[] = [];
  let suffixSpace = true;

  if (toks.length === 0) {
    cands = LINUX.filter((c) => c.startsWith(word));
  } else if (toks[0] === 'aws' && toks.length === 1 && !word.startsWith('-')) {
    cands = [...services(), 'configure'].filter((c) => c.startsWith(word));
  } else if (toks[0] === 'aws' && toks.length === 2 && !word.startsWith('-') && toks[1] !== 'configure') {
    cands = listCommands(toks[1]).map((c) => c.name).filter((c) => c.startsWith(word));
  } else if (toks[0] === 'aws' && toks.length === 2 && toks[1] === 'configure') {
    cands = ['list', 'get', 'set', 'list-profiles'].filter((c) => c.startsWith(word));
  } else if (toks[0] === 'aws' && word.startsWith('--')) {
    cands = AWS_GLOBAL.filter((c) => c.startsWith(word));
  } else if (toks[0] === 'aws' && toks[toks.length - 1] === '--region') {
    cands = ['eu-west-1', 'eu-west-3', 'eu-south-2', 'eu-central-1', 'us-east-1', 'us-west-2'].filter((c) => c.startsWith(word));
  } else if (toks[0] === 'aws' && toks[toks.length - 1] === '--output') {
    cands = ['json', 'table', 'text', 'yaml'].filter((c) => c.startsWith(word));
  } else if (toks[0] === 'aws' && toks[1] === 's3' && toks.length === 2) {
    cands = ['ls', 'cp', 'mv', 'rm', 'sync', 'mb', 'rb'].filter((c) => c.startsWith(word));
  } else if (toks[0] === 'aws' || FS_CMDS.has(toks[0]) || word.includes('/') || word.startsWith('.') || word.startsWith('~')) {
    // Rutas del sistema de ficheros virtual.
    const home = `/home/${sh.s.me.userName}`;
    const expanded = word === '~' ? home + '/' : word.startsWith('~/') ? home + word.slice(1) : word;
    const slash = expanded.lastIndexOf('/');
    const dirPart = slash >= 0 ? expanded.slice(0, slash + 1) : '';
    const base = expanded.slice(slash + 1);
    const dirAbs = VFS.norm(dirPart || '.', sh.cwd);
    if (sh.fs.isDir(dirAbs)) {
      const names = sh.fs.list(dirAbs).filter((n) => n.startsWith(base) && (base.startsWith('.') || !n.startsWith('.')));
      const shownDir = word.startsWith('~') && slash >= 0 ? '~' + dirPart.slice(home.length) : word === '~' ? '~/' : dirPart;
      cands = names.map((n) => shownDir + n + (sh.fs.isDir(VFS.norm(n, dirAbs)) ? '/' : ''));
      suffixSpace = false;
    }
  }
  if (!cands.length) return null;
  cands = [...new Set(cands)].sort();
  const pre = common(cands);
  if (cands.length === 1) {
    const only = cands[0];
    return { line: head + only + (suffixSpace && !only.endsWith('/') ? ' ' : ''), options: [] };
  }
  return { line: head + pre, options: cands.map((c) => c.slice(c.lastIndexOf('/', c.length - 2) + 1)) };
}
