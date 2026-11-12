import React from 'react';
import { createRoot } from 'react-dom/client';
import './ui/styles.css';
import { App } from './ui/App';
import { initRemote, schedulePush } from './engine/remote';
import { getProgress, setProgress, subscribeProgress } from './ui/academy/store';

async function start() {
  const { progress } = await initRemote({ progress: getProgress });
  if (progress && typeof progress === 'object') setProgress({ ...getProgress(), ...(progress as object) } as ReturnType<typeof getProgress>);
  subscribeProgress(schedulePush);
  createRoot(document.getElementById('root')!).render(<App />);
}
start();
