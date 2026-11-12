// QA de extremo a extremo como un alumno: abre cada laboratorio de la Academia en la UI real, ejecuta su solución
// en el CloudShell (input #term-in) y verifica que todos los pasos quedan completados. Captura errores de página/consola.
//
// Uso (con vite en marcha: `npx vite --port 5221`):
//   node tests/e2e/walkthrough.mjs                       # completo en tema claro + muestra (1 lab/nivel) en oscuro
//   node tests/e2e/walkthrough.mjs --theme=dark --full   # completo en oscuro
//   node tests/e2e/walkthrough.mjs --levels=1,4 --theme=light --full
//   node tests/e2e/walkthrough.mjs --lab=l04-e2          # un solo laboratorio
// Opciones: --speed=fast|instant|realistic (velocidad del simulador; por defecto la de un alumno: fast) --base=http://localhost:5221  --workers=4  --out=/tmp/aws-lab-e2e  --headed
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/npm-tools/node_modules/playwright');

const arg = (k, d) => { const a = process.argv.find((x) => x === `--${k}` || x.startsWith(`--${k}=`)); return a === undefined ? d : a.includes('=') ? a.split('=')[1] : true; };
const BASE = arg('base', 'http://localhost:5221');
const WORKERS = Number(arg('workers', 4));
const OUT = arg('out', '/tmp/aws-lab-e2e');
const ONLY_LEVELS = arg('levels', '') ? String(arg('levels', '')).split(',').map(Number) : null;
const ONLY_LAB = arg('lab', '');
const THEME_ARG = arg('theme', 'both');
const FULL = !!arg('full', false);
const SPEED = arg('speed', 'fast');
fs.mkdirSync(OUT, { recursive: true });

// --- Extrae el currículo (id, pasos y script) sin duplicar datos: se pide a Vite que transforme el módulo y se evalúa en el navegador.
async function loadCurriculum(page) {
  await page.goto(BASE + '/#/academy', { waitUntil: 'load' });
  return page.evaluate(async () => {
    const m = await import('/src/ui/academy/content/index.ts');
    return m.LEVELS.map((l) => ({
      id: l.id,
      exercises: l.exercises.map((e) => ({ id: e.id, title: e.title, script: e.script, steps: e.steps.map((s) => ({ id: s.id, title: s.title, hints: s.hint === undefined ? 0 : Array.isArray(s.hint) ? s.hint.length : 1 })) })),
    }));
  });
}

async function setTheme(page, theme) {
  await page.getByRole('button', { name: 'Configuración' }).click();
  await page.getByRole('radio', { name: theme === 'dark' ? /Oscuro/ : /Claro/ }).click();
  await page.keyboard.press('Escape');
  await page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme);
}

