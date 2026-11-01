import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, GitBranch, GitPullRequest, X } from 'lucide-react';
import type { ClientConfig, GitHubView, Job, ProjectCard } from '../../../../packages/shared/types.ts';
import { actions, api, formatTime, obsidianLink } from '../api.ts';
import { Skeleton } from '../motion.tsx';
import { Md } from './Md.tsx';
import { STATUS_LABEL } from './JobCard.tsx';

const KIND_LABEL: Record<string, [string, string]> = { image: ['imagem', 'imagens'], audio: ['áudio', 'áudios'], video: ['vídeo', 'vídeos'] };
const kindCount = (k: string, n: number) => `${n} ${KIND_LABEL[k]?.[n === 1 ? 0 : 1] ?? k}`;
const fileUrl = (id: string) => `/api/legado/arquivo/${encodeURIComponent(id)}`;

function Logo({ p }: { p: ProjectCard }) {
  const [failed, setFailed] = useState(false);
  if (p.logo && !failed) return <img className="plogo" src={p.logo} alt="" onError={() => setFailed(true)} />;
  return (
    <span className="plogo mono-logo" aria-hidden>
      {p.nome.slice(0, 1)}
    </span>
  );
}

function LinkFolder({ p, onDone, onError }: { p: ProjectCard; onDone(): void; onError(m: string): void }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState('');
  if (!open)
    return (
      <button className="btn btn-small" onClick={() => setOpen(true)}>
        Vincular pasta do PC
      </button>
    );
  return (
    <form
      className="linkfolder"
      onSubmit={(e) => {
        e.preventDefault();
        actions.addProject(p.nome, path).then(onDone).catch((err) => onError(err.message));
      }}
    >
      <label className="field">
        <span>Pasta de {p.nome} no PC</span>
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="D:\Claude Code\..." required autoFocus />
      </label>
      <button className="btn btn-primary" type="submit">
        Vincular
      </button>
    </form>
  );
}

const short = (iso: string) => (iso ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '—');

function Bullets({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <>
      <b>{title}</b>
      <ul className="ilist">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </>
  );
}

// O que já foi feito em sessões do Claude Code nas pastas deste projeto.
function CodeHistory({ p, config, onError, onRefresh }: { p: ProjectCard; config: ClientConfig; onError(m: string): void; onRefresh(): void }) {
  const [open, setOpen] = useState(false);
  const c = p.codigo;
  if (!c || !c.total) return null;
  const h = c.historico;
  const generate = () =>
    api(`/api/projetos/${encodeURIComponent(p.id)}/historico`, {})
      .then(onRefresh)
      .catch((e) => onError(e.message));
  return (
    <section className="codehist">
      <h4>No Claude Code ({c.total} {c.total > 1 ? 'sessões' : 'sessão'})</h4>
      {h ? (
        <>
          <Md text={h.resumo} className="pstate" />
          <button className="iexpand" onClick={() => setOpen(!open)} aria-expanded={open}>
            <span>{open ? 'Esconder detalhes' : 'Ver o que foi feito, decisões e pendências'}</span>
            <span>{open ? '−' : '+'}</span>
          </button>
          {open && (
            <div className="legacy">
              <Bullets title="Feito" items={h.feito} />
              <Bullets title="Decisões" items={h.decisoes} />
              <Bullets title="Entregas" items={h.entregas.map((e) => (e.caminho ? `${e.titulo} — ${e.caminho}` : e.titulo))} />
              <Bullets title="Pendências" items={h.pendencias} />
              <Bullets title="Próximos passos" items={h.proximos} />
              <b>Sessões</b>
              <ul className="ilist">
                {c.sessoes.map((s) => (
                  <li key={s.id}>
                    {s.title} <span className="hint">· {short(s.firstAt)}–{short(s.lastAt)} · {s.prompts} pedidos</span>
                  </li>
                ))}
              </ul>
              <p className="hint">Resumo gerado em {formatTime(h.geradoEm)} a partir de {h.sessoes} sessão(ões).</p>
            </div>
          )}
        </>
      ) : (
        <ul className="ilist">
          {c.sessoes.slice(0, 4).map((s) => (
            <li key={s.id}>
              {s.title} <span className="hint">· {short(s.lastAt)} · {s.prompts} pedidos</span>
            </li>
          ))}
        </ul>
      )}
      <div className="job-actions flat">
        {c.gerando ? (
          <span className="hint">Gerando o resumo com o Claude…</span>
        ) : (
          <button className="btn btn-small" onClick={generate}>
            {h ? 'Atualizar resumo' : 'Resumir o que foi feito'}
          </button>
        )}
        {h?.vaultNote && config.vaultName && (
          <a className="btn btn-link btn-small" href={obsidianLink(config, h.vaultNote)}>
            Nota no vault
          </a>
        )}
      </div>
    </section>
  );
}

