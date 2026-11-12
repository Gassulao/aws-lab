import { describe, it, expect } from 'vitest';
import { render } from '../src/shell/aws/framework';

describe('--output table', () => {
  it('lista de listas: tabla sin comas', () => {
    const out = render({ R: [{ I: [{ Id: 'i-1', S: 'running' }, { Id: 'i-2', S: 'stopped' }] }] }, 'table', 'R[].I[].[Id,S]');
    expect(out).toContain('| i-1 ');
    expect(out).not.toMatch(/i-1,/);
    expect(out.split('\n').filter((l) => l.startsWith('|')).length).toBe(2);
  });
  it('listas anidadas: una fila por elemento', () => {
    const out = render([['web', [['80', 'tcp'], ['443', 'tcp']]]], 'table');
    const rows = out.split('\n').filter((l) => l.startsWith('|'));
    expect(rows.length).toBe(2);
    expect(rows[0]).toContain('web');
    expect(rows[1]).toContain('443');
    expect(out).not.toContain('[');
  });
  it('lista de objetos: tabla con cabecera', () => {
    expect(render([{ a: 1, b: 'x' }], 'table')).toContain('| a | b |');
  });
});
