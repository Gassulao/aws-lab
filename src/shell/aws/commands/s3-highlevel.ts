// aws s3 ls | mb | rb | cp | mv | rm | sync  (comandos de alto nivel)
import { defineCommand } from '../framework';
import * as s3 from '../../../engine/services/s3';
import { AwsError, cliErrorText } from '../../../engine/errors';
import { VFS } from '../../fs';
import type { Ctx } from '../../../engine/api';
import type { Shell } from '../../interp';

const BOOL = ['recursive', 'dryrun', 'delete', 'quiet', 'human-readable', 'summarize'];

function parseS3(uri: string): { bucket: string; key: string } | null {
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(uri);
  return m ? { bucket: m[1], key: m[2] } : null;
}

const pad = (n: number, w: number) => String(n).padStart(w);
const stamp = (iso: string) => iso.slice(0, 19).replace('T', ' ');

function failLine(prefix: string, e: unknown, op: string): never {
  if (e instanceof AwsError) throw new Error(`${prefix} failed: ${cliErrorText(e, op)}`);
  throw e;
}

function allKeys(c: Ctx, bucket: string, prefix: string) {
  return s3.listObjectsV2(c, { Bucket: bucket, Prefix: prefix }).Contents;
}

function localFiles(sh: Shell, root: string): { rel: string; abs: string }[] {
  const out: { rel: string; abs: string }[] = [];
  const walk = (dir: string, rel: string) => {
    for (const n of sh.fs.list(dir)) {
      const a = VFS.norm(n, dir);
      if (sh.fs.isDir(a)) walk(a, rel + n + '/');
      else out.push({ rel: rel + n, abs: a });
    }
  };
  if (sh.fs.isDir(root)) walk(root, '');
  return out;
}

const sseOf = (p: Record<string, any>) => ({ ServerSideEncryption: p.Sse ? String(p.Sse) : undefined, SSEKMSKeyId: p.SseKmsKeyId ? String(p.SseKmsKeyId) : undefined });

const disp = (p: string) => (p === '-' || p.startsWith('/') || p.startsWith('.') ? p : './' + p);

defineCommand({
  service: 's3',
  name: 'ls',
  op: 'ListObjectsV2',
  raw: true,
  bool: BOOL,
  run: (c, p, _sh, pos) => {
    if (!pos[0]) {
      return s3.listBuckets(c).map((b) => `${stamp(b.CreationDate)} ${b.Name}`).join('\n') + (c.s.buckets.length ? '\n' : '');
    }
    const t = parseS3(pos[0]);
    if (!t) throw new Error(`\n'${pos[0]}' is not a valid S3 URI`);
    let prefix = t.key;
    const r = s3.listObjectsV2(c, { Bucket: t.bucket, Prefix: prefix, Delimiter: p.Recursive ? undefined : '/' });
    const lines = [...r.CommonPrefixes.map((x) => `${' '.repeat(27)}PRE ${x.slice(prefix.lastIndexOf('/') + 1)}`), ...r.Contents.map((o) => `${stamp(o.lastModified)} ${pad(o.size, 10)} ${p.Recursive ? o.key : o.key.slice(prefix.lastIndexOf('/') + 1)}`)];
    if (p.Summarize) {
      lines.push('', `Total Objects: ${r.Contents.length}`, `   Total Size: ${r.Contents.reduce((n, o) => n + o.size, 0)}`);
    }
    return lines.join('\n') + (lines.length ? '\n' : '');
  },
});

defineCommand({
  service: 's3',
  name: 'mb',
  op: 'CreateBucket',
  raw: true,
  run: (c, _p, _sh, pos) => {
    const t = parseS3(pos[0] ?? '');
    if (!t) throw new Error('\nmake_bucket failed: invalid S3 URI');
    try {
      s3.createBucket(c, { Bucket: t.bucket, Region: c.region });
    } catch (e) {
      failLine(`make_bucket failed: s3://${t.bucket}`, e, 'CreateBucket');
    }
    return `make_bucket: ${t.bucket}\n`;
  },
});

defineCommand({
  service: 's3',
  name: 'rb',
  op: 'DeleteBucket',
  raw: true,
  bool: ['force'],
  run: (c, p, _sh, pos) => {
    const t = parseS3(pos[0] ?? '');
    if (!t) throw new Error('\nremove_bucket failed: invalid S3 URI');
    let out = '';
    try {
      if (p.Force) for (const o of allKeys(c, t.bucket, '')) {
        s3.deleteObject(c, { Bucket: t.bucket, Key: o.key });
        out += `delete: s3://${t.bucket}/${o.key}\n`;
      }
      s3.deleteBucket(c, { Bucket: t.bucket });
    } catch (e) {
      failLine(`remove_bucket failed: s3://${t.bucket}`, e, 'DeleteBucket');
    }
    return out + `remove_bucket: ${t.bucket}\n`;
  },
});

