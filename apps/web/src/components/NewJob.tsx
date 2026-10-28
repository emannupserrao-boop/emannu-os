import { useState } from 'react';
import type { AgentState, Project, RunnableAgent, Risk } from '../../../../packages/shared/types.ts';
import { projectsForNewJobs } from '../../../../packages/shared/projects.ts';
import { actions } from '../api.ts';
import { X } from 'lucide-react';

const NEW_PROJECT = '__novo__';

const AGENT_NAME: Record<RunnableAgent, string> = { claude: 'Claude', codex: 'Codex', openclaw: 'OpenClaw', hermes: 'Hermes' };

export function NewJob(props: { projects: Project[]; agents: AgentState[]; defaultProject: string | null; onClose(): void; onCreated(): void }) {
  const projects = projectsForNewJobs(props.projects);
  // Claude e Codex sempre; OpenClaw e Hermes quando estiverem instalados neste PC.
  const choices = (['claude', 'codex', 'openclaw', 'hermes'] as RunnableAgent[]).filter((a) => a === 'claude' || a === 'codex' || props.agents.find((x) => x.id === a)?.installed);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [agent, setAgent] = useState<RunnableAgent>('claude');
  const [projectId, setProjectId] = useState(projects.find((p) => p.id === props.defaultProject)?.id ?? projects[0]?.id ?? '');
  const [risk, setRisk] = useState<Risk>('verde');
  const [timeoutMin, setTimeoutMin] = useState(30);
  const [gpu, setGpu] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let pid = projectId;
      if (pid === NEW_PROJECT) pid = (await actions.addProject(newName, newPath)).id;
      await actions.createJob({ title, prompt, agent, projectId: pid, risk, timeoutMin, gpuRequired: gpu });
      props.onCreated();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="drawer-backdrop" onClick={props.onClose}>
      <form className="drawer form" role="dialog" aria-modal="true" aria-label="Novo job" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div className="drawer-title">
            <h2>Novo job</h2>
          </div>
          <button type="button" className="btn btn-icon btn-ghost" onClick={props.onClose} aria-label="Fechar">
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>
        <div className="drawer-body">
          <label className="field">
            <span>Título</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex.: Criar página de contato" required autoFocus />
          </label>
          <label className="field">
            <span>Tarefa para o agente</span>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={6} placeholder="Descreva o que deve ser feito e como saber que está pronto." required />
          </label>

          <fieldset className="field">
            <legend>Agente</legend>
            <div className="segmented">
              {choices.map((a) => (
                <label key={a} className={agent === a ? 'on' : ''}>
                  <input type="radio" name="agent" value={a} checked={agent === a} onChange={() => setAgent(a)} />
                  {AGENT_NAME[a]}
                </label>
              ))}
            </div>
            <small>Claude: UI/UX, jogos, pesquisa e texto. Codex: backend, refatoração e QA.{choices.includes('openclaw') ? ' OpenClaw: agente aberto com o Claude Code como motor (revisado pelo Codex).' : ''}{choices.includes('hermes') ? ' Hermes: agente aberto com o ChatGPT (sua assinatura), revisado pelo Claude.' : ''}</small>
          </fieldset>

          <label className="field">
            <span>Projeto</span>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.isGit ? '' : ' (sem git)'}
                </option>
              ))}
              <option value={NEW_PROJECT}>+ Adicionar projeto…</option>
            </select>
          </label>
          {projectId === NEW_PROJECT && (
            <div className="field-group">
              <label className="field">
                <span>Nome do projeto</span>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Ex.: MIRAE" required />
              </label>
              <label className="field">
                <span>Pasta no PC</span>
                <input value={newPath} onChange={(e) => setNewPath(e.target.value)} placeholder="D:\Claude Code\mirae" required />
              </label>
            </div>
          )}

          <fieldset className="field">
            <legend>Risco</legend>
            <div className="segmented">
              {(['verde', 'amarelo'] as const).map((r) => (
                <label key={r} className={risk === r ? 'on' : ''}>
                  <input type="radio" name="risk" value={r} checked={risk === r} onChange={() => setRisk(r)} />
                  {r === 'verde' ? 'Verde (roda sozinho)' : 'Amarelo (pede aprovação)'}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="field">
            <span>Tempo limite (minutos)</span>
            <input type="number" min={1} max={120} value={timeoutMin} onChange={(e) => setTimeoutMin(Number(e.target.value))} />
            {timeoutMin > 120 && <small>O teto é 120 min (com checkpoint a cada 15): divida a tarefa.</small>}
          </label>

          <label className="check">
            <input type="checkbox" checked={gpu} onChange={(e) => setGpu(e.target.checked)} /> Usa a GPU (render, modelo local, instalação pesada): espera a placa livre e pausa no modo jogo
          </label>

          {error && <p className="job-error">{error}</p>}
        </div>
        <footer className="drawer-actions">
          <button type="button" className="btn" onClick={props.onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Criando…' : 'Criar job'}
          </button>
        </footer>
      </form>
    </div>
  );
}
