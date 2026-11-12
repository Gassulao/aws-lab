// Dónde se guarda la nube: localStorage en el navegador y, en Docker, el servidor (/api/state).
// En Node (tests) no se persiste nada.

const hasLS = () => {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
};

export function canPersist(): boolean {
  return hasLS();
}

export function readKey(key: string): string | null {
  return hasLS() ? localStorage.getItem(key) : null;
}

export function writeKey(key: string, value: string) {
  if (hasLS()) localStorage.setItem(key, value);
}

export function removeKey(key: string) {
  if (hasLS()) localStorage.removeItem(key);
}
