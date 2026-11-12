import { describe, it, expect } from 'vitest';
import { freshState } from '../src/engine/store';
import { newShell, execLine } from '../src/shell';
import { CheckCtx } from '../src/ui/academy/checks';
import { LEVELS } from '../src/ui/academy/content';
import { SAA_DOMAINS, solutionMarkdown } from '../src/ui/academy/types';
import {
  answerQuiz, completeExercise, emptyProgress, levelStats, markLessonRead, markStep, maxXp, nextExercise, quizCorrect, rankOf, RANKS,
  restartExercise, startExercise, unlocked, xpOf, XP_BY_DIFFICULTY, XP_QUIZ_CORRECT,
} from '../src/ui/academy/progress';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('Academia: la solución de referencia valida todos los pasos', () => {
  for (const level of LEVELS) {
    for (const ex of level.exercises) {
      it(`${ex.id} · ${ex.title}`, async () => {
        const st = freshState('Ana');
        st.settings.speed = 'instant';
        const sh = newShell(st);
        if (ex.setup) await ex.setup(sh);
        await tick();
        const since = Date.now();
        // Antes de empezar no debe estar todo hecho (ni siquiera con el escenario preparado).
        const before = new CheckCtx(st, since);
        expect(ex.steps.every((s) => s.check(before) === true), 'el laboratorio no puede venir resuelto').toBe(false);
        expect(ex.steps.some((s) => s.check(before) === true && !ex.setup), 'sin escenario, ningún paso viene hecho').toBe(false);
        for (const line of ex.script) {
          expect(line.includes('\n'), `cada línea de la solución debe ser de una sola línea: ${line}`).toBe(false);
          const r = await execLine(sh, line, 'typed');
          expect(r.code, `${line}\n${r.err}`).toBe(0);
        }
        const c = new CheckCtx(st, since);
        for (const s of ex.steps) expect(s.check(c), `${ex.id}/${s.id}`).toBe(true);
        expect(solutionMarkdown(ex).length).toBeGreaterThan(20);
      });
    }
  }
});

