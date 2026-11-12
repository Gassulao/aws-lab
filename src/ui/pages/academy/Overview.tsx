import React from 'react';
import { Crumbs, nav } from '../../components/ui';
import { LEVELS } from '../../academy/content';
import { RANKS, levelStats, maxXp, nextExercise, quizCorrect, rankOf, requiredToUnlock, unlocked } from '../../academy/progress';
import { getProgress, resetProgress, setProgress, useProgress } from '../../academy/store';
import { Bar, IconArrowR, IconBook, IconFlask, IconLock, IconQuiz, useProgressEff } from './common';

export function Overview() {
  const raw = useProgress();
  const p = useProgressEff();
  const rank = rankOf(p.xp);
  const next = nextExercise(p, LEVELS);
  const totalLabs = LEVELS.reduce((n, l) => n + l.exercises.length, 0);
  const doneLabs = p.done.length;
  const totalLessons = LEVELS.reduce((n, l) => n + l.lessons.length, 0);
  const readLessons = p.read.length;
  const started = doneLabs > 0 || p.read.length > 0 || Object.keys(p.started).length > 0;
  return (
    <div className="acad">
      <Crumbs items={[{ label: 'Academia' }]} />
      <div className="acad-hero">
        <div className="acad-hero-main">
          <div className="acad-rank-badge" aria-hidden="true">{rank.index + 1}</div>
          <div className="acad-hero-text">
            <div className="acad-eyebrow">Tu rango</div>
            <h1>{rank.current.name}</h1>
            <div className="acad-xp-line"><b>{p.xp} XP</b>{rank.next ? <> · te faltan <b>{rank.toNext} XP</b> para «{rank.next.name}»</> : <> · has alcanzado el rango máximo</>}</div>
            <Bar percent={rank.percent} label="Progreso hacia el siguiente rango" />
            <div className="acad-ladder" aria-label="Rangos">
              {RANKS.map((r, i) => (
                <span key={r.name} className={'acad-step ' + (i < rank.index ? 'past' : i === rank.index ? 'now' : '')} title={`${r.name} · desde ${r.min} XP`}>
                  <i />{r.name}<small>{r.min} XP</small>
                </span>
              ))}
            </div>
          </div>
        </div>
        <div className="acad-hero-side">
          <dl className="acad-stats">
            <div><dt>Laboratorios</dt><dd>{doneLabs}<small>/{totalLabs}</small></dd></div>
            <div><dt>Lecciones</dt><dd>{readLessons}<small>/{totalLessons}</small></dd></div>
            <div><dt>XP máximo</dt><dd>{maxXp(LEVELS)}</dd></div>
          </dl>
          {next ? (
            <button className="btn primary" onClick={() => nav(`/academy/${next.level.id}/${next.exercise.id}`)}>
              {started ? 'Continuar' : 'Empezar'}: {next.exercise.title} <IconArrowR size={14} />
            </button>
          ) : (
            <div className="acad-allclear">Has completado todos los laboratorios.</div>
          )}
        </div>
      </div>

      <h2 className="acad-h2">Niveles</h2>
      <div className="acad-levels">
        {LEVELS.map((l) => {
          const st = levelStats(p, l);
          const open = unlocked(p, LEVELS, l.id);
          const prev = LEVELS.find((x) => x.id === l.id - 1);
          const q = raw.quiz[l.id];
          const go = () => open && nav('/academy/' + l.id);
          return (
            <article key={l.id} className={'acad-level ' + (open ? '' : 'locked')} aria-disabled={!open}>
              <div className="acad-level-head">
                <span className="acad-level-num">{open ? l.id : <IconLock size={18} />}</span>
                <div>
                  <h3><a href={open ? '#/academy/' + l.id : undefined} onClick={(e) => { e.preventDefault(); go(); }}>Nivel {l.id} · {l.title}</a></h3>
                  <p>{l.subtitle}</p>
                </div>
              </div>
              <div className="acad-skills">{l.skills.map((s) => <span key={s} className="acad-tag">{s}</span>)}</div>
              <div className="acad-level-counts">
                <span><IconBook size={14} /> {l.lessons.length} lecciones</span>
                <span><IconFlask size={14} /> {st.done}/{st.total} laboratorios</span>
                <span><IconQuiz size={14} /> {q ? `${quizCorrect(l, q)}/${l.quiz.length} aciertos` : `${l.quiz.length} preguntas`}</span>
              </div>
              <Bar percent={st.percent} label={`Progreso del nivel ${l.id}`} />
              <div className="acad-level-foot">
                {open ? (
                  <button className={'btn small ' + (st.done ? '' : 'primary')} onClick={go}>{st.done ? (st.done === st.total ? 'Repasar' : 'Continuar') : 'Empezar'}</button>
                ) : (
                  <span className="acad-lockmsg"><IconLock size={14} /> Termina {prev ? requiredToUnlock(prev) : 0} de {prev?.exercises.length} laboratorios del Nivel {l.id - 1} para desbloquearlo.</span>
                )}
                <span className="acad-pct">{st.percent}%</span>
              </div>
            </article>
          );
        })}
      </div>

      <div className="acad-options">
        <label>
          <input type="checkbox" checked={raw.freeMode} onChange={(e) => setProgress({ ...getProgress(), freeMode: e.target.checked })} />
          Modo libre: desbloquear todos los niveles
        </label>
        <button className="btn link small" onClick={() => { if (confirm('¿Borrar todo el progreso de la Academia (XP, laboratorios y cuestionarios)? La nube simulada no se toca.')) resetProgress(); }}>Borrar progreso</button>
      </div>
    </div>
  );
}
