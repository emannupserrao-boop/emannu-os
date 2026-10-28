import { useEffect, useMemo, useState } from 'react';
import { Bot, Coins, Cpu, Gauge } from 'lucide-react';
import type { AgentState, ClientConfig, HarnessView, Job, JobUsage, Project, SistemaView } from '../../../../packages/shared/types.ts';
import { api, formatDuration, obsidianLink } from '../api.ts';
import { Skeleton } from '../motion.tsx';
import { AgentMark } from './AgentMark.tsx';

// Aba Agentes: cada harness (programa que roda agentes), os agentes que existem
// nele, quem está trabalhando agora e quanto contexto/tokens cada execução usa.

export const ANALYSIS_NOTE = '80 - AUTOMATION/Análise - Hermes e OpenClaw no EMANNU OS.md';

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}
const usd = (n: number) => `US$ ${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
export const tokensOf = (u: JobUsage | null) => (u ? u.input + u.output + u.cacheRead + u.cacheWrite : 0);

// Barra de contexto: quanto da janela do modelo esta execução já ocupa.
export function ContextBar({ u, compact = false }: { u: JobUsage | null; compact?: boolean }) {
  if (!u || !u.context) return compact ? null : <span className="hint">contexto: aguardando a primeira resposta…</span>;
  const pct = u.contextMax ? Math.min(100, (u.context / u.contextMax) * 100) : null;
  const tone = pct === null ? '' : pct >= 85 ? 'bad' : pct >= 60 ? 'warn' : 'ok';
  if (compact) return <span className={`ctx-chip ${tone}`}>ctx {pct === null ? fmtTokens(u.context) : `${Math.round(pct)}%`}</span>;
  return (
    <div className="ctx">
      <div className="ctx-label">
        <span>Contexto</span>
        <span className="mono">
          {fmtTokens(u.context)}
          {u.contextMax ? ` / ${fmtTokens(u.contextMax)} · ${pct!.toFixed(pct! < 10 ? 1 : 0)}%` : ''}
        </span>
      </div>
      <div className={`ctx-bar ${tone}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} aria-label="Contexto usado">
        <span style={{ width: `${pct ?? 0}%` }} />
      </div>
    </div>
  );
}

export function TokenLine({ u }: { u: JobUsage | null }) {
  if (!u) return null;
  return (
    <p className="tokline">
      <span>entrada {fmtTokens(u.input)}</span>
      <span>saída {fmtTokens(u.output)}</span>
      <span>cache lido {fmtTokens(u.cacheRead)}</span>
      {u.cacheWrite > 0 && <span>cache gravado {fmtTokens(u.cacheWrite)}</span>}
      {u.costUsd !== null && <span title="Valor equivalente na API; na assinatura não é cobrado por token">≈ {usd(u.costUsd)} em API</span>}
    </p>
  );
}

const ESTADO: Record<HarnessView['estado'], [string, string]> = {
  ativo: ['Ativo', 'ok'],
  pausado: ['Fila pausada', 'warn'],
  sem_login: ['Sem login', 'warn'],
  sem_adaptador: ['Instalado — sem adaptador', 'warn'],
  nao_instalado: ['Não instalado', 'neutral'],
};
const ROLE_OF: Record<Job['kind'], string> = { plan: 'Planejador', task: 'Executor', review: 'Revisor', fix: 'Corretor', research: 'Pesquisador' };
const AGENT_OF: Record<string, Job['agent']> = { 'claude-code': 'claude', codex: 'codex', openclaw: 'openclaw', hermes: 'hermes' };