describe('Academia: calidad del currículo', () => {
  it('ids únicos y cuestionarios coherentes', () => {
    const ids = LEVELS.flatMap((l) => l.exercises.map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
    const lessons = LEVELS.flatMap((l) => l.lessons.map((x) => x.id));
    expect(new Set(lessons).size).toBe(lessons.length);
    for (const l of LEVELS) for (const q of l.quiz) {
      expect(q.answer).toBeGreaterThanOrEqual(0);
      expect(q.answer).toBeLessThan(q.options.length);
      expect(new Set(q.options).size).toBe(q.options.length);
    }
  });
  it('cada nivel tiene lecciones, laboratorios y un cuestionario SAA-C03', () => {
    for (const l of LEVELS) {
      expect(l.lessons.length, `lecciones ${l.id}`).toBeGreaterThanOrEqual(3);
      expect(l.lessons.length).toBeLessThanOrEqual(4);
      expect(l.exercises.length, `laboratorios ${l.id}`).toBeGreaterThanOrEqual(4);
      expect(l.quiz.length, `preguntas ${l.id}`).toBeGreaterThanOrEqual(6);
      expect(l.quiz.length).toBeLessThanOrEqual(12);
      for (const les of l.lessons) expect(les.body, les.id).toContain('```bash');
    }
    const domains = new Set(LEVELS.flatMap((l) => l.quiz.map((q) => q.domain)));
    for (const d of [1, 2, 3, 4]) expect(domains.has(d as 1), `dominio ${d} en algún cuestionario`).toBe(true);
  });
  it('cada laboratorio declara dominio SAA, escenario, pistas y cómo repetirlo en la cuenta real', () => {
    const valid = Object.values(SAA_DOMAINS) as string[];
    for (const l of LEVELS) for (const e of l.exercises) {
      expect(e.saa?.length, `${e.id} saa`).toBeGreaterThan(0);
      for (const d of e.saa!) expect(valid).toContain(d);
      expect(e.scenario.length, `${e.id} scenario`).toBeGreaterThan(40);
      expect(e.realWorld, `${e.id} realWorld`).toMatch(/Limpieza/);
      expect(e.steps.length, `${e.id} pasos`).toBeGreaterThanOrEqual(3);
      expect(e.steps.filter((s) => s.hint).length, `${e.id} pistas`).toBeGreaterThanOrEqual(1);
      expect(new Set(e.steps.map((s) => s.id)).size).toBe(e.steps.length);
      expect(e.tags?.length, `${e.id} etiquetas`).toBeGreaterThan(0);
    }
  });
  it('el XP máximo permite alcanzar el rango más alto', () => {
    expect(maxXp(LEVELS)).toBeGreaterThanOrEqual(RANKS[RANKS.length - 1].min);
  });
});

describe('Academia: progreso, XP y rangos', () => {
  const L = LEVELS;
  const l1 = L[0];

  it('rangos y barra hacia el siguiente', () => {
    expect(rankOf(0).current.name).toBe(RANKS[0].name);
    expect(rankOf(0).next?.name).toBe(RANKS[1].name);
    expect(rankOf(RANKS[1].min - 1).current.name).toBe(RANKS[0].name);
    expect(rankOf(RANKS[1].min).current.name).toBe(RANKS[1].name);
    expect(rankOf(RANKS[1].min).toNext).toBe(RANKS[2].min - RANKS[1].min);
    const mid = Math.floor((RANKS[1].min + RANKS[2].min) / 2);
    expect(rankOf(mid).percent).toBeGreaterThan(0);
    expect(rankOf(mid).percent).toBeLessThan(100);
    const top = rankOf(99999);
    expect(top.current.name).toBe(RANKS[RANKS.length - 1].name);
    expect(top.next).toBeUndefined();
    expect(top.percent).toBe(100);
    expect(top.toNext).toBe(0);
    for (let i = 1; i < RANKS.length; i++) expect(RANKS[i].min).toBeGreaterThan(RANKS[i - 1].min);
  });

  it('completar un laboratorio da XP según la dificultad, una sola vez', () => {
    const ex = l1.exercises[0];
    let p = completeExercise(emptyProgress(), l1, ex.id);
    expect(p.xp).toBe(XP_BY_DIFFICULTY[ex.difficulty]);
    expect(xpOf(ex)).toBe(p.xp);
    const again = completeExercise(p, l1, ex.id);
    expect(again).toBe(p);
    expect(again.done).toEqual([ex.id]);
    p = completeExercise(p, l1, 'no-existe');
    expect(p.done).toHaveLength(1);
  });

  it('los pasos se marcan sin duplicados', () => {
    let p = markStep(emptyProgress(), 'x', 'a');
    p = markStep(p, 'x', 'a');
    p = markStep(p, 'x', 'b');
    expect(p.steps.x).toEqual(['a', 'b']);
  });

  it('el inicio del laboratorio se fija una vez y reiniciar lo renueva sin perder XP', () => {
    let p = startExercise(emptyProgress(), 'e', 100);
    p = startExercise(p, 'e', 999);
    expect(p.started.e).toBe(100);
    p = markStep(p, 'e', 'a');
    p = completeExercise(p, l1, l1.exercises[0].id);
    const xp = p.xp;
    const r = restartExercise(p, 'e', 500);
    expect(r.started.e).toBe(500);
    expect(r.steps.e).toBeUndefined();
    expect(r.xp).toBe(xp);
    expect(r.done).toEqual(p.done);
  });

  it('el cuestionario da XP solo por mejorar', () => {
    const q = l1.quiz;
    const good = q.map((x) => x.answer);
    const bad = q.map((x) => (x.answer + 1) % x.options.length);
    let p = answerQuiz(emptyProgress(), l1, bad);
    expect(p.xp).toBe(0);
    expect(quizCorrect(l1, p.quiz[1])).toBe(0);
    p = answerQuiz(p, l1, good);
    expect(p.xp).toBe(q.length * XP_QUIZ_CORRECT);
    const again = answerQuiz(p, l1, good);
    expect(again.xp).toBe(p.xp);
    const worse = answerQuiz(p, l1, bad);
    expect(worse.xp).toBe(p.xp);
  });

  it('los niveles se desbloquean al terminar la mitad (redondeando hacia arriba) del anterior', () => {
    let p = emptyProgress();
    expect(unlocked(p, L, 1)).toBe(true);
    expect(unlocked(p, L, 2)).toBe(false);
    const need = Math.ceil(l1.exercises.length / 2);
    for (let i = 0; i < need - 1; i++) p = completeExercise(p, l1, l1.exercises[i].id);
    expect(unlocked(p, L, 2)).toBe(false);
    p = completeExercise(p, l1, l1.exercises[need - 1].id);
    expect(unlocked(p, L, 2)).toBe(true);
    expect(unlocked(p, L, 3)).toBe(false);
    expect(unlocked({ ...emptyProgress(), freeMode: true }, L, 4)).toBe(true);
  });

  it('estadísticas de nivel y siguiente laboratorio recomendado', () => {
    let p = emptyProgress();
    expect(levelStats(p, l1)).toEqual({ done: 0, total: l1.exercises.length, percent: 0 });
    expect(nextExercise(p, L)?.exercise.id).toBe(l1.exercises[0].id);
    p = completeExercise(p, l1, l1.exercises[0].id);
    expect(levelStats(p, l1).done).toBe(1);
    expect(nextExercise(p, L)?.exercise.id).toBe(l1.exercises[1].id);
    for (const l of L) for (const e of l.exercises) p = completeExercise(p, l, e.id);
    expect(nextExercise(p, L)).toBeNull();
    expect(levelStats(p, l1).percent).toBe(100);
    expect(p.xp).toBe(L.reduce((n, l) => n + l.exercises.reduce((m, e) => m + xpOf(e), 0), 0));
  });

  it('lecciones leídas sin duplicados', () => {
    let p = markLessonRead(emptyProgress(), 'a');
    p = markLessonRead(p, 'a');
    expect(p.read).toEqual(['a']);
  });
});
