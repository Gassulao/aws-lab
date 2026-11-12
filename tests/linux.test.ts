import { describe, it, expect, beforeEach } from 'vitest';
import { freshState } from '../src/engine/store';
import { newShell, runString, type Shell } from '../src/shell';

let sh: Shell;
beforeEach(() => {
  sh = newShell(freshState('Ana'));
});
const run = (cmd: string) => runString(sh, cmd);
const out = async (cmd: string) => (await run(cmd)).out;
const LOG = '10.0.0.1 GET /a 200\n10.0.0.2 GET /b 500\n10.0.0.1 POST /a 200\n10.0.0.3 GET /c 404\n10.0.0.1 GET /b 500\n';

describe('linux: filtros', () => {
  beforeEach(async () => {
    await run(`printf '${LOG.replace(/\n/g, '\\n')}' > /tmp/acc.log`);
  });
  it('sort | uniq -c | sort -rn | head', async () => {
    expect(await out("awk '{print $1}' /tmp/acc.log | sort | uniq -c | sort -rn | head -n 1")).toMatch(/3 10\.0\.0\.1/);
  });
  it('grep, sed y cut', async () => {
    expect(await out('grep -c 500 /tmp/acc.log')).toBe('2\n');
    expect(await out("grep -v ' 200$' /tmp/acc.log | wc -l")).toBe('3\n');
    expect(await out("sed -n '2,3p' /tmp/acc.log | cut -d' ' -f3")).toBe('/b\n/a\n');
    await run("sed -i 's/GET/LEER/' /tmp/acc.log");
    expect(await out('grep -c LEER /tmp/acc.log')).toBe('4\n');
  });
  it('awk con acumuladores', async () => {
    expect(await out("awk '$4==500{n++} END{print n}' /tmp/acc.log")).toBe('2\n');
  });
  it('find y tr', async () => {
    expect(await out('find /tmp -name "*.log"')).toContain('/tmp/acc.log');
    expect(await out('echo abc | tr a-c A-C')).toBe('ABC\n');
  });
});

describe('linux: scripts', () => {
  it('variables, for, if, aritmética y argumentos', async () => {
    await run(`printf '#!/bin/bash\\nN=0\\nfor f in "$@"; do\\n  if [ "$f" = b ]; then N=$((N+10)); elif [ "$f" = a ]; then N=$((N+1)); else N=$((N+100)); fi\\ndone\\necho total=$N\\nexit 3\\n' > /tmp/s.sh`);
    expect((await run('./s.sh a b')).code).not.toBe(0);
    await run('chmod +x /tmp/s.sh');
    const r = await run('cd /tmp && ./s.sh a b z');
    expect(r.out).toBe('total=111\n');
    expect((await run('bash /tmp/s.sh a; echo rc=$?')).out).toContain('total=1');
  });
  it('while read y expansiones de parámetros', async () => {
    await run("printf 'a.log\\nb.log\\n' > /tmp/l.txt");
    expect(await out('while read f; do echo ${f%.log}; done < /tmp/l.txt')).toBe('a\nb\n');
    expect(await out('cat /tmp/l.txt | while read f; do echo ${f^^}; done')).toBe('A.LOG\nB.LOG\n');
  });
});

describe('linux: permisos y cron', () => {
  it('chmod, ls -l, stat y find -perm', async () => {
    await run('echo x > /tmp/k.pem && chmod 600 /tmp/k.pem');
    expect(await out('ls -l /tmp/k.pem')).toMatch(/^-rw-------/);
    expect(await out('stat -c %a /tmp/k.pem')).toBe('600\n');
    expect(await out('find /tmp -perm 600')).toContain('/tmp/k.pem');
    await run('chmod u+x,g+r /tmp/k.pem');
    expect(await out('stat -c %a /tmp/k.pem')).toBe('740\n');
  });
  it('crontab valida y guarda', async () => {
    await run("printf '*/5 * * * * /home/ana/b.sh\\n' > /tmp/c");
    expect((await run('crontab /tmp/c')).code).toBe(0);
    expect(await out('crontab -l')).toContain('*/5 * * * *');
    await run("printf '99 * * * * x\\n' > /tmp/c2");
    expect((await run('crontab /tmp/c2')).code).not.toBe(0);
  });
});

describe('linux: [[ ]]', () => {
  it('compara con patrones glob', async () => {
    expect((await run('b=prod-a; [[ $b == prod-* ]] && echo si')).out).toBe('si\n');
    expect((await run('b=test-a; [[ $b == prod-* ]] || echo no')).out).toBe('no\n');
  });
});