defineCommand({
  service: 's3',
  name: 'rm',
  op: 'DeleteObject',
  raw: true,
  bool: BOOL,
  run: (c, p, _sh, pos) => {
    const t = parseS3(pos[0] ?? '');
    if (!t) throw new Error('\ndelete failed: invalid S3 URI');
    const keys = p.Recursive ? allKeys(c, t.bucket, t.key).map((o) => o.key) : [t.key];
    let out = '';
    for (const k of keys) {
      try {
        if (!p.Recursive) s3.headObject(c, { Bucket: t.bucket, Key: k });
        if (!p.Dryrun) s3.deleteObject(c, { Bucket: t.bucket, Key: k });
      } catch (e) {
        if (e instanceof AwsError && e.code === '404') continue;
        failLine(`delete failed: s3://${t.bucket}/${k}`, e, 'DeleteObject');
      }
      out += `${p.Dryrun ? '(dryrun) ' : ''}delete: s3://${t.bucket}/${k}\n`;
    }
    return p.Quiet ? '' : out;
  },
});

function copyOne(c: Ctx, sh: Shell, src: string, dst: string, p: Record<string, any>): string {
  const s = parseS3(src);
  const d = parseS3(dst);
  if (!s && d) {
    const abs = VFS.norm(src, sh.cwd);
    if (!sh.fs.isFile(abs)) throw new Error(`\nThe user-provided path ${src} does not exist.`);
    const key = !d.key || d.key.endsWith('/') ? d.key + src.split('/').pop() : d.key;
    try {
      s3.putObject(c, { Bucket: d.bucket, Key: key, Body: sh.fs.readFile(abs), ...sseOf(p) });
    } catch (e) {
      failLine(`upload failed: ${disp(src)} to s3://${d.bucket}/${key}`, e, 'PutObject');
    }
    return `upload: ${disp(src)} to s3://${d.bucket}/${key}\n`;
  }
  if (s && !d) {
    let o;
    try {
      o = s3.getObject(c, { Bucket: s.bucket, Key: s.key });
    } catch (e) {
      if (e instanceof AwsError && e.code === 'NoSuchKey') throw new Error(`\nfatal error: An error occurred (404) when calling the HeadObject operation: Key "${s.key}" does not exist`);
      if (e instanceof AwsError) failLine(`download failed: s3://${s.bucket}/${s.key} to ${disp(dst)}`, e, 'GetObject');
      throw e;
    }
    let target = VFS.norm(dst, sh.cwd);
    if (sh.fs.isDir(target) || dst.endsWith('/')) target = VFS.norm(s.key.split('/').pop()!, target);
    sh.fs.writeFile(target, o.body);
    return `download: s3://${s.bucket}/${s.key} to ${disp(dst.endsWith('/') ? dst + s.key.split('/').pop() : dst)}\n`;
  }
  if (s && d) {
    const key = !d.key || d.key.endsWith('/') ? d.key + s.key.split('/').pop() : d.key;
    try {
      s3.copyObject(c, { SourceBucket: s.bucket, SourceKey: s.key, Bucket: d.bucket, Key: key });
    } catch (e) {
      failLine(`copy failed: s3://${s.bucket}/${s.key} to s3://${d.bucket}/${key}`, e, 'CopyObject');
    }
    return `copy: s3://${s.bucket}/${s.key} to s3://${d.bucket}/${key}\n`;
  }
  throw new Error('\nUsage: aws s3 cp <LocalPath> <S3Uri> or <S3Uri> <LocalPath> or <S3Uri> <S3Uri>');
}

