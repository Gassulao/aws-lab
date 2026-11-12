import React, { useEffect, useRef, useState } from 'react';
import { useCloud, signIn, lastUser, accountMatches, findIamUser } from '../session';
import { mutate } from '../../engine/store';
import { AwsMark } from '../components/chrome';
import './login.css';

type Mode = 'iam' | 'root';
type Errs = { account?: string; user?: string; pass?: string; form?: string };

const IAM_NAME = /^[\w+=,.@-]{1,64}$/;
const THEMES = [['light', 'Claro'], ['dark', 'Oscuro'], ['auto', 'Automático']] as const;

/** Pantalla de inicio de sesión de la consola (diseño propio, inspirado en la página de acceso de AWS). */
export function Login() {
  const s = useCloud();
  const acctId = s.account.id;
  const [mode, setMode] = useState<Mode>('iam');
  const [account, setAccount] = useState(s.account.alias || acctId);
  const [user, setUser] = useState(lastUser());
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [show, setShow] = useState(false);
  const [errs, setErrs] = useState<Errs>({});
  const userRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);
  useEffect(() => { (user ? passRef : userRef).current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const theme = s.settings.theme ?? 'light';

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const er: Errs = {};
    const who = (mode === 'root' ? email : user).trim();
    if (mode === 'iam') {
      if (!account.trim()) er.account = 'Introduzca el ID de cuenta (12 dígitos) o el alias de cuenta.';
      else if (!accountMatches(s, account)) er.account = `No se ha encontrado la cuenta «${account.trim()}». En este simulador tu cuenta es ${acctId} (puedes copiarla de la cabecera de la consola).`;
      if (!who) er.user = 'Introduzca el nombre de usuario de IAM.';
      else if (!IAM_NAME.test(who)) er.user = 'El nombre de usuario solo admite letras, números y los caracteres + = , . @ _ - (máximo 64).';
    } else if (!who) er.user = 'Introduzca la dirección de correo electrónico del usuario raíz.';
    else if (!/^\S+@\S+\.\S+$/.test(who)) er.user = 'Introduzca una dirección de correo electrónico válida.';
    if (!pass) er.pass = 'Introduzca la contraseña. En el simulador vale cualquiera, pero no puede estar vacía.';
    setErrs(er);
    if (Object.keys(er).length) {
      (er.account ? document.getElementById('lg-account') : er.user ? userRef.current : passRef.current)?.focus();
      return;
    }
    signIn(mode === 'root' ? '' : who, { root: mode === 'root' });
    location.hash = '#/';
  };

  const otherUser = () => {
    setMode('iam');
    setAccount(s.account.alias || acctId);
    setUser('');
    setEmail('');
    setPass('');
    setErrs({});
    setTimeout(() => userRef.current?.focus(), 0);
  };
  const exists = mode === 'iam' && user.trim() && findIamUser(s, user);

  return (
    <div className="lg-page">
      <main className="lg-main">
        <div className="lg-brand"><AwsMark /></div>
        <form className="lg-card" onSubmit={submit} noValidate aria-labelledby="lg-title">
          <h1 id="lg-title">Iniciar sesión</h1>
          <div role="radiogroup" aria-label="Tipo de usuario" className="lg-opts">
            <label className={'lg-opt' + (mode === 'root' ? ' on' : '')}>
              <input type="radio" name="lg-mode" checked={mode === 'root'} onChange={() => { setMode('root'); setErrs({}); }} />
              <span><b>Usuario raíz</b><small>El propietario de la cuenta que realiza tareas que requieren acceso sin restricciones.</small></span>
            </label>
            <label className={'lg-opt' + (mode === 'iam' ? ' on' : '')}>
              <input type="radio" name="lg-mode" checked={mode === 'iam'} onChange={() => { setMode('iam'); setErrs({}); }} />
              <span><b>Usuario de IAM</b><small>Un usuario de una cuenta que realiza tareas diarias, con los permisos que le concedan sus políticas.</small></span>
            </label>
          </div>

          {mode === 'iam' ? (
            <>
              <Field id="lg-account" label="ID de cuenta (12 dígitos) o alias de cuenta" err={errs.account}>
                <input id="lg-account" value={account} onChange={(e) => setAccount(e.target.value)} autoComplete="off" spellCheck={false} aria-invalid={!!errs.account} />
              </Field>
              <Field id="lg-user" label="Nombre de usuario de IAM" err={errs.user}>
                <input id="lg-user" ref={userRef} value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" spellCheck={false} autoCapitalize="off" aria-invalid={!!errs.user} />
              </Field>
            </>
          ) : (
            <Field id="lg-user" label="Dirección de correo electrónico del usuario raíz" err={errs.user}>
              <input id="lg-user" ref={userRef} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="usuario@ejemplo.com" autoComplete="email" spellCheck={false} aria-invalid={!!errs.user} />
            </Field>
          )}
          <Field id="lg-pass" label="Contraseña" err={errs.pass}>
            <input id="lg-pass" ref={passRef} type={show ? 'text' : 'password'} value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" aria-invalid={!!errs.pass} />
          </Field>
          <label className="lg-check"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Mostrar contraseña</label>

          {exists && <p className="lg-hint">Existe el usuario IAM <b>{findIamUser(s, user)!.name}</b>: entrarás con sus permisos reales.</p>}
          <button type="submit" className="lg-primary">Iniciar sesión</button>
          <div className="lg-links"><a role="button" tabIndex={0} onClick={otherUser} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); otherUser(); } }}>Iniciar sesión con otro usuario</a></div>
          <p className="lg-sim"><b>Entorno simulado.</b> No se valida ninguna contraseña: sirve cualquiera que no esté vacía. El nombre de usuario que escribas será tu usuario en la consola.</p>
        </form>
      </main>
      <footer className="lg-foot">
        <div className="lg-theme" role="radiogroup" aria-label="Tema visual">
          {THEMES.map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={theme === id} className={theme === id ? 'on' : ''} onClick={() => mutate((st) => { st.settings.theme = id; })}>{label}</button>
          ))}
        </div>
        <div className="lg-legal">
          <a href="https://aws.amazon.com/es/terms/" target="_blank" rel="noreferrer">Términos de uso</a>
          <a href="https://aws.amazon.com/es/privacy/" target="_blank" rel="noreferrer">Política de privacidad</a>
          <a href="https://aws.amazon.com/es/privacy/" target="_blank" rel="noreferrer">Preferencias de cookies</a>
          <span>© 2026, Amazon Web Services, Inc. o sus filiales. Simulador educativo independiente.</span>
        </div>
      </footer>
    </div>
  );
}

function Field({ id, label, err, children }: { id: string; label: string; err?: string; children: React.ReactNode }) {
  return (
    <div className={'lg-field' + (err ? ' bad' : '')}>
      <label htmlFor={id}>{label}</label>
      {children}
      {err && <div className="lg-err" role="alert">{err}</div>}
    </div>
  );
}
