// Sistema de ficheros inicial de la terminal: carpeta personal y proyectos de ejemplo.
import type { VfsNode } from './types';

export const SAMPLE_FILES: Record<string, string> = {
  'README.md': '# Tu carpeta personal\n\nAquí practicas con la terminal de AWS Lab.\n\n- `samples/` contiene proyectos de ejemplo.\n- Prueba: `aws sts get-caller-identity`\n',
  'samples/hola/index.html': '<!doctype html>\n<html lang="es">\n  <head><meta charset="utf-8"><title>Hola AWS</title></head>\n  <body><h1>Hola desde S3</h1></body>\n</html>\n',
  'samples/politicas/s3-solo-lectura.json': JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['s3:GetObject', 's3:ListBucket'], Resource: ['arn:aws:s3:::mi-bucket', 'arn:aws:s3:::mi-bucket/*'] }] }, null, 2) + '\n',
  'samples/politicas/trust-ec2.json': JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] }, null, 2) + '\n',
};

export function buildHome(user: string): VfsNode {
  const root: VfsNode = { type: 'dir', children: {} };
  const ensureDir = (parts: string[]): VfsNode => {
    let cur = root;
    for (const p of parts) {
      cur.children ??= {};
      cur.children[p] ??= { type: 'dir', children: {} };
      cur = cur.children[p];
    }
    return cur;
  };
  for (const d of ['tmp', 'etc', 'usr', 'bin']) ensureDir([d]);
  const home = ensureDir(['home', user]);
  for (const [path, content] of Object.entries(SAMPLE_FILES)) {
    const parts = path.split('/');
    const name = parts.pop()!;
    let cur = home;
    for (const p of parts) {
      cur.children ??= {};
      cur.children[p] ??= { type: 'dir', children: {} };
      cur = cur.children[p];
    }
    cur.children![name] = { type: 'file', content, mode: 0o644 };
  }
  return root;
}