async function runLab(browser, lvl, ex, theme) {
  const tag = `${theme}/${ex.id}`;
  const res = { tag, id: ex.id, theme, ok: false, problems: [], steps: ex.steps.length, done: 0 };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-ES' });
  await ctx.addInitScript(() => {
    localStorage.setItem('awslab.nologin', '1'); // se salta la pantalla de login
    // Modo libre (todos los niveles desbloqueados) solo la primera vez, sin pisar el progreso al recargar.
    if (!localStorage.getItem('awslab:progress:v1')) localStorage.setItem('awslab:progress:v1', JSON.stringify({ steps: {}, done: [], quiz: {}, xp: 0, freeMode: true, started: {}, read: [] }));
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => res.problems.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') res.problems.push('console.error: ' + m.text().slice(0, 300)); });
  page.on('dialog', (d) => d.accept());
  try {
    await page.goto(BASE + '/#/', { waitUntil: 'load' });
    if (theme === 'dark') await setTheme(page, 'dark');
    if (SPEED !== 'fast') await page.evaluate(async (v) => { const m = await import('/src/engine/store.ts'); m.mutate((st) => { st.settings.speed = v; }); }, SPEED);
    await page.evaluate((h) => { location.hash = h; }, `/academy/${lvl.id}/${ex.id}`);
    await page.waitForSelector('#term-in', { timeout: 40000 });
    await page.waitForSelector('.acad-stepitem', { timeout: 5000 });
    // Lo que haría un alumno: abrir todas las pistas y la solución (no deben romper nada).
    for (let i = 0; i < 8; i++) { const b = page.locator('.acad-hintbtn').first(); if (!(await b.count())) break; await b.click(); }
    await page.getByRole('button', { name: 'Ver solución' }).click();
    // Ninguna lista de pasos debería venir ya completa.
    const preDone = await page.locator('.acad-stepitem.done').count();
    if (preDone === ex.steps.length) res.problems.push('el laboratorio viene resuelto antes de empezar');
    await page.getByRole('button', { name: 'Ocultar solución' }).click();
    for (const line of ex.script) {
      const inp = page.locator('#term-in');
      await inp.fill(line);
      await inp.press('Enter');
      await page.waitForFunction(() => { const i = document.getElementById('term-in'); return i && i.value === '' && !document.querySelector('.cs-input.busy'); }, null, { timeout: 150000 });
      await page.waitForTimeout(40);
    }
    // Los pasos se evalúan solos (no hay botón «Comprobar» en los laboratorios; solo en el cuestionario).
    try {
      await page.waitForFunction((n) => document.querySelectorAll('.acad-stepitem.done').length === n, ex.steps.length, { timeout: 8000 });
    } catch { /* se informa abajo */ }
    res.done = await page.locator('.acad-stepitem.done').count();
    if (res.done !== ex.steps.length) {
      const pend = await page.locator('.acad-stepitem:not(.done)').allInnerTexts();
      res.problems.push(`pasos sin completar (${res.done}/${ex.steps.length}): ` + pend.map((t) => t.replace(/\s+/g, ' ').slice(0, 160)).join(' | '));
      const tail = (await page.locator('.cs-term').innerText()).split('\n').filter((l) => l.trim()).slice(-14).join(' ⏎ ');
      res.problems.push('final del terminal: ' + tail.slice(-900));
    } else if (!(await page.locator('.acad-done').count())) res.problems.push('todos los pasos hechos pero no aparece el panel «Laboratorio completado»');
    else {
      const txt = await page.locator('.acad-done').innerText();
      if (!/Repítelo en tu cuenta real/.test(txt)) res.problems.push('el panel final no muestra «Repítelo en tu cuenta real»');
    }
    // Desbordes horizontales groseros
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 4) res.problems.push(`desborde horizontal de ${over}px`);
    res.ok = res.problems.length === 0;
    if (!res.ok) await page.screenshot({ path: path.join(OUT, `${theme}-${ex.id}.png`), fullPage: false });
  } catch (e) {
    res.problems.push('excepción del script: ' + String(e.message).split('\n')[0]);
    try { await page.screenshot({ path: path.join(OUT, `${theme}-${ex.id}-excepcion.png`) }); } catch { /* */ }
  }
  await ctx.close();
  return res;
}

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: !arg('headed', false) });
const boot = await (await browser.newContext()).newPage();
const curriculum = await loadCurriculum(boot);
await boot.context().close();

const jobs = [];
const themes = THEME_ARG === 'both' ? ['light', 'dark'] : [THEME_ARG];
for (const th of themes) {
  const full = FULL || (THEME_ARG === 'both' ? th === 'light' : true);
  for (const lvl of curriculum) {
    if (ONLY_LEVELS && !ONLY_LEVELS.includes(lvl.id)) continue;
    const list = ONLY_LAB ? lvl.exercises.filter((e) => e.id === ONLY_LAB) : full ? lvl.exercises : lvl.exercises.slice(0, 1);
    for (const ex of list) jobs.push({ lvl, ex, th });
  }
}
console.log(`Laboratorios a recorrer: ${jobs.length} (temas: ${themes.join(', ')})`);
const results = [];
let next = 0;
await Promise.all(Array.from({ length: WORKERS }, async () => {
  while (next < jobs.length) {
    const j = jobs[next++];
    const r = await runLab(browser, j.lvl, j.ex, j.th);
    results.push(r);
    console.log(`${r.ok ? 'OK   ' : 'FALLA'} ${r.tag} (${r.done}/${r.steps})${r.ok ? '' : '\n   - ' + r.problems.join('\n   - ')}`);
  }
}));
await browser.close();
const bad = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(OUT, 'resultado.json'), JSON.stringify(results, null, 2));
console.log(`\nResumen: ${results.length - bad.length}/${results.length} correctos. Capturas e informe en ${OUT}`);
process.exit(bad.length ? 1 : 0);
