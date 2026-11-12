import React, { useState } from 'react';
import { Btn, Card, CliEquivalent, Crumbs, Flash, PageHead, Table, Status } from '../../components/ui';
import { Dl, Tabs, run, takeFlash, q } from '../iam/kit';
import { Badge, ctxOf, ts, useCicd } from './common';
import { cicd } from '../../../engine/services/cicdTypes';
import { branchLog, cloneUrl, evaluateRules } from '../../../engine/services/codecommit';
import { diffTrees, unifiedDiff, short } from '../../../engine/services/gitCore';

type Tab = 'code' | 'commits' | 'branches' | 'prs' | 'info';

export function RepoDetail({ name }: { name: string }) {
  const s = useCicd();
  const [tab, setTab] = useState<Tab>('code');
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const repo = cicd(s).repos.find((r) => r.name === name && r.region === s.region);
  const branches = repo ? Object.keys(repo.branches).sort() : [];
  const [branch, setBranch] = useState('');
  const [file, setFile] = useState('');
  const [commit, setCommit] = useState('');
  const [pr, setPr] = useState('');
  const crumbs = <Crumbs items={[{ label: 'Developer Tools', to: '/devtools/repos' }, { label: 'Repositorios', to: '/devtools/repos' }, { label: name }]} />;
  if (!repo) return <>{crumbs}<Flash kind="err" title="RepositoryDoesNotExistException">{name} does not exist in this region.</Flash></>;
  const br = branches.includes(branch) ? branch : repo.defaultBranch && branches.includes(repo.defaultBranch) ? repo.defaultBranch : branches[0] ?? '';
  const head = br ? repo.objs.commits[repo.branches[br]] : undefined;
  const tree = head?.tree ?? {};
  const act = async (cmd: string, ok: string) => { const r = await run(cmd); if (!r.ok) setErr(r.msg); else { setErr(''); setFlash(ok); } };
  const commits = br ? branchLog(repo, br, 100) : [];
  const prs = [...repo.prs].sort((a, b) => Number(b.id) - Number(a.id));
  const selPr = prs.find((p) => p.id === pr);
  const selCommit = commits.find((c) => c.id === commit) ?? repo.objs.commits[commit];
  const ev = selPr ? evaluateRules(s, selPr) : null;
  void ctxOf;
  return (
    <>
      {crumbs}
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title={repo.name} desc={repo.description} />
      <Card title="Clonar">
        <div className="dt-row"><code>git clone {cloneUrl(repo.region, repo.name)}</code></div>
        <div className="dt-sub">Antes configure el asistente de credenciales: git config --global credential.helper '!aws codecommit credential-helper $@'</div>
      </Card>
      <div className="card" style={{ marginBottom: 20 }}>
        <Tabs<Tab> active={tab} onChange={setTab} tabs={[{ id: 'code', label: 'Código' }, { id: 'commits', label: 'Commits' }, { id: 'branches', label: 'Ramas' }, { id: 'prs', label: `Solicitudes de incorporación (${prs.filter((p) => p.status === 'OPEN').length})` }, { id: 'info', label: 'Configuración' }]} />
        {tab !== 'prs' && tab !== 'info' && tab !== 'branches' && (
          <div className="dt-pad dt-row"><label>Rama: <select className="k-select" aria-label="Rama" value={br} onChange={(e) => { setBranch(e.target.value); setFile(''); }}>{branches.map((b) => <option key={b}>{b}</option>)}</select></label></div>
        )}
        {tab === 'code' && (!br ? <div className="dt-pad">El repositorio está vacío. Haga push desde git o use put-file.</div> : (
          <div className="dt-pad dt-grid">
            <div className="dt-tree" role="list">{Object.keys(tree).sort().map((f) => <a key={f} className={f === file ? 'on' : ''} onClick={() => setFile(f)}>{f}</a>)}</div>
            <div>{file && tree[file] !== undefined ? <><div className="dt-sub">{file} · {head && short(head.id)}</div><pre className="dt-code" aria-label="Contenido del archivo">{repo.objs.blobs[tree[file]]}</pre></> : <div className="dt-sub">Seleccione un archivo.</div>}</div>
          </div>
        ))}
        {tab === 'commits' && (
          <>
            <Table rows={commits} id={(c) => c.id} empty={{ title: 'Sin commits' }} cols={[
              { head: 'ID', cell: (c) => <a onClick={() => setCommit(c.id)}>{short(c.id)}</a>, text: (c) => c.id },
              { head: 'Mensaje', cell: (c) => c.message.split('\n')[0], text: (c) => c.message },
              { head: 'Autor', cell: (c) => c.author.name, text: (c) => c.author.name },
              { head: 'Fecha', cell: (c) => ts(c.author.date), text: (c) => String(c.author.date) },
            ]} />
            {selCommit && (
              <div className="dt-pad">
                <h4>Commit {selCommit.id}</h4>
                <pre className="dt-code" aria-label="Diferencias">{(() => { const prev = repo.objs.commits[selCommit.parents[0]]?.tree ?? {}; return diffTrees(prev, selCommit.tree).map((d) => unifiedDiff(d.path, d.kind === 'A' ? null : repo.objs.blobs[prev[d.path]], d.kind === 'D' ? null : repo.objs.blobs[selCommit.tree[d.path]])).join('') || '(sin cambios)'; })()}</pre>
              </div>
            )}
          </>
        )}
        {tab === 'branches' && (
          <Table rows={branches} id={(b) => b} empty={{ title: 'Sin ramas' }} cols={[
            { head: 'Rama', cell: (b) => <>{b} {b === repo.defaultBranch && <Status tone="">predeterminada</Status>}</>, text: (b) => b },
            { head: 'Último commit', cell: (b) => <code>{short(repo.branches[b])}</code>, text: (b) => repo.branches[b] },
            { head: 'Mensaje', cell: (b) => repo.objs.commits[repo.branches[b]]?.message.split('\n')[0], text: (b) => b },
          ]} />
        )}
        {tab === 'prs' && (
          <>
            <Table rows={prs} id={(p) => p.id} empty={{ title: 'Sin solicitudes', desc: 'Cree una con aws codecommit create-pull-request.' }} cols={[
              { head: 'ID', cell: (p) => <a onClick={() => setPr(p.id)}>#{p.id}</a>, text: (p) => p.id },
              { head: 'Título', cell: (p) => p.title, text: (p) => p.title },
              { head: 'Origen → destino', cell: (p) => `${p.source} → ${p.dest}`, text: (p) => p.source },
              { head: 'Estado', cell: (p) => <Badge s={p.merged ? 'MERGED' : p.status} />, text: (p) => p.status },
            ]} />
            {selPr && ev && (
              <div className="dt-pad">
                <h4>#{selPr.id} {selPr.title}</h4>
                <Dl items={[['Autor', selPr.author], ['Origen', `${selPr.source} (${short(selPr.sourceCommit)})`], ['Destino', selPr.dest], ['Aprobaciones', selPr.approvals.filter((a) => a.state === 'APPROVE').map((a) => a.user.split('/').pop()).join(', ') || '–'], ['Reglas de aprobación', selPr.rules.length ? (ev.approved ? 'Cumplidas' : `Pendientes: ${ev.notSatisfied.join(', ')}`) : 'Ninguna']]} />
                <div className="dt-row">
                  <Btn disabled={selPr.status !== 'OPEN'} onClick={() => act(`aws codecommit update-pull-request-approval-state --pull-request-id ${selPr.id} --revision-id ${selPr.revisionId} --approval-state APPROVE`, 'Solicitud aprobada.')}>Aprobar</Btn>
                  <Btn disabled={selPr.status !== 'OPEN'} kind="primary" onClick={() => act(`aws codecommit merge-pull-request-by-three-way --pull-request-id ${selPr.id} --repository-name ${repo.name}`, 'Solicitud combinada.')}>Combinar</Btn>
                  <Btn disabled={selPr.status !== 'OPEN'} onClick={() => act(`aws codecommit update-pull-request-status --pull-request-id ${selPr.id} --pull-request-status CLOSED`, 'Solicitud cerrada.')}>Cerrar</Btn>
                </div>
                <CliEquivalent cmd={`aws codecommit get-pull-request --pull-request-id ${selPr.id}`} />
              </div>
            )}
          </>
        )}
        {tab === 'info' && <div className="dt-pad"><Dl items={[['ARN', repo.arn], ['ID', repo.id], ['Rama predeterminada', repo.defaultBranch ?? '–'], ['Creado', ts(repo.created)], ['Modificado', ts(repo.modified)]]} cols={2} /><CliEquivalent cmd={`aws codecommit get-repository --repository-name ${q(repo.name)}`} /></div>}
      </div>
    </>
  );
}
