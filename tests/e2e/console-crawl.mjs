// Rastreo de la consola: recorre todas las rutas de todos los servicios (menú, listas, detalle, crear) y busca
// pantallas en blanco, errores de render, enlaces rotos (404 de la consola), botones sin efecto, errores de consola/página,
// textos en inglés sospechosos y desbordes horizontales. Opcionalmente siembra recursos ejecutando laboratorios de la Academia.
//
// Uso (con vite en marcha): node tests/e2e/console-crawl.mjs [--theme=light|dark] [--seed=l04-e1,l07-e2,...] [--max=400] [--out=/tmp/aws-lab-crawl] [--nobuttons]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const arg = (k, d) => { const a = process.argv.find((x) => x === `--${k}` || x.startsWith(`--${k}=`)); return a === undefined ? d : a.includes('=') ? a.split('=')[1] : true; };
const BASE = arg('base', 'http://localhost:5221');
const THEME = arg('theme', 'light');
const OUT = arg('out', '/tmp/aws-lab-crawl');
const MAX = Number(arg('max', 400));
const SEED = String(arg('seed', '')).split(',').filter(Boolean);
const BUTTONS = !arg('nobuttons', false);
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-ES' });
await ctx.addInitScript(() => {
  localStorage.setItem('awslab.nologin', '1');
  if (!localStorage.getItem('awslab:progress:v1')) localStorage.setItem('awslab:progress:v1', JSON.stringify({ steps: {}, done: [], quiz: {}, xp: 0, freeMode: true, started: {}, read: [] }));
});
const page = await ctx.newPage();
let current = '(inicio)';
const findings = [];
const add = (kind, route, msg) => { const k = kind + '|' + route + '|' + msg; if (!findings.some((f) => f.k === k)) findings.push({ k, kind, route, msg }); };
page.on('pageerror', (e) => add('pageerror', current, e.message));
page.on('console', (m) => { if (m.type() === 'error') add('console.error', current, m.text().slice(0, 250)); });
page.on('dialog', (d) => d.dismiss());

const go = async (hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(120); };
const runLine = async (line) => {
  const inp = page.locator('#term-in'); await inp.fill(line); await inp.press('Enter');
  await page.waitForFunction(() => { const i = document.getElementById('term-in'); return i && i.value === '' && !document.querySelector('.cs-input.busy'); }, null, { timeout: 150000 });
};

await page.goto(BASE + '/#/', { waitUntil: 'load' });
if (THEME === 'dark') {
  await page.getByRole('button', { name: 'Configuración' }).click();
  await page.getByRole('radio', { name: /Oscuro/ }).click();
  await page.keyboard.press('Escape');
}
await page.evaluate(async () => { const m = await import('/src/engine/store.ts'); m.mutate((st) => { st.settings.speed = 'instant'; }); });
const cur = await page.evaluate(async () => {
  const c = await import('/src/ui/academy/content/index.ts');
  const s = await import('/src/ui/services.ts');
  return { labs: c.LEVELS.flatMap((l) => l.exercises.map((e) => ({ lvl: l.id, id: e.id, script: e.script }))), svcs: s.SERVICES.map((x) => ({ id: x.id, home: x.home, nav: x.nav.filter((n) => n.to).map((n) => n.to) })) };
});
// Siembra: cada laboratorio prepara su escenario al abrirse; después se ejecuta su solución.
for (const id of SEED) {
  const lab = cur.labs.find((l) => l.id === id);
  if (!lab) continue;
  current = 'seed ' + id;
  await go(`/academy/${lab.lvl}/${lab.id}`);
  try {
    await page.waitForSelector('#term-in', { timeout: 15000 });
    for (const line of lab.script) await runLine(line);
    await page.waitForTimeout(300);
  } catch (e) { add('seed', id, String(e.message).split('\n')[0]); }
}

