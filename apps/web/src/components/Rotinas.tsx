// Aba Rotinas: a agenda do sistema (única), o histórico do modo jogo, a memória do
// Hermes (perfil "pesquisa") e o Conselho.
import { useEffect, useState } from 'react';
import { CalendarClock, Gamepad2, Brain, Scale, Cpu } from 'lucide-react';
import type { RoutineView } from '../../../../packages/shared/renda.ts';
import { api, rendaApi } from '../api.ts';
import { Skeleton } from '../motion.tsx';

const ESTADO: Record<string, [string, string]> = { done: ['ok', 'ok'], failed: ['falhou', 'bad'], running: ['rodando', 'warn'], pending: ['na fila', 'warn'] };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const AGENTE: Record<string, string> = { hermes: 'Hermes', claude: 'Claude', codex: 'Codex', openclaw: 'OpenClaw', sistema: 'Sistema' };

interface MemoryItem { tipo: string; texto: string; url: string; data: string; validade: string }
interface Caso { id: string; pergunta: string; estado: string; criadoEm: string; vaultNote: string | null }
interface Bench { ultimo: { em: string; modelos: string[]; decisoes: { tarefa: string; modelo: string; local: number; claude: number; razao: number; aprovado: boolean }[] } | null; lmStudio: string[] | null; rodando: boolean }
const TAREFA: Record<string, string> = { historico: 'Resumo de histórico', 'triagem-log': 'Triagem de log', 'classificar-lead': 'Classificação de lead', 'mirae-gsi': 'MIRAE: evento GSI' };

