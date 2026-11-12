import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useCloud, getShell } from '../session';
import { execLine } from '../../shell';
import { Crumbs, PageHead } from '../components/ui';
import { termStore, type Line } from './shell/term';
import { complete } from './shell/complete';
import './shell/shell.css';

export type { Line };

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;

function Json({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(JSON_TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    if (m[1] !== undefined) out.push(<span key={k++} className={m[2] ? 'cs-key' : 'cs-str'}>{m[1]}</span>, m[2] ?? '');
    else if (m[3]) out.push(<span key={k++} className="cs-lit">{m[0]}</span>);
    else out.push(<span key={k++} className="cs-num">{m[0]}</span>);
    last = i + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

const OK_LINE = /^(upload|download|copy|delete|move|make_bucket|remove_bucket):/;

// Secuencias SGR (color y negrita) de comandos como terraform.
const SGR = /\u001b\[([0-9;]*)m/g;
function Ansi({ text }: { text: string }) {
  if (!text.includes('\u001b[')) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let cls: string[] = [];
  let last = 0;
  let n = 0;
  const push = (t: string) => { if (t) out.push(cls.length ? <span key={n++} className={cls.join(' ')}>{t}</span> : t); };
  for (const m of text.matchAll(SGR)) {
    push(text.slice(last, m.index));
    last = m.index! + m[0].length;
    for (const c of m[1].split(';')) {
      if (c === '' || c === '0') cls = [];
      else if (c === '1') cls.push('ansi-b');
      else if (c === '2') cls.push('ansi-dim');
      else if (/^3[0-7]$/.test(c)) cls = [...cls.filter((x) => !x.startsWith('ansi-c')), `ansi-c${c[1]}`];
    }
  }
  push(text.slice(last));
  return <>{out}</>;
}

function OutLine({ l }: { l: Line }) {
  if (l.kind === 'err') return <div className="cs-row cs-err">{l.text.split('\n').map((ln, i) => <div key={i}><Ansi text={ln || '\u00a0'} /></div>)}</div>;
  if (l.kind === 'info') return <div className="cs-row cs-info">{l.text}</div>;
  const t = l.text.trimStart();
  if ((t.startsWith('{') || t.startsWith('[')) && !t.includes('\u001b[')) return <div className="cs-row"><Json text={l.text} /></div>;
  return (
    <div className="cs-row">
      {l.text.split('\n').map((ln, i) => (
        <div key={i} className={OK_LINE.test(ln) ? 'cs-ok' : undefined}><Ansi text={ln || '\u00a0'} /></div>
      ))}
    </div>
  );
}

const promptOf = (user: string, cwd: string) => {
  const home = `/home/${user}`;
  const dir = cwd === home ? '~' : cwd === '/' ? '/' : cwd.split('/').filter(Boolean).pop() ?? '/';
  return `[${user}@cloudshell ${dir}]$`;
};

export function Terminal({ height, compact }: { height?: string; compact?: boolean }) {
  const s = useCloud();
  useSyncExternalStore(termStore.subscribe, termStore.version);
  const lines = termStore.lines();
  const busy = termStore.busy();
  const [val, setValRaw] = useState(termStore.draft());
  const [fs, setFs] = useState(13);
  const idx = useRef(-1);
  const stash = useRef('');
  const lastTab = useRef('');
  const box = useRef<HTMLDivElement>(null);
  const inp = useRef<HTMLInputElement>(null);
  const setVal = (v: string) => {
    termStore.setDraft(v);
    setValRaw(v);
  };
  const sh = getShell();
  const prompt = promptOf(s.me.userName, sh.cwd);
  const profile = s.cli.profiles[s.cli.activeProfile];
  const region = sh.vars.AWS_REGION ?? s.cli.env.AWS_REGION ?? s.cli.env.AWS_DEFAULT_REGION ?? profile?.region ?? s.region;

  useLayoutEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, busy, val]);
  useEffect(() => {
    inp.current?.focus();
  }, []);

  const submit = async () => {
    const line = val;
    if (termStore.busy()) return;
    setVal('');
    idx.current = -1;
    lastTab.current = '';
    termStore.push({ kind: 'in', text: line, prompt });
    if (!line.trim()) return;
    termStore.addHistory(line);
    if (line.trim() === 'clear') return termStore.clear();
    termStore.setBusy(true);
    try {
      const r = await execLine(getShell(), line, 'typed');
      const add: Line[] = [];
      if (r.out) add.push({ kind: 'out', text: r.out.replace(/\n+$/, '') });
      if (r.err) add.push({ kind: 'err', text: r.err.replace(/^\n+|\n+$/g, '') });
      termStore.push(...add);
    } catch (e) {
      termStore.push({ kind: 'err', text: `cloudshell: error interno del intérprete: ${(e as Error)?.message ?? String(e)}` });
    } finally {
      termStore.setBusy(false);
      setTimeout(() => inp.current?.focus(), 0);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const h = termStore.history();
    if (e.key !== 'Tab') lastTab.current = '';
    if (e.key === 'Enter') return void submit();
    if (e.ctrlKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      return termStore.clear();
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      termStore.push({ kind: 'in', text: val + '^C', prompt });
      idx.current = -1;
      return setVal('');
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'u') {
      e.preventDefault();
      const p = inp.current?.selectionStart ?? val.length;
      return setVal(val.slice(p));
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!h.length) return;
      if (idx.current === -1) stash.current = val;
      idx.current = Math.min(idx.current + 1, h.length - 1);
      return setVal(h[h.length - 1 - idx.current]);
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (idx.current < 0) return;
      idx.current -= 1;
      return setVal(idx.current < 0 ? stash.current : h[h.length - 1 - idx.current]);
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const pos = inp.current?.selectionStart ?? val.length;
      const r = complete(sh, val.slice(0, pos));
      if (!r) return;
      const rest = val.slice(pos);
      if (r.line.length > pos - 0 && r.line !== val.slice(0, pos)) {
        setVal(r.line + rest);
        lastTab.current = '';
        requestAnimationFrame(() => inp.current?.setSelectionRange(r.line.length, r.line.length));
      } else if (r.options.length > 1) {
        if (lastTab.current === val) {
          termStore.push({ kind: 'in', text: val, prompt }, { kind: 'out', text: r.options.join('   ') });
        }
        lastTab.current = val;
      }
    }
  };

  return (
    <div className="cs-wrap">
      <div className="cs-bar">
        <div className="cs-tab"><span className="dot" />Región: {region}</div>
        <div className="sp" />
        {!compact && <button title="Reducir fuente" onClick={() => setFs((f) => Math.max(10, f - 1))}>A−</button>}
        {!compact && <button title="Aumentar fuente" onClick={() => setFs((f) => Math.min(20, f + 1))}>A+</button>}
        <button title="Limpiar la terminal (Ctrl+L)" onClick={() => { termStore.clear(); inp.current?.focus(); }}>Limpiar</button>
      </div>
      <div
        ref={box}
        className="cs-term"
        style={{ height: height ?? 'calc(100vh - 290px)', minHeight: 200, fontSize: fs, lineHeight: `${Math.round(fs * 1.45)}px` }}
        onClick={() => { if (!window.getSelection()?.toString()) inp.current?.focus(); }}
      >
        {lines.map((l, i) =>
          l.kind === 'in' ? (
            <div key={i} className="cs-row"><span className="cs-prompt">{l.prompt}</span> <span className="cs-cmd">{l.text}</span></div>
          ) : (
            <OutLine key={i} l={l} />
          ),
        )}
        <div className={`cs-input ${busy ? 'busy' : ''}`}>
          <span className="cs-prompt">{prompt}</span>
          <input id="term-in" ref={inp} autoFocus spellCheck={false} autoComplete="off" autoCapitalize="off" aria-label="Terminal de CloudShell" value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={onKey} />
        </div>
      </div>
      {!compact && <div className="cs-foot"><span>bash</span><span>{s.me.userName}@cloudshell</span><span>{lines.length} líneas</span></div>}
    </div>
  );
}

export function CloudShell() {
  return (
    <>
      <Crumbs items={[{ label: 'CloudShell' }]} />
      <PageHead title="CloudShell" desc="Terminal con el AWS CLI ya autenticado con tu usuario. Todo lo que ejecutes aquí queda en CloudTrail." />
      <Terminal />
    </>
  );
}
