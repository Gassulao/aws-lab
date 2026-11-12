import type { Level } from '../types';
import { l01 } from './l01';
import { l02 } from './l02';
import { l03 } from './l03';
import { l04 } from './l04';
import { l05 } from './l05';
import { l06 } from './l06';
import { l07 } from './l07';
import { l08 } from './l08';
import { l09 } from './l09';
import { l10 } from './l10';
import { l11 } from './l11';
import { l12 } from './l12';
import { l13 } from './l13';
import { l14 } from './l14';
import { l15 } from './l15';

/**
 * Reparte la posición de la respuesta correcta entre A, B, C y D. En el currículo original casi todas las respuestas
 * correctas eran la B, así que se podía aprobar sin saber nada. La posición de cada pregunta es determinista (siempre la
 * misma) y el resto de opciones conservan su orden. Si una opción hace referencia a las demás («todas las anteriores»)
 * la pregunta no se toca.
 */
const REFERS_TO_OTHERS = /anteriores|ninguna de las|todas las (opciones|respuestas)|ambas/i;
function balanceQuiz(level: Level): Level {
  const quiz = level.quiz.map((q, k) => {
    if (q.options.some((o) => REFERS_TO_OTHERS.test(o))) return q;
    const target = (k * 3 + level.id) % q.options.length; // 3 es primo con 4: recorre A, B, C y D sin repetir
    const rest = q.options.filter((_, j) => j !== q.answer);
    const options = [...rest.slice(0, target), q.options[q.answer], ...rest.slice(target)];
    return { ...q, options, answer: target };
  });
  return { ...level, quiz };
}

export const LEVELS: Level[] = [l01, l02, l03, l04, l05, l06, l07, l08, l09, l10, l11, l12, l13, l14, l15].map(balanceQuiz);
