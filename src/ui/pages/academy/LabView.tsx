import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Crumbs, nav } from '../../components/ui';
import { useCloud, getShell } from '../../session';
import { getState, mutate, resetCloud } from '../../../engine/store';
import { Terminal } from '../CloudShell';
import { CheckCtx } from '../../academy/checks';
import { LEVELS } from '../../academy/content';
import { solutionMarkdown, type Exercise, type Level, type Step } from '../../academy/types';
import { completeExercise, markStep, rankOf, restartExercise, startExercise, xpOf } from '../../academy/progress';
import { getProgress, setProgress, useProgress } from '../../academy/store';
import { CmdBlock, Md, MdInline } from './Md';
import { Bar, DiffBadge, ExMeta, IconArrowR, IconBulb, IconCheck, IconReset, IconTerm, SaaPills } from './common';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Se evita preparar dos veces el mismo escenario (p. ej. doble montaje en desarrollo).
const inflight = new Map<string, Promise<void>>();

/** Prepara el escenario del laboratorio y fija el momento de inicio: los comandos anteriores no cuentan. */
function prepare(ex: Exercise, force: boolean): Promise<void> {
  const cur = inflight.get(ex.id);
  if (cur) return cur;
  const job = (async () => {
    if (force) resetCloud(); // el aviso 'cloud:reset' borra los inicios guardados
    if (ex.setup) await ex.setup(getShell());
    await sleep(8); // el instante de inicio queda estrictamente después de los eventos del escenario
    mutate(() => {});
    setProgress(force ? restartExercise(getProgress(), ex.id, Date.now()) : startExercise(getProgress(), ex.id, Date.now()));
  })();
  inflight.set(ex.id, job);
  const clear = () => inflight.delete(ex.id);
  job.then(clear, clear);
  return job;
}

/** Re-evalúa los pasos tras cada comando: la terminal anota el comando después de que el motor avise del cambio. */
function useLabTick(active: boolean) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const sig = useRef('');
  useEffect(() => {
    if (!active) return;
    const look = (persist: boolean) => {
      const s = getState();
      const last = s.cli.commandLog[s.cli.commandLog.length - 1];
      const now = `${s.cli.commandLog.length}:${last?.ts}:${s.trail.length}`;
      if (now !== sig.current) {
        sig.current = now;
        if (persist) mutate(() => {}); // guarda la nube y avisa a toda la interfaz
        force();
      }
    };
    look(false);
    const quick = () => { for (const ms of [60, 250, 800]) setTimeout(() => look(true), ms); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Enter' && (e.target as HTMLElement)?.id === 'term-in') quick(); };
    document.addEventListener('keydown', key, true);
    const poll = setInterval(() => look(true), 500);
    const clock = setInterval(force, 1500); // transiciones de estado por tiempo (pending → running…)
    return () => { document.removeEventListener('keydown', key, true); clearInterval(poll); clearInterval(clock); };
  }, [active]);
}

const looksLikeCmd = (h: string) => /^(aws|curl|echo|export|unset|cat|jq|ls|cd)\s/.test(h.trim());

function safeCheck(st: Step, ctx: CheckCtx): boolean | string {
  try {
    return st.check(ctx);
  } catch (e) {
    return 'No se pudo comprobar este paso: ' + (e as Error).message;
  }
}

function nextAfter(level: Level, ex: Exercise): { label: string; to: string } {
  const i = level.exercises.findIndex((e) => e.id === ex.id);
  const n = level.exercises[i + 1];
  if (n) return { label: `Siguiente laboratorio: ${n.title}`, to: `/academy/${level.id}/${n.id}` };
  return { label: 'Hacer el cuestionario del nivel', to: `/academy/${level.id}/quiz` };
}

