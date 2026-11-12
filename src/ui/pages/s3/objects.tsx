import React from 'react';
import { getShell } from '../../session';
import { run, q } from '../iam/kit';

export interface Fetched { ok: boolean; msg: string; body: string; contentType: string; size: number }

/** Descarga el objeto mediante la API (respeta permisos y queda en CloudTrail). */
export async function fetchObject(bucket: string, key: string, versionId?: string): Promise<Fetched> {
  const out = `/tmp/dl-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  const r = await run(`aws s3api get-object --bucket ${bucket} --key ${q(key)}${versionId ? ` --version-id ${versionId}` : ''} ${out}`);
  if (!r.ok) return { ok: false, msg: r.msg, body: '', contentType: '', size: 0 };
  let body = '';
  try { body = getShell().fs.readFile(out); } catch { /* vacío */ }
  return { ok: true, msg: '', body, contentType: r.json?.ContentType ?? 'text/plain', size: r.json?.ContentLength ?? body.length };
}

export function saveBlob(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type: type || 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url; a.download = name.split('/').pop() || 'objeto';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function putObject(bucket: string, key: string, body: string, contentType?: string): Promise<string> {
  const f = `/tmp/up-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  getShell().fs.writeFile(f, body);
  const r = await run(`aws s3api put-object --bucket ${bucket} --key ${q(key)} --body ${f}${contentType ? ` --content-type ${q(contentType)}` : ''}`);
  return r.ok ? '' : r.msg;
}

export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export function Preview({ body, contentType }: { body: string; contentType: string }) {
  return (
    <>
      <div className="k-muted" style={{ marginBottom: 6 }}>Tipo de contenido: {contentType}</div>
      <div className="s3-preview">{body || '(objeto vacío)'}</div>
    </>
  );
}
