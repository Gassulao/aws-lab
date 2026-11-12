// Markdown con bloques de código que se pueden copiar o probar en la terminal.
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Marked } from 'marked';
import { pasteInTerminal, runInTerminal } from './bridge';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Un bloque se puede ejecutar si es shell y no contiene marcadores del estilo <id-de-ejemplo>. */
export function runnable(code: string, lang?: string): boolean {
  if (lang && !/^(bash|sh|shell|console)$/.test(lang)) return false;
  if (!lang) return false;
  return !/<[^>\n]*[A-Za-zÁ-ú…][^>\n]*>/.test(code.replace(/<<-?\s*'?\w+'?/g, ''));
}

const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  renderer: {
    code(code: string, lang?: string) {
      const l = (lang ?? '').split(/\s/)[0];
      const run = runnable(code, l);
      return `<div class="acad-code" data-code="${encodeURIComponent(code)}"><div class="acad-code-bar"><span class="acad-code-lang">${esc(l || 'texto')}</span><span class="acad-code-actions"><button type="button" data-act="copy">Copiar</button>${run ? '<button type="button" data-act="run" class="acad-run">Probar en la terminal</button>' : ''}</span></div><pre><code>${esc(code.replace(/\n$/, ''))}</code></pre></div>`;
    },
  },
});

export const renderMd = (src: string): string => marked.parse(src, { async: false }) as string;
export const renderInline = (src: string): string => marked.parseInline(src, { async: false }) as string;

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* sin portapapeles */ }
    ta.remove();
    return ok;
  }
}

/** Gestiona los clics de los botones de un bloque de código. `onRun` avisa de que se va a usar la terminal (p. ej. para abrirla). */
export function useCodeClicks(onRun?: () => Promise<void> | void) {
  return useCallback(async (e: React.MouseEvent) => {
    const btn = (e.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null;
    if (!btn) return;
    const box = btn.closest('.acad-code') as HTMLElement | null;
    if (!box) return;
    const code = decodeURIComponent(box.dataset.code ?? '');
    const flash = (t: string) => {
      const old = btn.dataset.label ?? btn.textContent ?? '';
      btn.dataset.label = old;
      btn.textContent = t;
      setTimeout(() => { btn.textContent = old; }, 1400);
    };
    if (btn.dataset.act === 'copy') flash((await copyText(code)) ? 'Copiado' : 'No se pudo copiar');
    if (btn.dataset.act === 'run') {
      await onRun?.();
      btn.disabled = true;
      const ok = await runInTerminal(code, (i, n) => { btn.textContent = n > 1 ? `Ejecutando ${i + 1}/${n}…` : 'Ejecutando…'; });
      btn.disabled = false;
      btn.textContent = btn.dataset.label ?? 'Probar en la terminal';
      if (!ok) flash('Abre la terminal');
    }
  }, [onRun]);
}

export function Md({ src, onRun, className }: { src: string; onRun?: () => Promise<void> | void; className?: string }) {
  const html = useMemo(() => renderMd(src), [src]);
  const click = useCodeClicks(onRun);
  return <div className={'acad-md ' + (className ?? '')} onClick={click} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function MdInline({ src }: { src: string }) {
  const html = useMemo(() => renderInline(src), [src]);
  return <span className="acad-inline" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Comando suelto (pistas) con botones de copiar, pegar y ejecutar. */
export function CmdBlock({ cmd, onRun }: { cmd: string; onRun?: () => Promise<void> | void }) {
  const [msg, setMsg] = useState('');
  const timer = useRef<number>();
  const say = (t: string) => { setMsg(t); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setMsg(''), 1400); };
  const canRun = runnable(cmd, 'bash');
  return (
    <div className="acad-cmd">
      <code>{cmd}</code>
      <span className="acad-cmd-actions">
        <button type="button" onClick={async () => say((await copyText(cmd)) ? 'Copiado' : 'Error')}>Copiar</button>
        {canRun && <button type="button" onClick={async () => { await onRun?.(); say((await pasteInTerminal(cmd)) ? 'Pegado en la terminal' : 'Abre la terminal'); }}>Pegar</button>}
      </span>
      {msg && <span className="acad-cmd-msg" role="status">{msg}</span>}
    </div>
  );
}
