import React, { useRef, useState } from 'react';
import { Crumbs, nav } from '../../components/ui';
import type { Level } from '../../academy/types';
import { SAA_DOMAINS } from '../../academy/types';
import { XP_QUIZ_CORRECT, answerQuiz, quizCorrect, rankOf } from '../../academy/progress';
import { getProgress, setProgress, useProgress } from '../../academy/store';
import { Bar, IconArrowR, IconCheck } from './common';

export function Quiz({ level }: { level: Level }) {
  const p = useProgress();
  const prior = p.quiz[level.id];
  const [i, setI] = useState(0);
  const [answers, setAnswers] = useState<number[]>([]);
  const [checked, setChecked] = useState(false);
  const [finished, setFinished] = useState<number[] | null>(prior && prior.length === level.quiz.length ? prior : null);
  const xpBefore = useRef(p.xp);
  const n = level.quiz.length;
  const q = level.quiz[i];
  const chosen = answers[i];

  const restart = () => { setAnswers([]); setI(0); setChecked(false); setFinished(null); xpBefore.current = getProgress().xp; };
  const advance = () => {
    if (i + 1 < n) { setI(i + 1); setChecked(false); return; }
    const final = level.quiz.map((_, k) => answers[k] ?? -1);
    setProgress(answerQuiz(getProgress(), level, final));
    setFinished(final);
  };

  const crumbs = <Crumbs items={[{ label: 'Academia', to: '/academy' }, { label: `Nivel ${level.id}`, to: '/academy/' + level.id }, { label: 'Cuestionario' }]} />;

  if (finished) {
    const score = quizCorrect(level, finished);
    const percent = Math.round((score / n) * 100);
    const gain = p.xp - xpBefore.current;
    const wrong = level.quiz.map((qq, k) => ({ qq, k })).filter(({ qq, k }) => finished[k] !== qq.answer);
    const byDomain = ([1, 2, 3, 4] as const).map((d) => {
      const list = level.quiz.map((qq, k) => ({ qq, k })).filter(({ qq }) => qq.domain === d);
      return { d, total: list.length, ok: list.filter(({ qq, k }) => finished[k] === qq.answer).length };
    }).filter((x) => x.total);
    return (
      <div className="acad">
        {crumbs}
        <div className="acad-quizsum">
          <div className={'acad-score ' + (percent >= 70 ? 'ok' : 'low')}>
            <b>{score}</b><small>/{n}</small>
          </div>
          <div>
            <h1>{percent >= 90 ? 'Excelente' : percent >= 70 ? 'Aprobado' : 'Todavía puedes mejorar'}</h1>
            <p className="acad-sub">{score} de {n} respuestas correctas ({percent}%). Cada acierto vale {XP_QUIZ_CORRECT} XP; solo ganas XP al mejorar tu mejor resultado.</p>
            {gain > 0 && <span className="acad-xpgain">+{gain} XP</span>} <span className="acad-muted">Rango actual: {rankOf(p.xp).current.name} · {p.xp} XP</span>
          </div>
        </div>
        {byDomain.length > 0 && (
          <section className="acad-card">
            <h2>Por dominio del examen SAA-C03</h2>
            {byDomain.map(({ d, total, ok }) => (
              <div key={d} className="acad-domain"><span>{SAA_DOMAINS[d]}</span><Bar percent={(ok / total) * 100} /><b>{ok}/{total}</b></div>
            ))}
          </section>
        )}
        {wrong.length > 0 && (
          <section className="acad-card">
            <h2>Repasa lo que fallaste</h2>
            {wrong.map(({ qq, k }) => (
              <div key={k} className="acad-review">
                <b>{k + 1}. {qq.q}</b>
                <div className="acad-opt bad">{finished[k] >= 0 ? `Tu respuesta: ${qq.options[finished[k]]}` : 'Sin responder'}</div>
                <div className="acad-opt good">Correcta: {qq.options[qq.answer]}</div>
                <p className="acad-muted">{qq.explain}</p>
              </div>
            ))}
          </section>
        )}
        <div className="acad-actions">
          <button className="btn primary" onClick={restart}>Repetir cuestionario</button>
          <button className="btn" onClick={() => nav('/academy/' + level.id)}>Volver al nivel</button>
          <button className="btn" onClick={() => nav('/academy')}>Ver mi progreso <IconArrowR size={14} /></button>
        </div>
      </div>
    );
  }

  return (
    <div className="acad">
      {crumbs}
      <header className="acad-pagehead">
        <div>
          <div className="acad-eyebrow">Cuestionario · Nivel {level.id}</div>
          <h1>{level.title}</h1>
        </div>
        <div className="acad-pagehead-side"><div className="acad-muted">Pregunta {i + 1} de {n}</div><Bar percent={((i + (checked ? 1 : 0)) / n) * 100} label="Progreso del cuestionario" /></div>
      </header>
      <section className="acad-card acad-q">
        {q.domain && <span className="acad-saa">{SAA_DOMAINS[q.domain]}</span>}
        <h2>{i + 1}. {q.q}</h2>
        <div role="radiogroup" aria-label={q.q}>
          {q.options.map((o, j) => {
            const state = !checked ? (chosen === j ? 'on' : '') : j === q.answer ? 'good' : chosen === j ? 'bad' : 'dim';
            return (
              <button key={j} type="button" role="radio" aria-checked={chosen === j} className={'acad-option ' + state} disabled={checked}
                onClick={() => setAnswers(Object.assign([...answers], { [i]: j }))}>
                <span className="acad-radio">{checked && j === q.answer ? <IconCheck size={12} /> : String.fromCharCode(65 + j)}</span>{o}
              </button>
            );
          })}
        </div>
        {checked && (
          <div className={'acad-feedback ' + (chosen === q.answer ? 'ok' : 'ko')} role="status">
            <b>{chosen === q.answer ? '¡Correcto!' : 'No es esa.'}</b> {q.explain}
          </div>
        )}
        <div className="acad-actions">
          {!checked ? (
            <button className="btn primary" disabled={chosen === undefined} onClick={() => setChecked(true)}>Comprobar</button>
          ) : (
            <button className="btn primary" onClick={advance}>{i + 1 < n ? 'Siguiente pregunta' : 'Ver resultado'} <IconArrowR size={14} /></button>
          )}
        </div>
      </section>
    </div>
  );
}
