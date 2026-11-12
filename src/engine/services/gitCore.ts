// Núcleo de Git compartido por el comando `git` de la terminal y por CodeCommit: objetos, historial, diff y fusión.
import type { GitCommit, GitIdent, GitObjects } from './cicdTypes';

// ---------------------------------------------------------------- SHA-1 síncrono

function utf8(str: string): number[] {
  return Array.from(new TextEncoder().encode(str));
}

export function sha1(str: string): string {
  const bytes = utf8(str);
  const ml = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : (ml >>> (i * 8)) & 0xff);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Array<number>(80);
  const rol = (x: number, n: number) => (x << n) | (x >>> (32 - n));
  for (let o = 0; o < bytes.length; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = (bytes[o + i * 4] << 24) | (bytes[o + i * 4 + 1] << 16) | (bytes[o + i * 4 + 2] << 8) | bytes[o + i * 4 + 3];
    for (let i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const t = (rol(a, 5) + f + e + k + w[i]) | 0;
      e = d; d = c; c = rol(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

export const blobId = (content: string) => sha1(`blob ${utf8(content).length}\0${content}`);
export const emptyObjects = (): GitObjects => ({ commits: {}, blobs: {} });
export const short = (id: string) => id.slice(0, 7);

// ---------------------------------------------------------------- commits y árboles

export function putBlob(o: GitObjects, content: string): string {
  const id = blobId(content);
  o.blobs[id] = content;
  return id;
}

export function treeOf(o: GitObjects, files: Record<string, string>): Record<string, string> {
  const t: Record<string, string> = {};
  for (const [p, c] of Object.entries(files)) t[p] = putBlob(o, c);
  return t;
}

export function filesOf(o: GitObjects, commitId: string | undefined): Record<string, string> {
  const c = commitId ? o.commits[commitId] : undefined;
  if (!c) return {};
  return Object.fromEntries(Object.entries(c.tree).map(([p, b]) => [p, o.blobs[b] ?? '']));
}

export function makeCommit(o: GitObjects, p: { tree: Record<string, string>; parents: string[]; message: string; author: GitIdent; committer?: GitIdent }): GitCommit {
  const body = JSON.stringify({ t: p.tree, p: p.parents, m: p.message, a: p.author, c: p.committer ?? p.author });
  const id = sha1(`commit ${body.length}\0${body}`);
  const c: GitCommit = { id, tree: p.tree, parents: p.parents, message: p.message, author: p.author, committer: p.committer ?? p.author };
  o.commits[id] = c;
  return c;
}

/** Todos los ancestros (incluido el propio commit) en orden de más reciente a más antiguo. */
export function history(o: GitObjects, tip: string | undefined, limit = 1000): GitCommit[] {
  const out: GitCommit[] = [];
  const seen = new Set<string>();
  const queue = tip ? [tip] : [];
  while (queue.length && out.length < limit) {
    queue.sort((a, b) => (o.commits[b]?.committer.date ?? 0) - (o.commits[a]?.committer.date ?? 0));
    const id = queue.shift()!;
    if (seen.has(id) || !o.commits[id]) continue;
    seen.add(id);
    out.push(o.commits[id]);
    queue.push(...o.commits[id].parents);
  }
  return out;
}

export function ancestors(o: GitObjects, tip: string): Set<string> {
  const seen = new Set<string>();
  const st = [tip];
  while (st.length) {
    const id = st.pop()!;
    if (seen.has(id) || !o.commits[id]) continue;
    seen.add(id);
    st.push(...o.commits[id].parents);
  }
  return seen;
}

export const isAncestor = (o: GitObjects, anc: string, desc: string) => ancestors(o, desc).has(anc);

export function mergeBase(o: GitObjects, a: string, b: string): string | null {
  const aa = ancestors(o, a);
  for (const c of history(o, b)) if (aa.has(c.id)) return c.id;
  return null;
}

/** Copia un commit y toda su historia (y blobs) de un almacén a otro. */
export function copyHistory(from: GitObjects, to: GitObjects, tip: string): void {
  for (const id of ancestors(from, tip)) {
    if (to.commits[id]) continue;
    const c = from.commits[id];
    to.commits[id] = c;
    for (const b of Object.values(c.tree)) to.blobs[b] = from.blobs[b];
  }
}

// ---------------------------------------------------------------- diff por líneas

export type Op = { t: '=' | '-' | '+'; a: number; b: number; line: string };

export function lineOps(a: string[], b: string[]): Op[] {
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: '=', a: i, b: j, line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: '-', a: i++, b: j, line: a[i - 1] });
    else ops.push({ t: '+', a: i, b: j++, line: b[j - 1] });
  }
  while (i < n) ops.push({ t: '-', a: i++, b: j, line: a[i - 1] });
  while (j < m) ops.push({ t: '+', a: i, b: j++, line: b[j - 1] });
  return ops;
}