export function LabView({ level, ex }: { level: Level; ex: Exercise }) {
  const s = useCloud();
  const p = useProgress();
  const [phase, setPhase] = useState<'prep' | 'ready' | 'error'>(p.started[ex.id] !== undefined ? 'ready' : 'prep');
  const [error, setError] = useState('');
  const [resetN, setResetN] = useState(0);
  const [hints, setHints] = useState<Record<string, number>>({});
  const [showSol, setShowSol] = useState(false);
  const wasDone = useRef(p.done.includes(ex.id));
  const xpAtOpen = useRef(p.xp);
  const doneRef = useRef<HTMLElement>(null);

  const start = useCallback((force: boolean) => {
    setPhase('prep');
    setError('');
    prepare(ex, force).then(() => setPhase('ready'), (e: Error) => { setError(e.message); setPhase('error'); });
  }, [ex]);

  useEffect(() => {
    if (getProgress().started[ex.id] === undefined) start(false);
    else setPhase('ready');
  }, [ex.id, start]);

  const reset = () => {
    if (!confirm('Reiniciar el laboratorio restablece TODA la cuenta simulada a su estado inicial y vuelve a preparar el escenario. El XP que ya hayas ganado se conserva.\n\n¿Continuar?')) return;
    setHints({});
    setShowSol(false);
    setResetN((n) => n + 1);
    start(true);
  };

  const since = p.started[ex.id];
  const ready = phase === 'ready' && since !== undefined;
  useLabTick(ready);

  const ctx = new CheckCtx(s, since ?? Number.MAX_SAFE_INTEGER);
  const completed = p.done.includes(ex.id);
  const results = ex.steps.map((st) => {
    const live = ready ? safeCheck(st, ctx) : 'Preparando el escenario…';
    const sticky = completed && (p.steps[ex.id] ?? []).includes(st.id);
    return { st, r: live === true || sticky ? (true as const) : live };
  });
  const doneCount = results.filter((x) => x.r === true).length;
  const all = ready && doneCount === ex.steps.length;
  const firstPending = results.findIndex((x) => x.r !== true);

  // Persistencia del progreso (pasos y finalización). Solo escribe si algo cambió.
  useEffect(() => {
    if (!ready) return;
    let pr = getProgress();
    for (const x of results) if (x.r === true) pr = markStep(pr, ex.id, x.st.id);
    if (all) pr = completeExercise(pr, level, ex.id);
    setProgress(pr);
  });

  const justDone = all && !wasDone.current;
  const gained = justDone ? p.xp - xpAtOpen.current : 0;
  const rankBefore = rankOf(xpAtOpen.current);
  const rankNow = rankOf(p.xp);
  useEffect(() => {
    if (justDone) doneRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [justDone]);

  const next = nextAfter(level, ex);
  return (
    <div className="acad acad-lab">
      <Crumbs items={[{ label: 'Academia', to: '/academy' }, { label: `Nivel ${level.id}`, to: '/academy/' + level.id }, { label: ex.title }]} />
      <header className="acad-labhead">
        <div className="acad-labhead-main">
          <h1>{ex.title}</h1>
          <div className="acad-labhead-meta"><ExMeta e={ex} /><SaaPills e={ex} /></div>
        </div>
        <div className="acad-labhead-actions">
          <button className="btn small" onClick={reset} title="Restablece la cuenta simulada y vuelve a preparar el escenario"><IconReset size={14} /> Reiniciar laboratorio</button>
        </div>
      </header>

      <div className="acad-labgrid">
        <div className="acad-lableft" tabIndex={-1}>
          {phase === 'error' && (
            <div className="acad-alert err" role="alert">
              <b>No se pudo preparar el escenario</b>
              <p>{error}</p>
              <p>Suele pasar si ya existen recursos de otros laboratorios. Reinicia el laboratorio para empezar con una cuenta limpia.</p>
              <button className="btn small primary" onClick={reset}>Reiniciar laboratorio</button>
            </div>
          )}

          {all && (
            <section className="acad-done" ref={doneRef} aria-live="polite">
              <div className="acad-done-head">
                <span className="acad-done-icon"><IconCheck size={22} /></span>
                <div>
                  <h2>{justDone ? '¡Laboratorio completado!' : 'Laboratorio completado'}</h2>
                  <div className="acad-done-xp">
                    {justDone ? <span className="acad-xpgain">+{gained || xpOf(ex)} XP</span> : <span className="acad-chip">XP ya obtenido ({xpOf(ex)})</span>}
                    {justDone && rankNow.index > rankBefore.index && <span className="acad-rankup">Nuevo rango: {rankNow.current.name}</span>}
                    <span className="acad-muted">{p.xp} XP en total · {rankNow.current.name}</span>
                  </div>
                </div>
              </div>
              {ex.wrapUp && <Md src={ex.wrapUp} />}
              {ex.realWorld && (
                <div className="acad-real">
                  <h3>Repítelo en tu cuenta real</h3>
                  <Md src={ex.realWorld} />
                </div>
              )}
              <div className="acad-done-actions">
                <button className="btn primary" onClick={() => nav(next.to)}>{next.label} <IconArrowR size={14} /></button>
                <button className="btn" onClick={() => nav('/academy/' + level.id)}>Volver al nivel</button>
              </div>
            </section>
          )}

          <section className="acad-card">
            <h2>Escenario</h2>
            <Md src={ex.scenario} />
          </section>

          <section className="acad-card">
            <div className="acad-steps-head">
              <h2>Pasos</h2>
              <span className="acad-muted">{doneCount} de {ex.steps.length} completados</span>
            </div>
            <Bar percent={(doneCount / ex.steps.length) * 100} label="Progreso del laboratorio" />
            <ol className="acad-steps">
              {results.map(({ st, r }, i) => {
                const done = r === true;
                const active = i === firstPending;
                const hs = st.hint === undefined ? [] : Array.isArray(st.hint) ? st.hint : [st.hint];
                const shown = hints[st.id] ?? 0;
                return (
                  <li key={st.id} className={'acad-stepitem ' + (done ? 'done' : active ? 'active' : '')}>
                    <span className="acad-dot" aria-label={done ? 'Completado' : 'Pendiente'}>{done ? <IconCheck size={13} /> : i + 1}</span>
                    <div className="acad-stepbody">
                      <div className="acad-steptitle"><MdInline src={st.title} /></div>
                      {!done && st.detail && <div className="acad-stepdetail"><MdInline src={st.detail} /></div>}
                      {!done && active && typeof r === 'string' && ready && <div className="acad-stepwhy">{r}</div>}
                      {!done && hs.slice(0, shown).map((h, k) => (
                        <div key={k} className="acad-hint"><IconBulb size={14} />{looksLikeCmd(h) ? <CmdBlock cmd={h} /> : <MdInline src={h} />}</div>
                      ))}
                      {!done && hs.length > 0 && shown < hs.length && (
                        <button className="acad-hintbtn" onClick={() => setHints({ ...hints, [st.id]: shown + 1 })}>
                          <IconBulb size={13} /> {shown === 0 ? 'Ver una pista' : 'Otra pista'} ({shown + 1}/{hs.length})
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>

          <section className="acad-card">
            <div className="acad-steps-head">
              <h2>Solución de referencia</h2>
              <button className="btn small" onClick={() => setShowSol(!showSol)} aria-expanded={showSol}>{showSol ? 'Ocultar solución' : 'Ver solución'}</button>
            </div>
            {!showSol && <p className="acad-muted">Inténtalo primero con las pistas. Si te atascas, aquí tienes la solución completa; puedes pegarla en la terminal con «Probar en la terminal».</p>}
            {showSol && <Md src={solutionMarkdown(ex)} />}
          </section>

          {!all && ex.realWorld && <p className="acad-muted acad-realhint">Al terminar verás cómo repetirlo en tu cuenta real y qué limpiar para no pagar.</p>}
        </div>

        <div className="acad-labright">
          <div className="acad-termcard">
            <div className="acad-termhead"><IconTerm size={15} /> Terminal · CloudShell <span className="acad-muted">perfil {s.cli.activeProfile} · {s.region}</span></div>
            <div className="acad-termwrap">
              {phase === 'ready' ? <Terminal key={resetN} height="calc(100vh - 290px)" /> : <div className="acad-termwait">{phase === 'prep' ? 'Preparando el escenario…' : 'Escenario no disponible'}</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export { DiffBadge, LEVELS };