function ImmigrationSummary({ p, onOpen }: { p: ProjectCard; onOpen(): void }) {
  const m = p.imigracao!;
  return (
    <>
      <div className="kpis">
        <div>
          <span className="hint">Vagas no pipeline</span>
          <b>{m.vagas}</b>
          <span className="hint">{m.vagasComVisto} servem para visto · {m.candidaturasProntas} prontas p/ você enviar</span>
        </div>
        <div>
          <span className="hint">Documentos prontos</span>
          <b>
            {m.docsProntos}/{m.docsTotal}
          </b>
        </div>
        <div>
          <span className="hint">Próximo prazo</span>
          <b>{m.proximoPrazo ? `${m.proximoPrazo.diasAte} dias` : '—'}</b>
          <span className="hint">{m.proximoPrazo?.titulo}</span>
        </div>
        <div>
          <span className="hint">Fontes</span>
          <b>{m.fontes}</b>
          <span className="hint">{m.fontesRever} para rever</span>
        </div>
      </div>
      {m.naoConfirmados > 0 && <p className="alert">⚠ {m.naoConfirmados} ponto(s) ainda não confirmados no texto oficial — veja no Painel.</p>}
      <p className="hint">Pesquisa atualizada em {formatTime(m.pesquisadoEm)} (refeita toda semana).</p>
      <button className="btn btn-primary" onClick={onOpen}>
        Abrir o espaço Imigração Portugal
      </button>
    </>
  );
}

const DOCS_COMPACT = 4;

const CI_LABEL: Record<NonNullable<GitHubView['ci']>['estado'], [string, string]> = {
  ok: ['CI passou', 'tone-ok'],
  falhou: ['CI falhou', 'tone-bad'],
  rodando: ['CI rodando', 'tone-warn'],
  cancelado: ['CI cancelado', 'tone-neutral'],
  outro: ['CI', 'tone-neutral'],
};

function CiBadge({ ci }: { ci: NonNullable<GitHubView['ci']> }) {
  const [label, tone] = CI_LABEL[ci.estado];
  return (
    <a className={`ibadge ${tone}`} href={ci.url} target="_blank" rel="noreferrer" title={`${ci.nome} · ${ci.branch} · ${formatTime(ci.em)}`}>
      {label} · {ci.branch}
    </a>
  );
}