function copyRecursive(c: Ctx, sh: Shell, src: string, dst: string, p: Record<string, any>, move = false): string {
  const s = parseS3(src);
  const d = parseS3(dst);
  let out = '';
  if (!s && d) {
    for (const f of localFiles(sh, VFS.norm(src, sh.cwd))) {
      const key = d.key.replace(/\/?$/, d.key ? '/' : '') + f.rel;
      s3.putObject(c, { Bucket: d.bucket, Key: key, Body: sh.fs.readFile(f.abs), ...sseOf(p) });
      out += `upload: ${disp(src.replace(/\/$/, '') + '/' + f.rel)} to s3://${d.bucket}/${key}\n`;
    }
  } else if (s && !d) {
    for (const o of allKeys(c, s.bucket, s.key)) {
      const rel = o.key.slice(s.key.length).replace(/^\//, '');
      const target = VFS.norm(rel, VFS.norm(dst, sh.cwd));
      const dir = target.split('/').slice(0, -1).join('/') || '/';
      sh.fs.mkdir(dir, true);
      sh.fs.writeFile(target, o.body);
      out += `download: s3://${s.bucket}/${o.key} to ${disp(dst.replace(/\/$/, '') + '/' + rel)}\n`;
    }
  } else if (s && d) {
    for (const o of allKeys(c, s.bucket, s.key)) {
      const rel = o.key.slice(s.key.length).replace(/^\//, '');
      const key = d.key.replace(/\/?$/, d.key ? '/' : '') + rel;
      s3.copyObject(c, { SourceBucket: s.bucket, SourceKey: o.key, Bucket: d.bucket, Key: key });
      out += `copy: s3://${s.bucket}/${o.key} to s3://${d.bucket}/${key}\n`;
    }
  }
  void p;
  void move;
  return out;
}

defineCommand({
  service: 's3',
  name: 'cp',
  op: 'PutObject',
  raw: true,
  bool: BOOL,
  run: (c, p, sh, pos) => {
    if (pos.length < 2) throw new Error('\nusage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\naws: error: the following arguments are required: paths');
    const out = p.Recursive ? copyRecursive(c, sh, pos[0], pos[1], p) : copyOne(c, sh, pos[0], pos[1], p);
    return p.Quiet ? '' : out;
  },
});

defineCommand({
  service: 's3',
  name: 'mv',
  op: 'CopyObject',
  raw: true,
  bool: BOOL,
  run: (c, p, sh, pos) => {
    if (pos.length < 2) throw new Error('\naws: error: the following arguments are required: paths');
    const src = parseS3(pos[0]);
    const out = p.Recursive ? copyRecursive(c, sh, pos[0], pos[1], p, true) : copyOne(c, sh, pos[0], pos[1], p);
    if (src) {
      for (const o of p.Recursive ? allKeys(c, src.bucket, src.key) : [{ key: src.key }]) s3.deleteObject(c, { Bucket: src.bucket, Key: o.key });
    } else {
      const abs = VFS.norm(pos[0], sh.cwd);
      if (sh.fs.exists(abs)) sh.fs.remove(abs, true);
    }
    return out.replace(/^(upload|download|copy):/gm, 'move:');
  },
});

defineCommand({
  service: 's3',
  name: 'sync',
  op: 'PutObject',
  raw: true,
  bool: BOOL,
  run: (c, p, sh, pos) => {
    const [src, dst] = pos;
    const s = parseS3(src ?? '');
    const d = parseS3(dst ?? '');
    let out = '';
    if (!s && d) {
      const prefix = d.key ? d.key.replace(/\/?$/, '/') : '';
      const existing = new Map(allKeys(c, d.bucket, prefix).map((o) => [o.key, o]));
      const seen = new Set<string>();
      for (const f of localFiles(sh, VFS.norm(src, sh.cwd))) {
        const key = prefix + f.rel;
        seen.add(key);
        const body = sh.fs.readFile(f.abs);
        const ex = existing.get(key);
        if (ex && ex.size === new TextEncoder().encode(body).length && ex.body === body) continue;
        if (!p.Dryrun) s3.putObject(c, { Bucket: d.bucket, Key: key, Body: body, ...sseOf(p) });
        out += `${p.Dryrun ? '(dryrun) ' : ''}upload: ${disp(src.replace(/\/$/, '') + '/' + f.rel)} to s3://${d.bucket}/${key}\n`;
      }
      if (p.Delete) for (const k of existing.keys()) if (!seen.has(k)) {
        if (!p.Dryrun) s3.deleteObject(c, { Bucket: d.bucket, Key: k });
        out += `${p.Dryrun ? '(dryrun) ' : ''}delete: s3://${d.bucket}/${k}\n`;
      }
    } else if (s && !d) {
      out = copyRecursive(c, sh, src, dst, p);
    } else throw new Error('\nUsage: aws s3 sync <LocalPath> <S3Uri> or <S3Uri> <LocalPath>');
    return p.Quiet ? '' : out;
  },
});
