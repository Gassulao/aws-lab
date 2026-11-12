// Sistema de ficheros virtual en memoria sobre el árbol VfsNode del estado.
import type { VfsNode } from '../engine/types';

export class FsError extends Error {}

export class VFS {
  constructor(public root: VfsNode) {}

  static norm(path: string, cwd: string): string {
    const abs = path.startsWith('/') ? path : `${cwd.replace(/\/$/, '')}/${path}`;
    const out: string[] = [];
    for (const p of abs.split('/')) {
      if (!p || p === '.') continue;
      if (p === '..') out.pop();
      else out.push(p);
    }
    return '/' + out.join('/');
  }

  private walk(abs: string): VfsNode | undefined {
    let cur: VfsNode | undefined = this.root;
    for (const p of abs.split('/').filter(Boolean)) {
      if (!cur || cur.type !== 'dir') return undefined;
      cur = cur.children?.[p];
    }
    return cur;
  }

  exists(abs: string) {
    return !!this.walk(abs);
  }
  isFile(abs: string) {
    return this.walk(abs)?.type === 'file';
  }
  isDir(abs: string) {
    return this.walk(abs)?.type === 'dir';
  }

  readFile(abs: string): string {
    const n = this.walk(abs);
    if (!n) throw new FsError('No such file or directory');
    if (n.type === 'dir') throw new FsError('Is a directory');
    return n.content ?? '';
  }

  private parent(abs: string): { dir: VfsNode; name: string } {
    const parts = abs.split('/').filter(Boolean);
    const name = parts.pop();
    if (!name) throw new FsError('Is a directory');
    const dir = this.walk('/' + parts.join('/'));
    if (!dir) throw new FsError('No such file or directory');
    if (dir.type !== 'dir') throw new FsError('Not a directory');
    return { dir, name };
  }

  writeFile(abs: string, content: string, append = false) {
    const { dir, name } = this.parent(abs);
    dir.children ??= {};
    const ex = dir.children[name];
    if (ex?.type === 'dir') throw new FsError('Is a directory');
    dir.children[name] = { type: 'file', content: append && ex ? (ex.content ?? '') + content : content, mode: ex?.mode ?? 0o644 };
  }

  mkdir(abs: string, parents = false) {
    if (parents) {
      let cur = '';
      for (const p of abs.split('/').filter(Boolean)) {
        cur += '/' + p;
        if (!this.exists(cur)) this.mkdir(cur);
        else if (!this.isDir(cur)) throw new FsError('Not a directory');
      }
      return;
    }
    const { dir, name } = this.parent(abs);
    dir.children ??= {};
    if (dir.children[name]) throw new FsError('File exists');
    dir.children[name] = { type: 'dir', children: {} };
  }

  list(abs: string): string[] {
    const n = this.walk(abs);
    if (!n) throw new FsError('No such file or directory');
    if (n.type === 'file') return [abs.split('/').pop()!];
    return Object.keys(n.children ?? {}).sort();
  }

  remove(abs: string, recursive = false) {
    const n = this.walk(abs);
    if (!n) throw new FsError('No such file or directory');
    if (n.type === 'dir' && !recursive) throw new FsError('Is a directory');
    const { dir, name } = this.parent(abs);
    delete dir.children![name];
  }

  copy(src: string, dst: string) {
    const n = this.walk(src);
    if (!n) throw new FsError('No such file or directory');
    const clone = JSON.parse(JSON.stringify(n)) as VfsNode;
    const { dir, name } = this.parent(dst);
    dir.children![name] = clone;
  }

  stat(abs: string) {
    const n = this.walk(abs);
    return n ? { type: n.type, size: n.type === 'file' ? (n.content ?? '').length : 4096, mode: n.mode ?? (n.type === 'dir' ? 0o755 : 0o644) } : undefined;
  }

  chmod(abs: string, mode: number) {
    const n = this.walk(abs);
    if (!n) throw new FsError('No such file or directory');
    n.mode = mode;
  }

  /** Expande un patrón con * y ? dentro de una carpeta (sin recursión por niveles intermedios). */
  glob(pattern: string, cwd: string): string[] {
    const abs = pattern.startsWith('/');
    const segs = pattern.split('/').filter(Boolean);
    let results: { path: string; show: string }[] = [{ path: abs ? '/' : cwd, show: abs ? '/' : '' }];
    for (const seg of segs) {
      const next: { path: string; show: string }[] = [];
      for (const r of results) {
        if (!/[*?]/.test(seg)) {
          const p = VFS.norm(seg, r.path);
          if (this.exists(p)) next.push({ path: p, show: r.show + (r.show && !r.show.endsWith('/') ? '/' : '') + seg });
          continue;
        }
        if (!this.isDir(r.path)) continue;
        const re = new RegExp('^' + seg.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');
        for (const name of this.list(r.path)) {
          if (name.startsWith('.') && !seg.startsWith('.')) continue;
          if (re.test(name)) next.push({ path: VFS.norm(name, r.path), show: r.show + (r.show && !r.show.endsWith('/') ? '/' : '') + name });
        }
      }
      results = next;
    }
    return results.map((r) => r.show).sort();
  }
}