// GitHub do projeto (só leitura): repositório, último CI, PRs abertos e a pasta local.
function GitHubSection({ p, compact }: { p: ProjectCard; compact: boolean }) {
  if (!p.github?.length) return null;
  const list = compact ? p.github.filter((g) => g.papel === 'origem').concat(p.github.filter((g) => g.papel !== 'origem')).slice(0, 1) : p.github;
  return (
    <>
      <h4>GitHub</h4>
      {list.map((g) => (
        <div key={g.repo + g.papel} className="gh-repo">
          <div className="gh-line">
            <a href={g.url} target="_blank" rel="noreferrer" className="gh-name">
              {g.repo}
            </a>
            <span className={`ibadge ${g.privado ? 'tone-neutral' : 'tone-ok'}`}>{g.privado ? 'privado' : 'público'}</span>
            {g.papel === 'copia-publica' && <span className="ibadge tone-neutral">cópia pública limpa</span>}
            {g.ci && <CiBadge ci={g.ci} />}
            {!compact && g.ciOutro && <CiBadge ci={g.ciOutro} />}
          </div>
          {g.erro ? (
            <p className="hint">{g.erro}</p>
          ) : (
            <>
              {g.local && (
                <p className="hint gh-local">
                  <GitBranch size={13} aria-hidden /> No PC: <b>{g.local.branch}</b>
                  {g.local.alteracoes ? ` · ${g.local.alteracoes} arquivo(s) alterado(s) sem commit` : ' · tudo salvo'}
                  {g.local.aFrente ? ` · ${g.local.aFrente} commit(s) a enviar` : ''}
                  {g.local.atras ? ` · ${g.local.atras} commit(s) a trazer` : ''}
                </p>
              )}
              {g.ultimoCommit && !compact && (
                <p className="hint">
                  Último commit em {g.branchPadrao}:{' '}
                  <a href={g.ultimoCommit.url} target="_blank" rel="noreferrer">
                    {g.ultimoCommit.mensagem}
                  </a>{' '}
                  · {formatTime(g.ultimoCommit.data)}
                </p>
              )}
              {g.prsAbertos.length > 0 && (
                <ul className="ilist gh-prs">
                  {(compact ? g.prsAbertos.slice(0, 2) : g.prsAbertos).map((pr) => (
                    <li key={pr.numero}>
                      <GitPullRequest size={13} aria-hidden />{' '}
                      <a href={pr.url} target="_blank" rel="noreferrer">
                        #{pr.numero} {pr.titulo}
                      </a>
                      {pr.rascunho && <span className="hint"> · rascunho</span>}
                    </li>
                  ))}
                </ul>
              )}
              {!g.prsAbertos.length && !compact && <p className="hint">Nenhum PR aberto.</p>}
            </>
          )}
        </div>
      ))}
    </>
  );
}

