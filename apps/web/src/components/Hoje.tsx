// Aba Hoje: o bloco humano do dia (45 min), em ordem, com um botão para cada ação.
import { useEffect, useState } from 'react';
import { CheckCircle2, Clock, Copy, ExternalLink, ListChecks } from 'lucide-react';
import type { HojeAcao, HojeView } from '../../../../packages/shared/renda.ts';
import { HOJE_BLOCOS } from '../../../../packages/shared/renda.ts';
import { arquivosApi, rendaApi } from '../api.ts';
import { kindOf } from '../../../../packages/shared/arquivos.ts';
import { Visualizador, type Item } from './Arquivos.tsx';
import { Skeleton } from '../motion.tsx';
import { HumanActionDialog, copyText, type HumanRequest } from './HumanAction.tsx';

export function Hoje(props: { version: number; onOpenJob(id: string): void; onOpenObjective(id: string): void; onError(msg: string): void; onToast(msg: string): void }) {
  const [data, setData] = useState<HojeView | null>(null);
  const [req, setReq] = useState<HumanRequest | null>(null);
  const [reload, setReload] = useState(0);
  const [arquivo, setArquivo] = useState<string | null>(null);
  // Se o arquivo está numa pasta da aba Arquivos, dá para abrir aqui mesmo (também no celular).
  const [aqui, setAqui] = useState<Item | null>(null);
  const [vendo, setVendo] = useState<Item | null>(null);
  useEffect(() => {
    setAqui(null);
    if (!arquivo) return;
    let atual = true; // resposta de um arquivo anterior não vale para o atual
    arquivosApi
      .localizar(arquivo)
      .then((l) => {
        const nome = l.p?.split('/').at(-1);
        if (atual && l.r && l.p && nome) setAqui({ r: l.r, p: l.p, nome, tipo: kindOf(nome), bytes: l.bytes });
      })
      .catch(() => {});
    return () => {
      atual = false;
    };
  }, [arquivo]);

  useEffect(() => {
    rendaApi.hoje().then(setData).catch((e) => props.onError(e.message));
  }, [props.version, reload]);

  if (!data) return <Skeleton cards={3} label="Carregando o dia…" />;

  const run = async (a: HojeAcao, titulo: string) => {
    if (a.tipo === 'copiar') props.onToast((await copyText(a.texto)) ? 'Texto copiado' : 'Não consegui copiar');
    else if (a.tipo === 'abrir') window.open(a.url, '_blank', 'noopener,noreferrer');
    else if (a.tipo === 'arquivo') setArquivo(a.arquivo);
    else if (a.tipo === 'tarefa') setReq({ tipo: 'tarefa', tarefaId: a.tarefaId, estado: a.estado, quem: titulo });
    else if (a.tipo === 'job') props.onOpenJob(a.jobId);
    else if (a.tipo === 'objetivo') props.onOpenObjective(a.objectiveId);
    else if (a.tipo === 'proposta') setReq({ tipo: 'proposta', proposalId: a.proposalId, para: a.para, quem: titulo });
    else if (a.tipo === 'pagamento') setReq({ tipo: 'pagamento', proposalId: a.proposalId, quem: titulo, sugestaoCents: a.sugestaoCents, moeda: a.moeda });
    else if (a.tipo === 'pedido') rendaApi.answerRocky(a.pedidoId, a.resposta).then(() => setReload((n) => n + 1)).catch((e) => props.onError(e.message));
    else if (a.tipo === 'candidatura') setReq({ tipo: 'candidatura', applicationId: a.applicationId, para: a.para, quem: titulo });
  };

  const over = data.totalMin > data.orcamentoMin;
  const blocos = (Object.keys(HOJE_BLOCOS) as (keyof typeof HOJE_BLOCOS)[]).map((b) => ({ id: b, ...HOJE_BLOCOS[b], itens: data.itens.filter((i) => i.bloco === b) }));

  return (
    <main className="imm hoje">
      <header className="imm-head">
        <span className="plogo mono-logo ia-logo" aria-hidden>
          <ListChecks size={26} strokeWidth={1.5} />
        </span>
        <div>
          <h2>Hoje</h2>
          <p className="hint">
            Suas ações do dia, na ordem. Os agentes já prepararam textos e pacotes: você revisa, envia e decide. {new Date(`${data.data}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' })}.
          </p>
        </div>
      </header>

      {data.prioridades.length > 0 && (
        <section className="prioridades" aria-label="Prioridades do dia">
          <h4>Prioridades do Planejador</h4>
          <ol>
            {data.prioridades.map((p, i) => (
              <li key={i}>
                <span className={`ibadge tone-${p.tipo === 'venda' ? 'ok' : p.tipo === 'entrega' ? 'warn' : 'neutral'}`}>{p.tipo}</span> {p.titulo}
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className={`hoje-total ${over ? 'over' : ''}`}>
        <Clock size={16} aria-hidden />
        <b>
          {data.totalMin} de {data.orcamentoMin} min
        </b>
        <span className="hint">{over ? 'Passou do bloco de 45 min: comece pelo topo; o resto fica para amanhã.' : 'Dentro do bloco de 45 min.'}</span>
      </div>

      {!data.itens.length && (
        <div className="icard hoje-vazio">
          <CheckCircle2 size={20} aria-hidden />
          <p>Nada esperando você agora. Propostas novas aparecem aqui depois das 07h15 (dias úteis).</p>
        </div>
      )}

      {blocos
        .filter((b) => b.itens.length)
        .map((b) => (
          <section key={b.id} className="hoje-bloco" aria-label={b.titulo}>
            <h4>
              {b.titulo} <span className="hint">· até {b.minutos} min</span>
            </h4>
            <ol className="hoje-lista">
              {b.itens.map((it) => (
                <li key={it.id} className="hoje-item">
                  <div className="hoje-txt">
                    <b>{it.titulo}</b>
                    {it.deOntem && <span className="ibadge tone-warn">de ontem</span>}
                    <p className="hint clamp-2">{it.detalhe}</p>
                  </div>
                  <span className="hoje-min" aria-label={`${it.minutos} minutos`}>
                    {it.minutos} min
                  </span>
                  <div className="hoje-acoes">
                    {it.acoes.map((a, i) => (
                      <button
                        key={i}
                        className={`btn btn-small ${a.tipo === 'tarefa' ? (a.estado === 'feita' ? 'btn-primary' : 'btn-ghost') : a.tipo === 'proposta' || a.tipo === 'pagamento' || a.tipo === 'candidatura' ? (a.rotulo.startsWith('Perdido') || a.rotulo === 'Descartar' ? 'btn-ghost' : 'btn-primary') : ''}`}
                        onClick={() => run(a, it.titulo)}
                      >
                        {a.tipo === 'copiar' && <Copy size={13} aria-hidden />}
                        {a.tipo === 'abrir' && <ExternalLink size={13} aria-hidden />}
                        {a.tipo === 'arquivo' && <Copy size={13} aria-hidden />}
                        {a.tipo === 'tarefa' && a.estado === 'feita' && <CheckCircle2 size={13} aria-hidden />}
                        {a.rotulo}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ))}

      {arquivo && (
        <div className="drawer-backdrop center" onClick={() => setArquivo(null)}>
          <div className="confirm human-dialog" role="dialog" aria-modal="true" aria-label="Abrir arquivo" onClick={(e) => e.stopPropagation()}>
            <h3>Abrir arquivo</h3>
            <p className="hint">Copie o caminho e abra no PC.</p>
            <label className="field">
              <span>Caminho local</span>
              <input autoFocus readOnly value={arquivo} onFocus={(e) => e.currentTarget.select()} />
            </label>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setArquivo(null)}>Voltar</button>
              {aqui && (
                <button
                  className="btn"
                  onClick={() => {
                    setVendo(aqui);
                    setArquivo(null);
                  }}
                >
                  <ExternalLink size={13} aria-hidden /> Abrir aqui
                </button>
              )}
              <button className="btn btn-primary" onClick={async () => props.onToast((await copyText(arquivo)) ? 'Caminho copiado' : 'Não consegui copiar')}>
                <Copy size={13} aria-hidden /> Copiar caminho
              </button>
            </div>
          </div>
        </div>
      )}

      {vendo && <Visualizador itens={[vendo]} i={0} onClose={() => setVendo(null)} />}

      {req && (
        <HumanActionDialog
          req={req}
          onCancel={() => setReq(null)}
          onError={props.onError}
          onDone={() => {
            setReq(null);
            setReload((n) => n + 1);
            props.onToast('Registrado');
          }}
        />
      )}
    </main>
  );
}
