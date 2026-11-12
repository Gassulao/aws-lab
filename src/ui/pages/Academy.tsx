// Academia: panel de rango y niveles, lecciones, laboratorios guiados con terminal y cuestionarios tipo SAA-C03.
import React from 'react';
import { LEVELS } from '../academy/content';
import { unlocked } from '../academy/progress';
import { Overview } from './academy/Overview';
import { LevelView, LessonView, LockedLevel } from './academy/LevelView';
import { LabView } from './academy/LabView';
import { Quiz } from './academy/QuizView';
import { useProgressEff } from './academy/common';
import './academy/academy.css';

export function AcademyPages({ path }: { path: string }) {
  const p = useProgressEff();
  const m = /^\/academy\/(\d+)(?:\/([\w-]+))?/.exec(path);
  if (m) {
    const level = LEVELS.find((l) => l.id === Number(m[1]));
    if (level) {
      if (!unlocked(p, LEVELS, level.id)) return <LockedLevel level={level} />;
      const ex = level.exercises.find((e) => e.id === m[2]);
      if (ex) return <LabView key={ex.id} level={level} ex={ex} />;
      if (m[2] === 'quiz') return <Quiz key={level.id} level={level} />;
      const li = level.lessons.findIndex((l) => l.id === m[2]);
      if (li >= 0) return <LessonView key={m[2]} level={level} index={li} />;
      return <LevelView level={level} />;
    }
  }
  return <Overview />;
}
