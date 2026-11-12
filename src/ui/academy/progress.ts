// Progreso del alumno: pasos completados, XP, rangos y desbloqueo de niveles. Funciones puras sobre un objeto serializable.
import type { Exercise, Level } from './types';

export interface Progress {
  /** ids de ejercicio -> ids de paso completados. */
  steps: Record<string, string[]>;
  /** ejercicios terminados. */
  done: string[];
  /** nivel -> respuestas del cuestionario (índice elegido por pregunta). */
  quiz: Record<number, number[]>;
  xp: number;
  freeMode: boolean;
  /** ejercicio -> marca de tiempo (ms) en la que se preparó el escenario; los comandos anteriores no cuentan. */
  started: Record<string, number>;
  /** ids de lecciones leídas. */
  read: string[];
}

export const emptyProgress = (): Progress => ({ steps: {}, done: [], quiz: {}, xp: 0, freeMode: false, started: {}, read: [] });

export const XP_BY_DIFFICULTY = { 'Fácil': 20, 'Media': 40, 'Difícil': 70, 'Reto': 120 } as const;
export const XP_QUIZ_CORRECT = 5;

export const RANKS: { name: string; min: number }[] = [
  { name: 'Curioso de la nube', min: 0 },
  { name: 'Aprendiz cloud', min: 100 },
  { name: 'Operador', min: 300 },
  { name: 'Ingeniero cloud', min: 600 },
  { name: 'Arquitecto', min: 900 },
  { name: 'Experto AWS', min: 1200 },
];

export function rankOf(xp: number) {
  let i = 0;
  RANKS.forEach((r, k) => { if (xp >= r.min) i = k; });
  const next = RANKS[i + 1];
  const span = next ? next.min - RANKS[i].min : 1;
  return { current: RANKS[i], next, index: i, toNext: next ? next.min - xp : 0, percent: next ? Math.round(((xp - RANKS[i].min) / span) * 100) : 100 };
}

/** Recompensa de un laboratorio. */
export const xpOf = (e: Pick<Exercise, 'difficulty'>) => XP_BY_DIFFICULTY[e.difficulty];

/** XP máximo alcanzable: todos los laboratorios y todas las preguntas acertadas. */
export function maxXp(levels: Level[]): number {
  return levels.reduce((n, l) => n + l.exercises.reduce((m, e) => m + xpOf(e), 0) + l.quiz.length * XP_QUIZ_CORRECT, 0);
}

export function markStep(p: Progress, exerciseId: string, stepId: string): Progress {
  const cur = p.steps[exerciseId] ?? [];
  if (cur.includes(stepId)) return p;
  return { ...p, steps: { ...p.steps, [exerciseId]: [...cur, stepId] } };
}

export function completeExercise(p: Progress, level: Level, exerciseId: string): Progress {
  if (p.done.includes(exerciseId)) return p;
  const ex = level.exercises.find((e) => e.id === exerciseId);
  if (!ex) return p;
  return { ...p, done: [...p.done, exerciseId], xp: p.xp + xpOf(ex) };
}

/** Marca el inicio del laboratorio (escenario preparado). Si ya estaba iniciado no cambia nada. */
export function startExercise(p: Progress, exerciseId: string, ts: number): Progress {
  if (p.started[exerciseId] !== undefined) return p;
  return { ...p, started: { ...p.started, [exerciseId]: ts } };
}

/** Reinicia el laboratorio: nueva marca de inicio y pasos a cero. El XP ya ganado y el estado «completado» se conservan. */
export function restartExercise(p: Progress, exerciseId: string, ts: number): Progress {
  const { [exerciseId]: _old, ...steps } = p.steps;
  void _old;
  return { ...p, steps, started: { ...p.started, [exerciseId]: ts } };
}

export function markLessonRead(p: Progress, lessonId: string): Progress {
  return p.read.includes(lessonId) ? p : { ...p, read: [...p.read, lessonId] };
}

export const quizCorrect = (level: Level, answers: number[] | undefined) => (answers ? answers.filter((x, i) => x === level.quiz[i]?.answer).length : 0);

export function answerQuiz(p: Progress, level: Level, answers: number[]): Progress {
  const prev = p.quiz[level.id];
  const gain = Math.max(0, quizCorrect(level, answers) - quizCorrect(level, prev)) * XP_QUIZ_CORRECT;
  return { ...p, quiz: { ...p.quiz, [level.id]: answers }, xp: p.xp + gain };
}

/** Un nivel se desbloquea al terminar al menos la mitad (redondeando hacia arriba) de los laboratorios del anterior. */
export function unlocked(p: Progress, levels: Level[], levelId: number): boolean {
  if (p.freeMode || levelId <= 1) return true;
  const prev = levels.find((l) => l.id === levelId - 1);
  if (!prev) return true;
  return levelStats(p, prev).done >= requiredToUnlock(prev);
}

export const requiredToUnlock = (prev: Level) => Math.ceil(prev.exercises.length / 2);

export function levelStats(p: Progress, level: Level) {
  const done = level.exercises.filter((e) => p.done.includes(e.id)).length;
  return { done, total: level.exercises.length, percent: level.exercises.length ? Math.round((done / level.exercises.length) * 100) : 0 };
}

/** Siguiente laboratorio recomendado: el primero sin completar del primer nivel desbloqueado que lo tenga. */
export function nextExercise(p: Progress, levels: Level[]): { level: Level; exercise: Exercise } | null {
  for (const l of levels) {
    if (!unlocked(p, levels, l.id)) continue;
    const e = l.exercises.find((x) => !p.done.includes(x.id));
    if (e) return { level: l, exercise: e };
  }
  return null;
}
