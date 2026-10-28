import type { AgentState, SistemaView } from '../../../../packages/shared/types.ts';
import { AgentMark } from './AgentMark.tsx';

function describe(a: AgentState): { state: 'free' | 'busy' | 'paused' | 'off' | 'warn'; label: string } {
  if (a.id === 'rocky') {
    if (!a.installed) return { state: 'off', label: 'Precisa do Claude' };
    return a.runningJobs.length ? { state: 'busy', label: 'Planejando…' } : { state: 'free', label: 'Pronto para planejar' };
  }
  if (!a.runnable) return { state: 'off', label: a.note ?? 'Desconectado' };
  if (!a.installed) return { state: 'off', label: 'Não encontrado neste PC' };
  if (a.authenticated === false) return { state: 'warn', label: 'Sem login' };
  if (a.paused) return { state: 'paused', label: 'Fila pausada (limite de uso)' };
  if (a.runningJobs.length) return { state: 'busy', label: `Ocupado · ${a.runningJobs.length}/${a.limit}` };
  return { state: 'free', label: a.authenticated === null ? 'Verificando…' : 'Livre' };
}

export function AgentBar({ agents, sistema, onResume, onOpen }: { agents: AgentState[]; sistema?: SistemaView | null; onResume(id: string): void; onOpen(id: string): void }) {
  const jogo = sistema?.modoJogo;
  return (
    <section className="agent-bar" aria-label="Agentes">
      {jogo?.ativo && (
        <article className="agent-chip game-chip" title={jogo.motivo ?? ''} role="status">
          <span className="game-icon" aria-hidden>
            🎮
          </span>
          <div className="agent-chip-text">
            <div className="agent-name">Modo jogo</div>
            <div className="agent-status">{jogo.pausarTudo ? 'Tudo pausado' : 'GPU pausada'}</div>
            <div className="agent-meta">{jogo.motivo}</div>
          </div>
        </article>
      )}
      {agents.map((a) => {
        const d = describe(a);
        return (
          <article key={a.id} className={`agent-chip is-${d.state}`} title={a.role}>
            <button className="agent-open" onClick={() => onOpen(a.id)} aria-label={`Ver ${a.name} na aba Agentes`}>
            <AgentMark id={a.id} size={36} />
            <div className="agent-chip-text">
              <div className="agent-name">
                <span className={`dot dot-${d.state}`} aria-hidden />
                {a.name}
              </div>
              <div className="agent-status">{d.label}</div>
              {a.id === 'rocky' && <div className="agent-meta">{a.note}</div>}
              {a.runnable && (
                <div className="agent-meta">
                  {[a.version && `v${a.version}`, a.authenticated && 'autenticado', a.note].filter(Boolean).join(' · ') || '—'}
                </div>
              )}
            </div>
            </button>
            {a.paused && (
              <button className="btn btn-small" onClick={() => onResume(a.id)}>
                Retomar
              </button>
            )}
          </article>
        );
      })}
    </section>
  );
}