function Card({ p, config, compact, onOpen, onNewObjective, onOpenImmigration, onRefresh, onError }: { p: ProjectCard; config: ClientConfig; compact: boolean; onOpen?(): void; onNewObjective(projectId: string): void; onOpenImmigration(): void; onRefresh(): void; onError(m: string): void }) {
  const [showLegacy, setShowLegacy] = useState(false);
  const docs = compact ? p.documentos.slice(0, DOCS_COMPACT) : p.documentos;
  return (
    <article className={`icard pcard ${compact ? 'compact' : ''}`}>
      <header className="phead">
        {onOpen ? (
          <button className="popen" onClick={onOpen} aria-label={`Abrir ${p.nome}`} title="Abrir o projeto">
            <Logo p={p} />
          </button>
        ) : (
          <Logo p={p} />
        )}
        <div className="ptitle">
          <h3>
            {onOpen ? (
              <button className="ptitle-link" onClick={onOpen}>
                {p.nome} <ChevronRight size={16} strokeWidth={2} aria-hidden />
              </button>
            ) : (
              p.nome
            )}
          </h3>
          <div className="badges">
            {p.isLegacy && <span className="ibadge tone-neutral">legado</span>}
            {p.aguardandoVoce > 0 && <span className="ibadge tone-warn">{p.aguardandoVoce} aguardando você</span>}
            {p.jobsAbertos > 0 && <span className="ibadge tone-neutral">{p.jobsAbertos} job(s) abertos</span>}
            {p.badge && <span className="ibadge tone-neutral">{p.badge}</span>}
          </div>
        </div>
      </header>

      {p.proposito && <p>{p.proposito}</p>}

      <h4>Estado atual</h4>
      {p.estadoAtual ? (
        <>
          <Md text={p.estadoAtual.texto} className={`pstate ${compact ? 'clamp' : ''}`} />
          {config.vaultName && (
            <a className="btn btn-link btn-small" href={obsidianLink(config, p.estadoAtual.fonte)}>
              Abrir no vault
            </a>
          )}
        </>
      ) : (
        <p className="hint">Sem nota Current State no vault.</p>
      )}

      {p.imigracao && <ImmigrationSummary p={p} onOpen={onOpenImmigration} />}

      <GitHubSection p={p} compact={compact} />

      <CodeHistory p={p} config={config} onError={onError} onRefresh={onRefresh} />

      {p.entregas.length > 0 && (
        <>
          <h4>Últimas entregas</h4>
          <ul className="ilist">
            {p.entregas.map((e) => (
              <li key={e.id}>
                {e.titulo} <span className="hint">· {e.tipo} · {formatTime(e.data)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {p.midias.total > 0 && (
        <>
          <h4>Mídias ({p.midias.total})</h4>
          <p className="hint">
            {Object.entries(p.midias.porTipo)
              .map(([k, n]) => kindCount(k, n))
              .join(' · ')}{' '}
            — os arquivos originais continuam onde estão.
          </p>
          {p.midias.amostra.length > 0 && (
            <div className="thumbs">
              {(compact ? p.midias.amostra.slice(0, 3) : p.midias.amostra).map((m) => (
                <a key={m.id} href={fileUrl(m.id)} target="_blank" rel="noreferrer" title={m.title}>
                  <img src={fileUrl(m.id)} alt={m.title} loading="lazy" />
                </a>
              ))}
            </div>
          )}
        </>
      )}

      {p.documentos.length > 0 && (
        <>
          <h4>Documentos ({p.documentos.length})</h4>
          <ul className="doclist">
            {docs.map((d) => (
              <li key={d.id}>
                <a href={fileUrl(d.id)} target="_blank" rel="noreferrer">
                  {d.title}
                </a>
                <span className="ibadge tone-neutral">{d.kind}</span>
              </li>
            ))}
          </ul>
          {compact && p.documentos.length > DOCS_COMPACT && onOpen && (
            <button className="btn btn-small btn-ghost" onClick={onOpen}>
              Ver todos os {p.documentos.length} documentos
            </button>
          )}
        </>
      )}

      {p.legado && (
        <>
          <button className="iexpand" onClick={() => setShowLegacy(!showLegacy)} aria-expanded={showLegacy}>
            <h4>Do cockpit antigo</h4>
            <span>{showLegacy ? '−' : '+'}</span>
          </button>
          {showLegacy && (
            <div className="legacy">
              <p className="hint">Importado em {formatTime(p.legado.importadoEm)} (só leitura; pode estar desatualizado).</p>
              {p.legado.estado && (
                <p>
                  <b>Estado:</b> {p.legado.estado}
                </p>
              )}
              {p.legado.feito && (
                <p>
                  <b>Feito:</b> {p.legado.feito}
                </p>
              )}
              {p.legado.proximos.length > 0 && (
                <>
                  <b>Próximos</b>
                  <ul className="ilist">
                    {p.legado.proximos.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                </>
              )}
              {p.legado.bloqueios.length > 0 && (
                <>
                  <b>Bloqueios</b>
                  <ul className="ilist">
                    {p.legado.bloqueios.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </>
      )}

      <footer className="pfoot" hidden={!!p.imigracao}>
        {p.pasta ? (
          <>
            <span className="hint mono">{p.pasta.path}</span>
            {p.isLegacy ? (
              <span className="hint">Projeto legado: consulte o histórico.</span>
            ) : p.pasta.isGit ? (
              <button className="btn btn-primary btn-small" onClick={() => onNewObjective(p.pasta!.projectId)}>
                + Objetivo
              </button>
            ) : (
              <span className="hint">Sem git: aceita jobs avulsos, não objetivos.</span>
            )}
          </>
        ) : (
          <>
            {p.nota && <p className="alert pnote">⚠ {p.nota}</p>}
            <LinkFolder p={p} onDone={onRefresh} onError={onError} />
          </>
        )}
      </footer>
    </article>
  );
}

// Painel do projeto (ao clicar no ícone ou no nome): tudo expandido + atividades do projeto.
function ProjectDrawer(props: { p: ProjectCard; config: ClientConfig; jobs: Job[]; onOpenJob(id: string): void; onClose(): void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onClose]);
  const pid = props.p.pasta?.projectId ?? props.p.id;
  const jobs = props.jobs.filter((j) => j.projectId === pid).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30);
  // Fora da área animada da tela (que tem camada própria), para ficar acima do topo.
  return createPortal(
    <div className="drawer-backdrop" onClick={props.onClose}>
      <aside className="drawer drawer-wide" role="dialog" aria-modal="true" aria-label={props.p.nome} onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div className="drawer-title">
            <h2>{props.p.nome}</h2>
            <p className="hint">{props.p.pasta?.path ?? props.p.vaultFolder ?? ''}</p>
          </div>
          <button className="btn btn-icon btn-ghost" onClick={props.onClose} aria-label="Fechar">
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>
        <div className="drawer-body">
          <h4>Atividades deste projeto ({jobs.length})</h4>
          {jobs.length ? (
            <ul className="pjobs">
              {jobs.map((j) => (
                <li key={j.id}>
                  <button className="tl-button" onClick={() => props.onOpenJob(j.id)}>
                    <span className={`pill pill-${j.status}`}>{STATUS_LABEL[j.status]}</span>
                    <span className="tl-label">{j.title}</span>
                    <span className="tl-dur">{formatTime(j.finishedAt ?? j.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">Nenhuma atividade ainda.</p>
          )}
          {props.children}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

export function Projetos(props: { config: ClientConfig; version: string; jobs: Job[]; onOpenJob(id: string): void; onNewObjective(projectId: string): void; onOpenImmigration(): void; onError(m: string): void }) {
  const [cards, setCards] = useState<ProjectCard[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const load = () => api<ProjectCard[]>('/api/projetos').then(setCards).catch((e) => props.onError(e.message));
  // Recarrega quando jobs/objetivos mudam (props.version) — os números do card vêm do servidor.
  useEffect(() => {
    load();
  }, [props.version]);
  // O GitHub demorou: busca de novo em alguns segundos (o servidor continua buscando em segundo plano).
  // Se a nova busca falhar (rede), tenta outra vez; no máximo 10 tentativas seguidas.
  const pendente = !!cards?.some((c) => c.githubPendente);
  const [tentativas, setTentativas] = useState(0);
  useEffect(() => {
    if (!pendente) {
      if (tentativas) setTentativas(0);
      return;
    }
    if (tentativas >= 10) return;
    const t = setTimeout(() => {
      api<ProjectCard[]>('/api/projetos')
        .then(setCards)
        .catch(() => {})
        .finally(() => setTentativas((n) => n + 1));
    }, 7000);
    return () => clearTimeout(t);
  }, [pendente, cards, tentativas]);
  if (!cards) return <Skeleton cards={4} label="Carregando projetos" />;
  const opened = cards.find((c) => c.id === openId) ?? null;
  const common = { config: props.config, onNewObjective: props.onNewObjective, onOpenImmigration: props.onOpenImmigration, onRefresh: load, onError: props.onError };
  return (
    <>
      <main className="pgrid">
        {cards.map((p) => (
          <Card key={p.id} p={p} compact onOpen={p.imigracao ? props.onOpenImmigration : () => setOpenId(p.id)} {...common} />
        ))}
      </main>
      {opened && (
        <ProjectDrawer p={opened} config={props.config} jobs={props.jobs} onOpenJob={props.onOpenJob} onClose={() => setOpenId(null)}>
          <Card p={opened} compact={false} {...common} />
        </ProjectDrawer>
      )}
    </>
  );
}