export function Rotinas(props: { version: number | string; onError(m: string): void; onToast(m: string): void; onOpenJob(id: string): void }) {
  const [data, setData] = useState<{ rotinas: RoutineView[]; modoJogo: { inicio: string; fim: string | null; motivo: string }[] } | null>(null);
  const [mem, setMem] = useState<MemoryItem[]>([]);
  const [casos, setCasos] = useState<Caso[]>([]);
  const [pergunta, setPergunta] = useState('');
  const [bench, setBench] = useState<Bench | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    rendaApi.routines().then(setData).catch((e) => props.onError(e.message));
    api<MemoryItem[]>('/api/memoria').then(setMem).catch(() => {});
    api<Caso[]>('/api/conselho').then(setCasos).catch(() => {});
    api<Bench>('/api/benchmark').then(setBench).catch(() => {});
  }, [props.version, reload]);

  if (!data) return <Skeleton cards={3} label="Carregando as rotinas…" />;

  const toggle = (r: RoutineView) => rendaApi.setRoutine(r.id, !r.enabled).then(() => setReload((n) => n + 1)).catch((e) => props.onError(e.message));
  const ask = () =>
    api('/api/conselho', { pergunta })
      .then(() => {
        setPergunta('');
        props.onToast('Pergunta enviada ao Conselho (Claude e ChatGPT em paralelo)');
        setReload((n) => n + 1);
      })
      .catch((e) => props.onError(e.message));

  return (
    <main className="imm rotinas">
      <header className="imm-head">
        <span className="plogo mono-logo ia-logo" aria-hidden>
          <CalendarClock size={26} strokeWidth={1.5} />
        </span>
        <div>
          <h2>Rotinas</h2>
          <p className="hint">A única agenda do sistema (horário de Bucareste). Cada execução é reservada no banco: reinícios não duplicam, e uma falha é retomada até 2 vezes.</p>
        </div>
      </header>

      <ul className="rlist">
        {data.rotinas.map((r) => {
          const [label, tone] = r.ultima ? ESTADO[r.ultima.estado] : ['nunca rodou', 'neutral'];
          return (
            <li key={r.id} className={`rcard ${r.enabled ? '' : 'off'}`}>
              <div className="rmain">
                <b>{r.nome}</b>
                <p className="hint clamp-2">{r.descricao}</p>
                <p className="hint">
                  {AGENTE[r.agente] ?? r.agente} · <span className="mono">{r.schedule}</span> · próxima: {r.enabled ? when(r.proxima) : 'desligada'}
                </p>
              </div>
              <div className="rside">
                <span className={`ibadge tone-${tone}`}>{label}</span>
                {r.ultima && <span className="hint">{when(r.ultima.em)}</span>}
                {r.ultima?.jobId && (
                  <button className="btn btn-small btn-ghost" onClick={() => props.onOpenJob(r.ultima!.jobId!)}>
                    Ver job
                  </button>
                )}
                <label className="check">
                  <input type="checkbox" checked={r.enabled} onChange={() => toggle(r)} aria-label={`${r.enabled ? 'Desligar' : 'Ligar'} ${r.nome}`} /> ligada
                </label>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="icard">
        <h3>
          <Scale size={16} aria-hidden /> Conselho
        </h3>
        <p className="hint">Para decisões caras ou irreversíveis: Claude e ChatGPT respondem sem ver um ao outro, e o Claude faz a síntese com as divergências. A nota vai para 80 - AUTOMATION/Conselho.</p>
        <label className="field">
          <span>Pergunta</span>
          <textarea rows={2} value={pergunta} onChange={(e) => setPergunta(e.target.value)} placeholder="Ex.: Qual renda priorizar em dezembro?" />
        </label>
        <button className="btn btn-small" disabled={pergunta.trim().length < 10} onClick={ask}>
          Perguntar ao Conselho
        </button>
        {casos.length > 0 && (
          <ul className="ilist">
            {casos.slice(0, 5).map((c) => (
              <li key={c.id}>
                {c.pergunta} — <span className="hint">{c.estado}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="icard">
        <h3>
          <Cpu size={16} aria-hidden /> Benchmark local (LM Studio)
        </h3>
        <p className="hint">
          O OpenClaw só usa o modelo local numa tarefa em que ele fizer pelo menos 80% da nota do Claude. Roda com a GPU só para ele e nunca durante o jogo.{' '}
          {bench?.lmStudio ? `Modelos no LM Studio: ${bench.lmStudio.join(', ') || 'nenhum'}.` : 'LM Studio desligado ou não instalado.'}
        </p>
        {bench?.ultimo && (
          <ul className="ilist">
            {bench.ultimo.decisoes.map((d) => (
              <li key={d.tarefa}>
                <b>{TAREFA[d.tarefa] ?? d.tarefa}:</b> {d.modelo} fez {Math.round(d.local * 100)}% contra {Math.round(d.claude * 100)}% do Claude —{' '}
                <span className={`ibadge tone-${d.aprovado ? 'ok' : 'neutral'}`}>{d.aprovado ? 'local' : 'fica no Claude'}</span>
              </li>
            ))}
          </ul>
        )}
        <button
          className="btn btn-small"
          disabled={!bench?.lmStudio?.length || bench.rodando}
          onClick={() => api('/api/benchmark/rodar', {}).then(() => props.onToast('Benchmark começou: modelos locais agora, notas do Claude em seguida')).catch((e) => props.onError(e.message))}
        >
          {bench?.rodando ? 'Rodando…' : 'Rodar benchmark'}
        </button>
      </div>

      <div className="icard">
        <h3>
          <Brain size={16} aria-hidden /> Memória do Hermes (pesquisa)
        </h3>
        <p className="hint">Critérios, fontes boas e ruins e descartes que o Hermes aprendeu, sempre com a fonte e a validade. Nunca guarda dados pessoais.</p>
        {mem.length ? (
          <ul className="ilist">
            {mem.map((m, i) => (
              <li key={i}>
                <b>{m.tipo.replace('_', ' ')}:</b> {m.texto}{' '}
                <a href={m.url} target="_blank" rel="noreferrer noopener">
                  fonte
                </a>{' '}
                <span className="hint">até {m.validade}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">Vazia por enquanto.</p>
        )}
      </div>

      <div className="icard">
        <h3>
          <Gamepad2 size={16} aria-hidden /> Pausas do modo jogo
        </h3>
        {data.modoJogo.length ? (
          <ul className="ilist">
            {data.modoJogo.slice(0, 10).map((h, i) => (
              <li key={i}>
                {when(h.inicio)} → {h.fim ? when(h.fim) : 'agora'} · <span className="hint">{h.motivo}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">Nenhuma pausa registrada.</p>
        )}
      </div>
    </main>
  );
}
