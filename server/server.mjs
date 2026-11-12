// Servidor mínimo: sirve la aplicación compilada (dist/) y guarda el estado en un volumen (/api/state).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, '..', 'data'));
const file = path.join(dataDir, 'state.json');
const port = Number(process.env.PORT || 8080);
const MAX = 25 * 1024 * 1024;
fs.mkdirSync(dataDir, { recursive: true });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json' };

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/health') return send(res, 200, 'ok');
    if (url.pathname === '/api/state') {
      if (req.method === 'GET') {
        if (!fs.existsSync(file)) return send(res, 204, '');
        return send(res, 200, fs.readFileSync(file), { 'Content-Type': 'application/json' });
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        JSON.parse(body); // valida antes de escribir
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, body);
        fs.renameSync(tmp, file);
        return send(res, 204, '');
      }
      if (req.method === 'DELETE') {
        fs.rmSync(file, { force: true });
        return send(res, 204, '');
      }
      return send(res, 405, 'method not allowed');
    }
    // Estáticos con respaldo a index.html (aplicación de una sola página).
    let rel = decodeURIComponent(url.pathname);
    let target = path.join(root, rel);
    if (!target.startsWith(root)) return send(res, 403, 'forbidden');
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) target = path.join(root, 'index.html');
    const cache = target.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
    send(res, 200, fs.readFileSync(target), { 'Content-Type': TYPES[path.extname(target)] || 'application/octet-stream', 'Cache-Control': cache });
  } catch (e) {
    send(res, 400, String(e?.message || e));
  }
});

server.listen(port, () => console.log(`aws-lab escuchando en http://localhost:${port}  (datos en ${dataDir})`));