const splitLines = (s: string): string[] => (s === '' ? [] : s.replace(/\n$/, '').split('\n'));

export function countChanges(a: string | null, b: string | null): { add: number; del: number } {
  const ops = lineOps(splitLines(a ?? ''), splitLines(b ?? ''));
  return { add: ops.filter((o) => o.t === '+').length, del: ops.filter((o) => o.t === '-').length };
}

/** Diff unificado con 3 líneas de contexto, como `git diff`. */
export function unifiedDiff(path: string, a: string | null, b: string | null): string {
  const A = splitLines(a ?? ''), B = splitLines(b ?? '');
  const ops = lineOps(A, B);
  let out = `diff --git a/${path} b/${path}\n`;
  if (a === null) out += `new file mode 100644\nindex 0000000..${short(blobId(b ?? ''))}\n`;
  else if (b === null) out += `deleted file mode 100644\nindex ${short(blobId(a))}..0000000\n`;
  else out += `index ${short(blobId(a))}..${short(blobId(b))} 100644\n`;
  out += `--- ${a === null ? '/dev/null' : 'a/' + path}\n+++ ${b === null ? '/dev/null' : 'b/' + path}\n`;
  const CTX = 3;
  const changed = ops.map((o, i) => (o.t === '=' ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return '';
  const groups: [number, number][] = [];
  for (const i of changed) {
    const last = groups[groups.length - 1];
    if (last && i - last[1] <= CTX * 2) last[1] = i;
    else groups.push([i, i]);
  }
  for (const [s0, e0] of groups) {
    const s = Math.max(0, s0 - CTX), e = Math.min(ops.length - 1, e0 + CTX);
    const slice = ops.slice(s, e + 1);
    const aStart = slice.find((o) => o.t !== '+')?.a ?? slice[0].a;
    const bStart = slice.find((o) => o.t !== '-')?.b ?? slice[0].b;
    const aLen = slice.filter((o) => o.t !== '+').length, bLen = slice.filter((o) => o.t !== '-').length;
    out += `@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@\n`;
    for (const o of slice) out += (o.t === '=' ? ' ' : o.t) + o.line + '\n';
  }
  return out;
}

export function diffTrees(oa: Record<string, string>, ob: Record<string, string>): { path: string; kind: 'A' | 'D' | 'M' }[] {
  const out: { path: string; kind: 'A' | 'D' | 'M' }[] = [];
  for (const p of new Set([...Object.keys(oa), ...Object.keys(ob)])) {
    if (!(p in oa)) out.push({ path: p, kind: 'A' });
    else if (!(p in ob)) out.push({ path: p, kind: 'D' });
    else if (oa[p] !== ob[p]) out.push({ path: p, kind: 'M' });
  }
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

// ---------------------------------------------------------------- fusión de tres vías

interface Hunk { s: number; e: number; l: string[] }

function hunksOf(base: string[], side: string[]): Hunk[] {
  const ops = lineOps(base, side);
  const hs: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const o of ops) {
    if (o.t === '=') { cur = null; continue; }
    if (!cur) { cur = { s: o.a, e: o.a, l: [] }; hs.push(cur); }
    if (o.t === '-') cur.e = o.a + 1;
    else cur.l.push(o.line);
  }
  return hs;
}

/** Fusiona por líneas. Si hay cambios solapados distintos deja marcas de conflicto como Git. */
export function merge3(base: string, ours: string, theirs: string, labels: { ours: string; theirs: string } = { ours: 'HEAD', theirs: 'theirs' }): { text: string; conflict: boolean } {
  if (ours === theirs) return { text: ours, conflict: false };
  if (base === ours) return { text: theirs, conflict: false };
  if (base === theirs) return { text: ours, conflict: false };
  const B = base.split('\n');
  const ha = hunksOf(B, ours.split('\n')), hb = hunksOf(B, theirs.split('\n'));
  const out: string[] = [];
  let pos = 0, i = 0, j = 0, conflict = false;
  const overlap = (x: Hunk, y: Hunk) => (x.s < y.e && y.s < x.e) || x.s === y.s;
  while (i < ha.length || j < hb.length) {
    const x = ha[i], y = hb[j];
    if (x && (!y || (!overlap(x, y) && x.s <= y.s))) { out.push(...B.slice(pos, x.s), ...x.l); pos = x.e; i++; continue; }
    if (y && (!x || (!overlap(x, y) && y.s < x.s))) { out.push(...B.slice(pos, y.s), ...y.l); pos = y.e; j++; continue; }
    // Solapan.
    if (x.s === y.s && x.e === y.e && x.l.join('\n') === y.l.join('\n')) { out.push(...B.slice(pos, x.s), ...x.l); pos = x.e; i++; j++; continue; }
    const s = Math.min(x.s, y.s), e = Math.max(x.e, y.e);
    const mine = [...B.slice(s, x.s), ...x.l, ...B.slice(x.e, e)];
    const their = [...B.slice(s, y.s), ...y.l, ...B.slice(y.e, e)];
    out.push(...B.slice(pos, s), `<<<<<<< ${labels.ours}`, ...mine, '=======', ...their, `>>>>>>> ${labels.theirs}`);
    pos = e; i++; j++; conflict = true;
  }
  out.push(...B.slice(pos));
  return { text: out.join('\n'), conflict };
}

/** Fusión de tres vías entre árboles de ficheros. Devuelve el resultado y las rutas en conflicto. */
export function mergeFiles(base: Record<string, string>, ours: Record<string, string>, theirs: Record<string, string>, labels?: { ours: string; theirs: string }): { files: Record<string, string>; conflicts: string[]; conflictKinds: Record<string, string> } {
  const files: Record<string, string> = {};
  const conflicts: string[] = [];
  const kinds: Record<string, string> = {};
  for (const p of new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])) {
    const b = base[p], o = ours[p], t = theirs[p];
    if (o === t) { if (o !== undefined) files[p] = o; continue; }
    if (b === o) { if (t !== undefined) files[p] = t; continue; }
    if (b === t) { if (o !== undefined) files[p] = o; continue; }
    if (o === undefined || t === undefined) {
      // modificado en un lado y borrado en el otro
      files[p] = (o ?? t)!;
      conflicts.push(p);
      kinds[p] = 'modify/delete';
      continue;
    }
    const r = merge3(b ?? '', o, t, labels);
    files[p] = r.text;
    if (r.conflict) { conflicts.push(p); kinds[p] = b === undefined ? 'add/add' : 'content'; }
  }
  return { files, conflicts: conflicts.sort(), conflictKinds: kinds };
}

export const hasConflictMarkers = (s: string) => /^<<<<<<< /m.test(s) && /^>>>>>>> /m.test(s);