const isToday = (iso: string | null) => !!iso && new Date(iso).toDateString() === new Date().toDateString();
const when = (iso: string) => {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return `hoje às ${hm}`;
  if (d.getTime() < Date.now()) return 'agora';
  return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${hm}`;
};

const GROUP_LABEL: Record<string, string> = { claude: 'Grupo Claude', chatgpt: 'Grupo ChatGPT', local: 'Modelo local (GPU)' };

export function Agentes(props: {
  sistema?: SistemaView | null;
  jobs: Record<string, Job>;
  agents: AgentState[];
  projectsById: Record<string, Project>;
  config: ClientConfig;
  now: number;
  focus?: { id: string; at: number } | null;
  onOpenJob(id: string): void;
  onError(m: string): void;
}) {
  const [list, setList] = useState<HarnessView[] | null>(null);
  // Recarrega quando o estado dos agentes muda (instalação, login, pausa, limites).
  const agentsKey = props.agents.map((a) => `${a.id}:${a.installed}:${a.authenticated}:${a.paused}:${a.version}`).join('|');
  useEffect(() => {
    api<HarnessView[]>('/api/agentes')
      .then(setList)
      .catch((e) => props.onError(e.message));
  }, [agentsKey]);

  useEffect(() => {
    if (!list || !props.focus) return;
    const id = props.focus.id === 'rocky' ? 'claude' : props.focus.id;
    const el = document.getElementById(`harness-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.remove('flash');
    void el.offsetWidth; // reinicia a animação
    el.classList.add('flash');
  }, [list, props.focus?.at]);

  const jobs = useMemo(() => Object.values(props.jobs), [props.jobs]);
  const running = jobs.filter((j) => j.status === 'running');
  const todayAll = jobs.filter((j) => isToday(j.finishedAt ?? j.startedAt));
  // Sem dados de uso = desconhecido (não entra na soma como zero).
  const today = todayAll.filter((j) => j.usage);
  const totalToday = today.reduce((a, j) => a + tokensOf(j.usage), 0);
  const costToday = today.reduce((a, j) => a + (j.usage?.costUsd ?? 0), 0);

  if (!list) return <Skeleton cards={4} label="Carregando os agentes" />;
  return (
    <main className="imm">
      <header className="imm-head">
        <span className="plogo mono-logo ia-logo" aria-hidden>
          <Bot size={26} strokeWidth={1.5} />
        </span>
        <div>
          <h2>Agentes</h2>
          <p className="hint">Quem existe em cada harness, quem está trabalhando agora e quanto contexto e tokens cada execução usa.</p>
        </div>
      </header>
      <div className="kpis kpis-top">
        <div>
          <span className="hint">
            <Cpu size={14} aria-hidden /> Trabalhando agora
          </span>
          <b>{running.length}</b>
        </div>
        <div>
          <span className="hint">
            <Gauge size={14} aria-hidden /> Tokens hoje
          </span>
          <b>{fmtTokens(totalToday)}</b>
        </div>
        <div>
          <span className="hint">
            <Coins size={14} aria-hidden /> Equivalente em API hoje
          </span>
          <b>{usd(costToday)}</b>
        </div>
      </div>
      {props.sistema && (
        <section className="capacidade" aria-label="Capacidade por grupo">
          {props.sistema.capacidade.map((g) => {
            const livre = Math.floor((g.dailyMinutes * (100 - g.reservedPct)) / 100);
            const pct = Math.min(100, ((g.usadoHoje + g.reservadoAgora) / g.dailyMinutes) * 100);
            return (
              <div key={g.id} className={`cap ${g.pausadoAte ? 'paused' : ''}`}>
                <b>{GROUP_LABEL[g.id] ?? g.id}</b>
                <span className="hint">{g.agentes.join(', ')} · até {g.maxParallel} ao mesmo tempo</span>
                <div className="cap-bar" role="progressbar" aria-label={`Uso do dia: ${GROUP_LABEL[g.id] ?? g.id}`} aria-valuemin={0} aria-valuemax={g.dailyMinutes} aria-valuenow={g.usadoHoje + g.reservadoAgora}>
                  <i style={{ width: `${pct}%` }} />
                  <s style={{ width: `${g.reservedPct}%` }} />
                </div>
                <span className="hint">
                  {g.usadoHoje} min usados{g.reservadoAgora ? ` + ${g.reservadoAgora} reservados` : ''} de {livre} (+{g.dailyMinutes - livre} só para clientes)
                </span>
                {g.pausadoAte && <span className="ibadge tone-warn">Pausado até {new Date(g.pausadoAte).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>}
              </div>
            );
          })}
          <div className="cap">
            <b>GPU (RTX 5080)</b>
            <span className="hint">{props.sistema.gpu ? `Em uso: ${props.sistema.gpu.titulo ?? props.sistema.gpu.jobId}` : 'Livre'}</span>
            {props.sistema.modoJogo.ativo && <span className="ibadge tone-warn">🎮 Modo jogo: GPU pausada</span>}
            {props.sistema.autoMerge && (
              <span className="hint">
                Auto-merge: {props.sistema.autoMerge.suspenso ? `suspenso — ${props.sistema.autoMerge.suspenso}` : `${props.sistema.autoMerge.limpas} integração(ões) limpa(s) no Sandbox`}
              </span>
            )}
          </div>
        </section>
      )}
      <div className="hgrid">
        {list.map((h) => {
          const agent = AGENT_OF[h.id];
          const mine = agent ? running.filter((j) => j.agent === agent) : [];
          const done = agent ? today.filter((j) => j.agent === agent && j.status !== 'running') : [];
          const unknown = agent ? todayAll.filter((j) => j.agent === agent && j.status !== 'running' && !j.usage).length : 0;
          const [label, tone] = ESTADO[h.estado];
          return (
            <section key={h.id} id={`harness-${h.agentId}`} className={`icard hcard ${mine.length ? 'busy' : ''} ${h.estado === 'nao_instalado' ? 'off' : ''}`}>
              <header className="hhead">
                <AgentMark id={h.agentId} size={40} />
                <div className="htitle">
                  <h3>{h.nome}</h3>
                  <p className="hint">{[h.versao && `v${h.versao.replace(/^v/, '')}`, h.modelo].filter(Boolean).join(' · ') || '—'}</p>
                </div>
                <span className={`ibadge tone-${tone}`}>{label}</span>
              </header>
              {h.limites && <p className="hint">Uso: {h.limites}</p>}

              {agent && (
                <>
                  <h4>
                    Trabalhando agora {mine.length > 0 && <span className="count">{mine.length}</span>}
                  </h4>
                  {mine.length ? (
                    mine.map((j) => (
                      <button key={j.id} className="hrun" onClick={() => props.onOpenJob(j.id)}>
                        <div className="hrun-head">
                          <span className="dot dot-busy" aria-hidden />
                          <b>{ROLE_OF[j.kind]}</b>
                          <span className="hrun-title">{j.title}</span>
                          <span className="mono hint">{j.startedAt ? formatDuration(props.now - Date.parse(j.startedAt)) : ''}</span>
                        </div>
                        <p className="hint">
                          {props.projectsById[j.projectId]?.name ?? j.projectId}
                          {j.usage?.model ? ` · ${j.usage.model}` : ''}
                          {j.step ? ` · ${j.step}` : ''}
                        </p>
                        <ContextBar u={j.usage} />
                        <TokenLine u={j.usage} />
                      </button>
                    ))
                  ) : (
                    <p className="hint">Nenhum agente trabalhando agora.</p>
                  )}
                  <p className="hint htoday">
                    Hoje: {done.length} job(s) concluído(s) · {fmtTokens(done.reduce((a, j) => a + tokensOf(j.usage), 0))} tokens
                    {unknown > 0 && ` · ${unknown} sem dados de tokens`}
                  </p>
                </>
              )}

              <h4>Agentes {h.agentes.length > 0 && <span className="count">{h.agentes.length}</span>}</h4>
              {h.agentes.length ? (
                <ul className="hagents">
                  {h.agentes.map((a) => {
                    const busy = a.agenda ? (a.agenda.rodando ? 1 : 0) : a.kind ? mine.filter((j) => j.kind === a.kind).length : 0;
                    return (
                      <li key={`${a.origem}:${a.id}`} className={`${busy ? 'on' : ''} ${a.agenda ? 'scheduled' : ''}`}>
                        <span className={`dot ${busy ? 'dot-busy' : a.origem === 'emannu' ? 'dot-free' : 'dot-off'}`} aria-hidden />
                        <span className="hagent-name">{a.nome}</span>
                        <span className="hint hagent-role">
                          {a.papel}
                          {a.agenda && (
                            <span className="agenda">
                              {' '}
                              · {a.agenda.frequencia}
                              {a.agenda.ultima ? ` · última ${when(a.agenda.ultima)}` : ''}
                              {a.agenda.rodando ? ' · pesquisando agora' : a.agenda.proxima ? ` · próxima ${when(a.agenda.proxima)}` : ''}
                            </span>
                          )}
                        </span>
                        <span className="ibadge tone-neutral">{busy ? `trabalhando${busy > 1 ? ` ×${busy}` : ''}` : a.origem === 'emannu' ? 'EMANNU OS' : `do ${h.nome}`}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="hint">Nenhum agente — {h.estado === 'nao_instalado' ? 'o programa não está instalado neste PC.' : 'nada configurado.'}</p>
              )}
              {h.nota && <p className="hint hnote">{h.nota}</p>}
              {(h.id === 'openclaw' || h.id === 'hermes') && props.config.vaultName && (
                <a className="btn btn-small btn-link" href={obsidianLink(props.config, ANALYSIS_NOTE)}>
                  Ver a análise de integração
                </a>
              )}
            </section>
          );
        })}
      </div>
    </main>
  );
}