const seen = new Map(); // patrón -> veces
const key = (p) => p.replace(/\/(i-|sg-|vpc-|subnet-|rtb-|igw-|nat-|eipalloc-|vol-|snap-|ami-|lt-|lb-|tg-|asg-)[\w-]+/g, '/$1*').replace(/\/[0-9a-f-]{12,}/g, '/*');
const queue = [];
const push = (p) => { p = p.replace(/^#/, ''); if (!p.startsWith('/')) p = '/' + p; const k = key(p); if (seen.get(k) >= 2 || queue.includes(p)) return; seen.set(k, (seen.get(k) ?? 0) + 1); queue.push(p); };
push('/'); push('/cloudshell');
for (const s of cur.svcs) { push(s.home); push('/' + s.id); s.nav.forEach(push); }

const ENG = /\b(Create|Delete|Cancel|Name|Status|Actions|Description|Loading|Save|Edit|Remove|Add|Select|Search|Details|Learn more|Next|Previous|Back|Submit|Close|Required|Optional|Enabled|Disabled|Refresh|Upload|Download|Copy|View)\b/;
const ES_HINT = /\b(de|del|el|la|las|los|un|una|con|para|por|en|que|se|su|sus|al)\b|[áéíóúñ¿¡]/i;
let visited = 0;
const routes = [];
async function visit(p) {
  visited++; if (visited % 25 === 0) console.error("... rutas", visited, "pendientes", queue.length);
  current = p;
  await go(p);
  await page.waitForTimeout(150);
  const info = await page.evaluate(() => {
    const main = document.querySelector('main.main');
    const txt = (main?.innerText ?? '').trim();
    const links = [...document.querySelectorAll('main.main a[href^="#/"], .sidenav a[href^="#/"]')].map((a) => a.getAttribute('href'));
    const btns = [...(main?.querySelectorAll('button:not([disabled]), [role="button"]:not([aria-disabled="true"])') ?? [])].filter((b) => b.offsetParent !== null).map((b, i) => ({ i, t: (b.innerText || b.getAttribute('aria-label') || b.title || '').trim().slice(0, 60) }));
    const eng = [];
    const w = document.createTreeWalker(main ?? document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) { const t = n.nodeValue.trim(); if (t.length > 1 && t.length < 120 && n.parentElement && n.parentElement.offsetParent !== null && !['CODE', 'PRE', 'SCRIPT', 'STYLE'].includes(n.parentElement.tagName) && !n.parentElement.closest('.cs-term,code,pre')) eng.push(t); }
    const over = main ? main.scrollWidth - main.clientWidth : 0;
    const wide = [...(main?.querySelectorAll('*') ?? [])].filter((e) => e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflowX === 'visible' && e.getBoundingClientRect().right > innerWidth + 2).slice(0, 3).map((e) => e.tagName + '.' + String(e.className).slice(0, 40));
    return { len: txt.length, notfound: /No se encuentra la página/.test(txt), crashed: /Algo ha fallado al mostrar/.test(txt), hash: location.hash, links, btns, eng, over, wide, head: (main?.querySelector('h1')?.innerText ?? '').slice(0, 60), sample: txt.slice(0, 80) };
  });
  routes.push({ p, head: info.head, len: info.len });
  if (info.crashed) add('crash', p, 'ErrorBoundary: la página falla al renderizar');
  else if (info.notfound) add('404', p, 'ruta inexistente (enlace roto)');
  else if (info.len < 25) add('blanco', p, `pantalla casi vacía (${info.len} caracteres)`);
  if (info.over > 4) add('desborde', p, `desborde horizontal de main: ${info.over}px`);
  if (info.wide.length) add('desborde', p, 'elementos fuera de la pantalla: ' + info.wide.join(', '));
  const bad = [...new Set(info.eng.filter((t) => ENG.test(t) && !ES_HINT.test(t)))].slice(0, 6);
  if (bad.length) add('ingles?', p, bad.map((t) => `«${t}»`).join(' · '));
  if (info.hash.replace(/^#/, '') !== p && !info.notfound) add('redireccion', p, `terminó en ${info.hash}`);
  for (const l of info.links) push(l);
  if (!BUTTONS) return;
  const total = Math.min(info.btns.length, 8);
  for (let b = 0; b < total; b++) {
    const label = info.btns[b].t;
    const before = await page.evaluate((i) => { const el = [...document.querySelectorAll('main.main button:not([disabled]), main.main [role="button"]:not([aria-disabled="true"])')].filter((x) => x.offsetParent !== null)[i]; return el ? { h: location.hash, html: document.body.innerHTML.length, mh: (document.querySelector('main.main')?.innerHTML ?? '').length, ov: !!document.querySelector('.modal,[role=dialog]') } : null; }, b);
    if (!before) break;
    const dialogs = [];
    const onDlg = (d) => dialogs.push(d.type());
    page.on('dialog', onDlg);
    await page.evaluate((i) => { const el = [...document.querySelectorAll('main.main button:not([disabled]), main.main [role="button"]:not([aria-disabled="true"])')].filter((x) => x.offsetParent !== null)[i]; el?.click(); }, b);
    await page.waitForTimeout(220);
    page.off('dialog', onDlg);
    const after = await page.evaluate(() => ({ h: location.hash, html: document.body.innerHTML.length, mh: (document.querySelector('main.main')?.innerHTML ?? '').length, ov: !!document.querySelector('.modal,[role=dialog]'), crashed: /Algo ha fallado al mostrar/.test(document.body.innerText), text: document.body.innerText.length }));
    if (after.crashed) add('crash', p, `al pulsar «${label}» la página falla`);
    const changed = after.h !== before.h || after.html !== before.html || after.mh !== before.mh || after.ov !== before.ov || dialogs.length;
    if (!changed && label && !/^(Copiar|Copy)$/.test(label)) add('boton-sin-efecto', p, `«${label}»`);
    if (after.h !== before.h) { push(after.h); }
    if (changed) { await go(p); await page.waitForTimeout(100); }
  }
}
while (queue.length && visited < MAX) {
  const p = queue.shift();
  try { await visit(p); } catch (e) { add('excepcion-script', p, String(e.message).split('\n')[0]); try { await page.goto(BASE + '/#/', { waitUntil: 'load' }); } catch { /* */ } }
}
await browser.close();
const out = { visited, routes, findings: findings.map(({ kind, route, msg }) => ({ kind, route, msg })) };
fs.writeFileSync(path.join(OUT, `crawl-${THEME}.json`), JSON.stringify(out, null, 2));
const by = {};
for (const f of out.findings) (by[f.kind] ??= []).push(f);
console.log(`Rutas visitadas: ${visited}. Hallazgos: ${out.findings.length}`);
for (const [k, l] of Object.entries(by)) { console.log(`\n## ${k} (${l.length})`); for (const f of l) console.log(`- ${f.route}: ${f.msg}`); }
