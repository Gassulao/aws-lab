import React, { useEffect, useRef, useState } from 'react';
import { Crumbs, nav } from '../../components/ui';
import { Terminal } from '../CloudShell';
import type { Level } from '../../academy/types';
import { levelStats, markLessonRead, quizCorrect, requiredToUnlock, unlocked } from '../../academy/progress';
import { LEVELS } from '../../academy/content';
import { getProgress, setProgress, useProgress } from '../../academy/store';
import { Md } from './Md';
import { Bar, ExMeta, IconArrowL, IconArrowR, IconBook, IconCheck, IconFlask, IconLock, IconQuiz, IconTerm, SaaPills, useProgressEff } from './common';

export function LockedLevel({ level }: { level: Level }) {
  const p = useProgressEff();
  const prev = LEVELS.find((l) => l.id === level.id - 1)!;
  const st = levelStats(p, prev);
  return (
    <div className="acad">
      <Crumbs items={[{ label: 'Academia', to: '/academy' }, { label: `Nivel ${level.id}` }]} />
      <div className="acad-locked">
        <IconLock size={34} />
        <h1>Nivel {level.id} · {level.title}</h1>
        <p>Este nivel está bloqueado. Completa <b>{requiredToUnlock(prev)}</b> de los {prev.exercises.length} laboratorios del Nivel {prev.id} (llevas {st.done}) para desbloquearlo.</p>
        <button className="btn primary" onClick={() => nav('/academy/' + prev.id)}>Ir al Nivel {prev.id}</button>
      </div>
    </div>
  );
}

export function LevelView({ level }: { level: Level }) {
  const p = useProgressEff();
  const st = levelStats(p, level);
  const q = p.quiz[level.id];
  return (
    <div className="acad">
      <Crumbs items={[{ label: 'Academia', to: '/academy' }, { label: `Nivel ${level.id}` }]} />
      <header className="acad-pagehead">
        <div>
          <div className="acad-eyebrow">Nivel {level.id} de {LEVELS.length}</div>
          <h1>{level.title}</h1>
          <p className="acad-sub">{level.subtitle}</p>
        </div>
        <div className="acad-pagehead-side">
          <div className="acad-big">{st.done}<small>/{st.total}</small></div>
          <div className="acad-muted">laboratorios completados</div>
          <Bar percent={st.percent} label="Progreso del nivel" />
        </div>
      </header>

      <section className="acad-section" aria-labelledby="sec-lessons">
        <h2 id="sec-lessons" className="acad-h2"><IconBook size={18} /> Lecciones</h2>
        <ol className="acad-lessons">
          {level.lessons.map((l, i) => (
            <li key={l.id}>
              <a href={`#/academy/${level.id}/${l.id}`}>
                <span className="acad-num">{p.read.includes(l.id) ? <IconCheck size={14} /> : i + 1}</span>
                <span className="acad-lesson-title">{l.title}</span>
                <span className="acad-muted">{l.minutes} min</span>
              </a>
            </li>
          ))}
        </ol>
      </section>

      <section className="acad-section" aria-labelledby="sec-labs">
        <h2 id="sec-labs" className="acad-h2"><IconFlask size={18} /> Laboratorios <span className="acad-count">{st.done}/{st.total}</span></h2>
        <div className="acad-labs">
          {level.exercises.map((e, i) => {
            const done = p.done.includes(e.id);
            const prog = p.steps[e.id]?.length ?? 0;
            const status = done ? 'done' : prog > 0 || p.started[e.id] !== undefined ? 'doing' : 'todo';
            return (
              <a key={e.id} className={'acad-lab-card ' + status} href={`#/academy/${level.id}/${e.id}`}>
                <span className="acad-num lg">{done ? <IconCheck size={16} /> : i + 1}</span>
                <span className="acad-lab-body">
                  <b>{e.title}</b>
                  <span className="acad-muted">{e.summary}</span>
                  <span className="acad-pills"><SaaPills e={e} /></span>
                </span>
                <span className="acad-lab-side">
                  <ExMeta e={e} />
                  <span className={'acad-status ' + status}>{status === 'done' ? 'Completado' : status === 'doing' ? `En curso${prog ? ` · ${prog}/${e.steps.length}` : ''}` : 'Pendiente'}</span>
                </span>
              </a>
            );
          })}
        </div>
      </section>

      <section className="acad-section" aria-labelledby="sec-quiz">
        <h2 id="sec-quiz" className="acad-h2"><IconQuiz size={18} /> Cuestionario tipo SAA-C03</h2>
        <div className="acad-quizcard">
          <div>
            <b>{level.quiz.length} preguntas</b> de examen sobre lo visto en este nivel, con explicación de cada respuesta.
            <div className="acad-muted">{q ? `Tu mejor resultado: ${quizCorrect(level, q)}/${level.quiz.length} aciertos.` : 'Aún no lo has hecho.'}</div>
          </div>
          <button className="btn" onClick={() => nav(`/academy/${level.id}/quiz`)}>{q ? 'Repetir cuestionario' : 'Hacer el cuestionario'}</button>
        </div>
      </section>
      {level.id < LEVELS.length && (
        <p className="acad-muted acad-unlock">{unlocked(p, LEVELS, level.id + 1) ? `El Nivel ${level.id + 1} está desbloqueado.` : `Completa ${requiredToUnlock(level)} laboratorios para desbloquear el Nivel ${level.id + 1}.`}</p>
      )}
    </div>
  );
}

