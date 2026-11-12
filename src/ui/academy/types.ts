// Tipos del currículo de la Academia.
import type { CheckCtx } from './checks';

export interface Lesson {
  id: string;
  title: string;
  minutes: number;
  /** Markdown. Los bloques ```bash tienen botones para copiarlos o probarlos en la terminal. */
  body: string;
}

export interface Step {
  id: string;
  title: string;
  /** Markdown con las instrucciones ampliadas del paso. */
  detail?: string;
  /** Pistas progresivas: una sola o una lista de la más vaga a la más concreta. */
  hint?: string | string[];
  /** true si está hecho; un texto explica por qué todavía no. */
  check: (c: CheckCtx) => boolean | string;
}

export type Difficulty = 'Fácil' | 'Media' | 'Difícil' | 'Reto';

export interface Exercise {
  id: string;
  title: string;
  summary: string;
  difficulty: Difficulty;
  minutes: number;
  /** Dominios del examen AWS Solutions Architect Associate (SAA-C03) que practica. */
  saa?: string[];
  /** Etiquetas libres (servicios implicados). */
  tags?: string[];
  scenario: string;
  steps: Step[];
  /** Solución de referencia: líneas de UNA sola línea cada una (se pegan una a una en la terminal). El test las lanza y exige que todos los pasos pasen. */
  script: string[];
  /** Texto de la solución (markdown). Si falta, se genera a partir de `script`. */
  solution?: string;
  /** Qué repetir en una cuenta real y qué limpiar para no pagar. */
  realWorld?: string;
  wrapUp?: string;
  /** Prepara el escenario (p. ej. recursos rotos para diagnosticar). Debe lanzar un error si algún comando falla. */
  setup?: (sh: import('../../shell').Shell) => Promise<void> | void;
}

export interface QuizQuestion {
  q: string;
  options: string[];
  answer: number;
  explain: string;
  /** Dominio del SAA-C03: 1 seguras, 2 resilientes, 3 alto rendimiento, 4 coste optimizado. */
  domain?: 1 | 2 | 3 | 4;
}

export interface Level {
  id: number;
  slug: string;
  title: string;
  subtitle: string;
  skills: string[];
  lessons: Lesson[];
  exercises: Exercise[];
  quiz: QuizQuestion[];
}

export const SAA_DOMAINS = {
  1: 'Dominio 1 · Diseño de arquitecturas seguras',
  2: 'Dominio 2 · Diseño de arquitecturas resilientes',
  3: 'Dominio 3 · Diseño de arquitecturas de alto rendimiento',
  4: 'Dominio 4 · Diseño de arquitecturas optimizadas en costes',
} as const;

export const solutionMarkdown = (e: Exercise): string => e.solution ?? '```bash\n' + e.script.join('\n') + '\n```';
