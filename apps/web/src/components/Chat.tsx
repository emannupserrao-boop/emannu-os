// Aba Chat: uma caixa única para falar com qualquer agente, no PC e no celular.
// Conversar = só resposta (sem ferramentas de escrita); Executar = vira job na fila.
import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Mic, MicOff, Paperclip, Plus, Send, Target, X } from 'lucide-react';
import type { Project } from '../../../../packages/shared/types.ts';
import { api } from '../api.ts';

type Mode = 'conversar' | 'executar';
interface AgentOpt { id: string; nome: string; modos: Mode[]; descricao: string; disponivel: boolean }
interface ChatRow { id: string; agent: string; mode: Mode; title: string; projectId: string | null; createdAt: string }
interface Msg { id: number; role: 'user' | 'assistant' | 'system'; text: string; jobId: string | null; meta: Record<string, unknown> | null }
interface Anexo { nome: string; base64: string; kb: number }

const fileToBase64 = (f: File) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] ?? '');
    r.onerror = () => rej(new Error('Não consegui ler o arquivo'));
    r.readAsDataURL(f);
  });

export function Chat(props: { projects: Project[]; chatEvent: { chatId: string; messageId: number } | null; onOpenJob(id: string): void; onOpenObjective(id: string): void; onError(m: string): void; onToast(m: string): void }) {
  const [agents, setAgents] = useState<AgentOpt[]>([]);
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [agent, setAgent] = useState('claude');
  const [mode, setMode] = useState<Mode>('conversar');
  const [projectId, setProjectId] = useState('sandbox');
  const [text, setText] = useState('');
  const [anexos, setAnexos] = useState<Anexo[]>([]);
  const [live, setLive] = useState<string[]>([]);
  // Conversa que está esperando resposta (o texto ao vivo só aparece nela).
  const [busyChat, setBusyChat] = useState<string | null>(null);
  const busy = busyChat !== null;
  const [listening, setListening] = useState(false);
  const recRef = useRef<any>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const SR = typeof window !== 'undefined' ? ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition) : null;

  const chat = chats.find((c) => c.id === current) ?? null;
  const opt = agents.find((a) => a.id === (chat?.agent ?? agent));

  const loadChats = () => api<ChatRow[]>('/api/chats').then(setChats).catch((e) => props.onError(e.message));
  useEffect(() => {
    api<AgentOpt[]>('/api/chats/agentes').then(setAgents).catch((e) => props.onError(e.message));
    loadChats();
  }, []);
  const currentRef = useRef<string | null>(null);
  currentRef.current = current;
  // Só mostra as mensagens se a conversa ainda é a selecionada (respostas atrasadas não invadem outra).
  const loadMsgs = (id: string) =>
    api<{ messages: Msg[] }>(`/api/chats/${id}`)
      .then((d) => {
        if (currentRef.current === id) setMsgs(d.messages);
      })
      .catch((e) => props.onError(e.message));
  useEffect(() => {
    if (current) loadMsgs(current);
    else setMsgs([]);
  }, [current]);
  // Mensagem chegando depois (ex.: síntese do Conselho).
  useEffect(() => {
    if (props.chatEvent && props.chatEvent.chatId === current && !busy) loadMsgs(current);
  }, [props.chatEvent?.messageId]);
  // Chaves: no Chromium recente scrollIntoView devolve uma Promise, e o React a trataria como "limpeza".
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [msgs.length, live.length]);
  useEffect(() => {
    const a = agents.find((x) => x.id === agent);
    if (a && !a.modos.includes(mode)) setMode(a.modos[0]);
  }, [agent, agents]);

  const newChat = () => {
    setCurrent(null);
    setLive([]);
  };

  const ensureChat = async (): Promise<string> => {
    if (current) return current;
    const c = await api<ChatRow>('/api/chats', { agent, mode, projectId: mode === 'executar' ? projectId : undefined });
    setChats((l) => [c, ...l]);
    currentRef.current = c.id;
    setCurrent(c.id);
    return c.id;
  };

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setLive([]);
    setBusyChat(current ?? 'nova');
    try {
      const id = await ensureChat();
      setBusyChat(id);
      setMsgs((m) => [...m, { id: -Date.now(), role: 'user', text: t, jobId: null, meta: anexos.length ? { anexos: anexos.map((a) => a.nome) } : null }]);
      setText('');
      const body = JSON.stringify({ texto: t, anexos: anexos.map(({ nome, base64 }) => ({ nome, base64 })) });
      setAnexos([]);
      const res = await fetch(`/api/chats/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? `Erro ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let rest = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const parts = (rest + dec.decode(value, { stream: true })).split('\n\n');
        rest = parts.pop() ?? '';
        for (const p of parts) {
          const ev = JSON.parse(p.replace(/^data:\s*/, ''));
          if ((ev.type === 'delta' || ev.type === 'tool') && currentRef.current === id) setLive((l) => [...l, ev.type === 'tool' ? `› ${ev.text}` : ev.text]);
          if (ev.type === 'error') props.onError(ev.error);
        }
      }
      await loadMsgs(id);
      loadChats();
    } catch (e: any) {
      props.onError(e.message);
    } finally {
      setLive([]);
      setBusyChat(null);
    }
  };

  const attach = async (files: FileList | null) => {
    if (!files) return;
    const out: Anexo[] = [];
    for (const f of Array.from(files).slice(0, 5 - anexos.length)) {
      if (f.size > 2 * 1024 * 1024) {
        props.onError(`${f.name} passa de 2 MB`);
        continue;
      }
      out.push({ nome: f.name, base64: await fileToBase64(f), kb: Math.ceil(f.size / 1024) });
    }
    setAnexos((a) => [...a, ...out]);
  };

  // Microfone (reconhecimento de voz do navegador; no celular, o do Android).
  const mic = () => {
    if (!SR) return props.onError('Este navegador não tem reconhecimento de voz.');
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const rec = new SR();
    rec.lang = 'pt-BR';
    rec.interimResults = false;
    rec.onresult = (e: any) => {
      const said = Array.from(e.results as ArrayLike<any>).map((r: any) => r[0]?.transcript ?? '').join(' ').trim();
      if (said) setText((t) => (t ? `${t} ${said}` : said));
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    rec.start();
  };

  const toObjective = () => {
    if (!current) return;
    api<{ id: string }>(`/api/chats/${current}/to-objective`, { projectId: chat?.projectId ?? projectId })
      .then((o) => {
        props.onToast('Objetivo criado: o Planejador vai montar o plano');
        props.onOpenObjective(o.id);
      })
      .catch((e) => props.onError(e.message));
  };

  return (
    <main className="imm chat">
      <header className="imm-head">
        <span className="plogo mono-logo ia-logo" aria-hidden>
          <MessageSquare size={26} strokeWidth={1.5} />
        </span>
        <div>
          <h2>Chat</h2>
          <p className="hint">Fale com qualquer agente daqui. "Conversar" só responde; "Executar" vira um job na fila, com worktree e revisão.</p>
        </div>
      </header>

      <div className="chat-grid">
        <aside className="chat-list" aria-label="Conversas">
          <button className="btn btn-small" onClick={newChat}>
            <Plus size={14} aria-hidden /> Nova conversa
          </button>
          <ul>
            {chats.map((c) => (
              <li key={c.id}>
                <button className={`chat-item ${c.id === current ? 'on' : ''}`} onClick={() => setCurrent(c.id)}>
                  <b>{c.title}</b>
                  <span className="hint">
                    {agents.find((a) => a.id === c.agent)?.nome ?? c.agent} · {c.mode}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="chat-main">
          {!current && (
            <div className="chat-setup">
              <label className="field">
                <span>Agente</span>
                <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agente">
                  {agents.map((a) => (
                    <option key={a.id} value={a.id} disabled={!a.disponivel}>
                      {a.nome}
                      {a.disponivel ? '' : ' (indisponível)'}
                    </option>
                  ))}
                </select>
                {opt && <small>{opt.descricao}</small>}
              </label>
              <div className="seg-mini" role="radiogroup" aria-label="Modo">
                {(['conversar', 'executar'] as Mode[]).map((m) => (
                  <button key={m} role="radio" aria-checked={mode === m} className={`btn btn-small ${mode === m ? 'btn-primary' : ''}`} disabled={!opt?.modos.includes(m)} onClick={() => setMode(m)}>
                    {m === 'conversar' ? 'Conversar' : 'Executar'}
                  </button>
                ))}
              </div>
              {mode === 'executar' && (
                <label className="field">
                  <span>Projeto do job</span>
                  <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                    {props.projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}

          <div className="chat-msgs" aria-live="polite">
            {msgs.map((m) => (
              <div key={m.id} className={`msg msg-${m.role}`}>
                <p>{m.text}</p>
                {Array.isArray(m.meta?.anexos) && <span className="hint">📎 {(m.meta!.anexos as string[]).join(', ')}</span>}
                {m.meta?.via === 'slack' && <span className="ibadge tone-neutral">via Slack</span>}
                {m.jobId && (
                  <button className="btn btn-small btn-ghost" onClick={() => props.onOpenJob(m.jobId!)}>
                    Abrir job
                  </button>
                )}
              </div>
            ))}
            {busy && busyChat === current && (
              <div className="msg msg-assistant live">
                {live.length ? live.map((l, i) => <p key={i}>{l}</p>) : <p className="hint">Pensando…</p>}
              </div>
            )}
            <div ref={endRef} />
          </div>

          {anexos.length > 0 && (
            <div className="chat-anexos">
              {anexos.map((a, i) => (
                <span key={i} className="ibadge tone-neutral">
                  {a.nome} ({a.kb} KB)
                  <button className="btn-ghost btn-icon btn" aria-label={`Remover ${a.nome}`} onClick={() => setAnexos((l) => l.filter((_, j) => j !== i))}>
                    <X size={12} aria-hidden />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="composer">
            <textarea
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={chat ? 'Escreva…' : 'Escreva para começar a conversa…'}
              aria-label="Mensagem"
            />
            <div className="composer-actions">
              <label className="btn btn-small btn-icon" aria-label="Anexar arquivo">
                <Paperclip size={16} aria-hidden />
                <input type="file" multiple hidden onChange={(e) => attach(e.target.files).then(() => (e.target.value = ''))} />
              </label>
              <button className={`btn btn-small btn-icon ${listening ? 'btn-primary' : ''}`} onClick={mic} aria-label={listening ? 'Parar de ouvir' : 'Falar (microfone)'} disabled={!SR}>
                {listening ? <MicOff size={16} aria-hidden /> : <Mic size={16} aria-hidden />}
              </button>
              <button className="btn btn-small btn-primary" onClick={send} disabled={!text.trim() || busy} aria-label="Enviar">
                <Send size={14} aria-hidden /> Enviar
              </button>
            </div>
          </div>
          {current && (
            <button className="btn btn-small btn-ghost" onClick={toObjective}>
              <Target size={14} aria-hidden /> Transformar em objetivo
            </button>
          )}
        </section>
      </div>
    </main>
  );
}