export function LessonView({ level, index }: { level: Level; index: number }) {
  useProgress();
  const lesson = level.lessons[index];
  const [term, setTerm] = useState(false);
  const termRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setProgress(markLessonRead(getProgress(), lesson.id)); }, [lesson.id]);
  const prev = level.lessons[index - 1];
  const next = level.lessons[index + 1];
  const openTerm = async () => {
    if (!term) {
      setTerm(true);
      await new Promise((r) => setTimeout(r, 120));
    }
  };
  return (
    <div className="acad">
      <Crumbs items={[{ label: 'Academia', to: '/academy' }, { label: `Nivel ${level.id}`, to: '/academy/' + level.id }, { label: lesson.title }]} />
      <div className="acad-lesson-layout">
        <nav className="acad-toc" aria-label="Lecciones del nivel">
          <div className="acad-eyebrow">Nivel {level.id} · {level.title}</div>
          <ol>
            {level.lessons.map((l, i) => (
              <li key={l.id} className={i === index ? 'on' : ''}>
                <a href={`#/academy/${level.id}/${l.id}`} aria-current={i === index ? 'page' : undefined}>
                  <span className="acad-num">{getProgress().read.includes(l.id) && i !== index ? <IconCheck size={13} /> : i + 1}</span>
                  <span>{l.title}</span>
                </a>
              </li>
            ))}
          </ol>
          <a className="acad-toc-link" href={`#/academy/${level.id}`}><IconFlask size={14} /> Laboratorios y cuestionario</a>
        </nav>
        <article className="acad-lesson">
          <div className="acad-eyebrow">Lección {index + 1} de {level.lessons.length} · {lesson.minutes} min de lectura</div>
          <h1>{lesson.title}</h1>
          <Md src={lesson.body} onRun={openTerm} />
          <div className="acad-pager">
            {prev ? <button className="btn" onClick={() => nav(`/academy/${level.id}/${prev.id}`)}><IconArrowL size={14} /> {prev.title}</button> : <span />}
            {next ? (
              <button className="btn primary" onClick={() => nav(`/academy/${level.id}/${next.id}`)}>{next.title} <IconArrowR size={14} /></button>
            ) : (
              <button className="btn primary" onClick={() => nav(`/academy/${level.id}`)}>Ir a los laboratorios <IconArrowR size={14} /></button>
            )}
          </div>
        </article>
      </div>
      <div className={'acad-drawer ' + (term ? 'open' : '')} ref={termRef}>
        <button className="acad-drawer-tab" onClick={() => setTerm(!term)} aria-expanded={term}>
          <IconTerm size={15} /> Terminal {term ? '· ocultar' : '· abrir para probar los comandos'}
        </button>
        {term && <div className="acad-drawer-body"><Terminal height="250px" /></div>}
      </div>
    </div>
  );
}
