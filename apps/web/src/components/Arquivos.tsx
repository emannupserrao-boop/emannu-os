// Aba Arquivos: ouvir as músicas, ver fotos e vídeos e ler ou baixar documentos, direto das
// pastas do PC (só leitura). O player continua tocando ao trocar de aba.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, Download, ExternalLink, File, FileText, Film, Folder, Image as ImageIcon, Music, Play, RefreshCw, Search, X } from 'lucide-react';
import { arquivosApi, fileUrl, formatTime, miniUrl } from '../api.ts';
import { TEXT_EXT, extOf, kindOf, type DirEntry, type FileGroup, type FileKind, type IndexStatus, type LibFile, type RootView } from '../../../../packages/shared/arquivos.ts';
import { player, usePlayer } from '../player.ts';
import { Skeleton, useTabIndicator } from '../motion.tsx';
import { Md } from './Md.tsx';

type Secao = 'musicas' | 'fotos' | 'videos' | 'documentos' | 'pastas';
const SECOES: { key: Secao; label: string; tipo: FileKind | null; Icon: typeof Music }[] = [
  { key: 'musicas', label: 'Músicas', tipo: 'audio', Icon: Music },
  { key: 'fotos', label: 'Fotos', tipo: 'image', Icon: ImageIcon },
  { key: 'videos', label: 'Vídeos', tipo: 'video', Icon: Film },
  { key: 'documentos', label: 'Documentos', tipo: 'doc', Icon: FileText },
  { key: 'pastas', label: 'Pastas', tipo: null, Icon: Folder },
];
const PAGE = 120;

// Um arquivo que dá para abrir (vem do índice ou de uma pasta).
export interface Item {
  r: string;
  p: string;
  nome: string;
  tipo: FileKind;
  ext?: string; // o formato vem daqui (no cockpit antigo o nome é um título sem extensão)
  bytes?: number;
}

export const sizeOf = (b?: number) =>
  b === undefined ? '' : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} KB` : `${b} B`;
const albumOf = (it: { p: string }, fallback: string) => {
  const parts = it.p.split('/');
  return parts.length > 1 ? parts[parts.length - 2] : fallback;
};
const load = <T,>(k: string, d: T): T => {
  try {
    return (JSON.parse(localStorage.getItem(k) ?? 'null') as T) ?? d;
  } catch {
    return d;
  }
};
const save = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};

function KindIcon({ tipo, size = 18 }: { tipo: FileKind | 'pasta'; size?: number }) {
  const I = tipo === 'pasta' ? Folder : tipo === 'audio' ? Music : tipo === 'image' ? ImageIcon : tipo === 'video' ? Film : tipo === 'doc' ? FileText : File;
  return <I size={size} strokeWidth={1.75} aria-hidden />;
}

// Miniatura (foto ou quadro do vídeo); se não der para gerar, mostra o ícone.
function Thumb({ it, w = 360 }: { it: Item; w?: number }) {
  const [bad, setBad] = useState(false);
  if (bad || (it.tipo !== 'image' && it.tipo !== 'video')) return <span className="thumb-icon"><KindIcon tipo={it.tipo} size={22} /></span>;
  return <img src={miniUrl(it.r, it.p, w)} alt="" loading="lazy" decoding="async" onError={() => setBad(true)} />;
}

export function Arquivos(props: { onError(m: string): void; onToast(m: string): void }) {
  const [secao, setSecao] = useState<Secao>(() => load('emannu.arquivos.secao', 'musicas'));
  const [info, setInfo] = useState<{ raizes: RootView[]; indice: IndexStatus } | null>(null);
  const [filtros, setFiltros] = useState<Record<string, string>>(() => load('emannu.arquivos.filtros', {}));
  const [busca, setBusca] = useState('');
  const [q, setQ] = useState('');
  const [grupo, setGrupo] = useState<FileGroup | null>(null);
  const [ver, setVer] = useState<{ itens: Item[]; i: number } | null>(null);
  const [reload, setReload] = useState(0);
  const tabsRef = useTabIndicator<HTMLElement>(secao);
  const def = SECOES.find((s) => s.key === secao)!;

  useEffect(() => {
    let stop = false;
    let t: ReturnType<typeof setTimeout>;
    const get = () =>
      arquivosApi
        .info()
        .then((d) => {
          if (stop) return;
          setInfo(d);
          if (!d.indice.pronto || d.indice.atualizando) t = setTimeout(get, 2500);
        })
        .catch((e) => props.onError(e.message));
    get();
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [reload]);

  useEffect(() => {
    const t = setTimeout(() => setQ(busca.trim()), 250);
    return () => clearTimeout(t);
  }, [busca]);

  const go = (s: Secao) => {
    setSecao(s);
    save('emannu.arquivos.secao', s);
    setGrupo(null);
    setBusca('');
  };
  // Músicas começa pela pasta de músicas; o resto, por todas as pastas.
  const musicRoot = info?.raizes.find((r) => r.grupo === 'musica')?.id ?? '';
  const raiz = filtros[secao] ?? (secao === 'musicas' ? musicRoot : '');
  const setRaiz = (r: string) => {
    const next = { ...filtros, [secao]: r };
    setFiltros(next);
    save('emannu.arquivos.filtros', next);
    setGrupo(null);
  };
  const rootName = (id: string) => info?.raizes.find((r) => r.id === id)?.nome ?? id;
  const st = info?.indice;

  const open = (itens: Item[], i: number) => {
    const it = itens[i];
    if (it.tipo === 'audio') {
      const audios = itens.filter((x) => x.tipo === 'audio');
      player.tocar(audios.map((x) => ({ r: x.r, p: x.p, nome: x.nome, album: albumOf(x, rootName(x.r)) })), audios.indexOf(it));
      return;
    }
    const same = itens.filter((x) => x.tipo === it.tipo);
    setVer({ itens: same, i: same.indexOf(it) });
  };

  return (
    <main className="arquivos">
      <div className="arq-top">
        <nav className="tabs seg" role="tablist" ref={tabsRef} aria-label="Tipo de arquivo">
          {SECOES.map((s) => (
            <button key={s.key} role="tab" aria-selected={secao === s.key} className={secao === s.key ? 'on' : ''} onClick={() => go(s.key)}>
              <s.Icon size={14} aria-hidden /> {s.label}
              {s.tipo && st?.porTipo[s.tipo] ? <span className="count">{st.porTipo[s.tipo]}</span> : null}
            </button>
          ))}
        </nav>
        {def.tipo && (
          <div className="arq-filters">
            <label className="arq-search">
              <Search size={14} aria-hidden />
              <input type="search" placeholder={`Buscar em ${def.label.toLowerCase()}`} value={busca} onChange={(e) => setBusca(e.target.value)} aria-label="Buscar" />
            </label>
            <select value={raiz} onChange={(e) => setRaiz(e.target.value)} aria-label="Pasta">
              <option value="">Todas as pastas</option>
              {info?.raizes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.nome}
                </option>
              ))}
            </select>
          </div>
        )}
        <p className="hint arq-status">
          {!st ? 'Lendo suas pastas…' : !st.pronto ? 'Lendo suas pastas pela primeira vez (leva uns segundos)…' : (
            <>
              {st.arquivos.toLocaleString('pt-BR')} arquivos · atualizado {formatTime(st.atualizadoEm)}
              {st.incompleto ? ' · lista parcial (pastas grandes demais)' : ''} · só leitura, os originais não mudam
            </>
          )}
          {st?.pronto && (
            <button
              className="btn btn-ghost btn-small"
              disabled={st.atualizando}
              onClick={() =>
                arquivosApi
                  .reindexar()
                  .then(() => {
                    setReload((n) => n + 1);
                    props.onToast('Lista de arquivos atualizada');
                  })
                  .catch((e) => props.onError(e.message))
              }
            >
              <RefreshCw size={13} aria-hidden /> {st.atualizando ? 'Atualizando…' : 'Atualizar'}
            </button>
          )}
        </p>
      </div>

      {!info || (def.tipo && !st?.pronto) ? (
        <Skeleton cards={4} label="Lendo suas pastas" />
      ) : def.tipo ? (
        q ? (
          <Busca key={`${secao}|${raiz}|${q}|${reload}`} tipo={def.tipo} r={raiz} q={q} rootName={rootName} onOpen={open} onError={props.onError} />
        ) : grupo ? (
          <Grupo key={`${grupo.r}|${grupo.dir}|${reload}`} tipo={def.tipo} g={grupo} onBack={() => setGrupo(null)} onOpen={open} onError={props.onError} />
        ) : (
          <Grupos key={`${secao}|${raiz}|${reload}`} tipo={def.tipo} r={raiz} onPick={setGrupo} onError={props.onError} />
        )
      ) : (
        <Pastas raizes={info.raizes} onOpen={open} onError={props.onError} />
      )}

      {ver && <Visualizador itens={ver.itens} i={ver.i} onClose={() => setVer(null)} rootName={rootName} />}
    </main>
  );
}

// Lista de pastas que têm o tipo escolhido (discos, álbuns de fotos, pastas de documentos).
function Grupos(props: { tipo: FileKind; r: string; onPick(g: FileGroup): void; onError(m: string): void }) {
  const [list, setList] = useState<FileGroup[] | null>(null);
  const [n, setN] = useState(PAGE);
  useEffect(() => {
    arquivosApi.grupos(props.tipo, props.r || undefined).then(setList).catch((e) => props.onError(e.message));
  }, []);
  if (!list) return <Skeleton cards={4} />;
  if (!list.length) return <p className="empty">Nenhum arquivo deste tipo nesta pasta.</p>;
  const visual = props.tipo === 'image' || props.tipo === 'video';
  return (
    <>
      <div className={visual ? 'arq-albums' : 'arq-rows'}>
        {list.slice(0, n).map((g) => (
          <button key={`${g.r}|${g.dir}`} className={visual ? 'arq-album' : 'arq-row'} onClick={() => props.onPick(g)} title={g.caminho}>
            {visual && <span className="arq-cover">{g.capa && <Thumb it={{ r: g.r, p: g.capa, nome: '', tipo: props.tipo }} />}</span>}
            {!visual && (
              <span className="arq-row-icon">
                <KindIcon tipo={props.tipo === 'audio' ? 'audio' : 'pasta'} />
              </span>
            )}
            <span className="arq-row-text">
              <b>{g.nome}</b>
              <span className="hint">
                {g.total} {g.total === 1 ? 'arquivo' : 'arquivos'} · {g.caminho}
              </span>
            </span>
          </button>
        ))}
      </div>
      {list.length > n && (
        <button className="btn arq-more" onClick={() => setN(n + PAGE)}>
          Mostrar mais ({list.length - n})
        </button>
      )}
    </>
  );
}

// Arquivos de uma pasta: faixas (com "Tocar tudo"), grade de fotos ou vídeos, ou lista de documentos.
function Grupo(props: { tipo: FileKind; g: FileGroup; onBack(): void; onOpen(itens: Item[], i: number): void; onError(m: string): void }) {
  const [itens, setItens] = useState<LibFile[] | null>(null);
  useEffect(() => {
    arquivosApi
      .itens({ tipo: props.tipo, r: props.g.r, dir: props.g.dir, limite: 5000 })
      .then((d) => setItens(d.itens))
      .catch((e) => props.onError(e.message));
  }, []);
  return (
    <section className="arq-group">
      <header className="arq-group-head">
        <button className="btn btn-ghost" onClick={props.onBack}>
          <ArrowLeft size={15} aria-hidden /> Voltar
        </button>
        <div className="arq-group-title">
          <h2>{props.g.nome}</h2>
          <p className="hint">{props.g.caminho}</p>
        </div>
        {props.tipo === 'audio' && itens && itens.length > 0 && (
          <button className="btn btn-primary" onClick={() => props.onOpen(itens, 0)}>
            <Play size={14} aria-hidden /> Tocar tudo
          </button>
        )}
      </header>
      {!itens ? <Skeleton cards={3} /> : <Lista tipo={props.tipo} itens={itens} onOpen={props.onOpen} />}
    </section>
  );
}

function Busca(props: { tipo: FileKind; r: string; q: string; rootName(id: string): string; onOpen(itens: Item[], i: number): void; onError(m: string): void }) {
  const [res, setRes] = useState<{ itens: LibFile[]; total: number } | null>(null);
  useEffect(() => {
    arquivosApi
      .itens({ tipo: props.tipo, r: props.r || undefined, q: props.q, limite: 600 })
      .then(setRes)
      .catch((e) => props.onError(e.message));
  }, []);
  if (!res) return <Skeleton cards={3} />;
  if (!res.itens.length) return <p className="empty">Nada encontrado para “{props.q}”.</p>;
  return (
    <>
      <p className="hint">
        {res.total > res.itens.length ? `${res.itens.length} de ${res.total}` : res.total} resultado(s), mais recentes primeiro.
      </p>
      <Lista tipo={props.tipo} itens={res.itens} onOpen={props.onOpen} showPath rootName={props.rootName} />
    </>
  );
}

function Lista(props: { tipo: FileKind; itens: LibFile[]; onOpen(itens: Item[], i: number): void; showPath?: boolean; rootName?(id: string): string }) {
  const [n, setN] = useState(PAGE);
  const ps = usePlayer();
  const playing = ps.fila[ps.i];
  if (!props.itens.length) return <p className="empty">Pasta vazia.</p>;
  const visual = props.tipo === 'image' || props.tipo === 'video';
  const where = (f: LibFile) => (props.showPath ? `${props.rootName?.(f.r) ?? f.r} / ${f.p.split('/').slice(0, -1).join(' / ')}` : '');
  return (
    <>
      {visual ? (
        <div className="arq-grid">
          {props.itens.slice(0, n).map((f, i) => (
            <button key={f.r + f.p} className="arq-tile" onClick={() => props.onOpen(props.itens, i)} title={f.nome} aria-label={f.nome}>
              <Thumb it={f} />
              {f.tipo === 'video' && (
                <span className="arq-tile-badge">
                  <Play size={12} aria-hidden />
                </span>
              )}
            </button>
          ))}
        </div>
      ) : (
        <ol className="arq-rows arq-files">
          {props.itens.slice(0, n).map((f, i) => {
            const now = playing && playing.r === f.r && playing.p === f.p;
            return (
              <li key={f.r + f.p} className={`arq-row ${now ? 'on' : ''}`}>
                <button className="arq-row-main" onClick={() => props.onOpen(props.itens, i)}>
                  <span className="arq-row-icon">{now && ps.tocando ? <Music size={18} className="pulse" aria-hidden /> : <KindIcon tipo={f.tipo} />}</span>
                  <span className="arq-row-text">
                    <b>{f.nome}</b>
                    <span className="hint">
                      {sizeOf(f.bytes)} · {formatTime(f.mtime)}
                      {where(f) ? ` · ${where(f)}` : ''}
                    </span>
                  </span>
                </button>
                <a className="btn btn-icon btn-ghost" href={fileUrl(f.r, f.p, true)} aria-label={`Baixar ${f.nome}`} title="Baixar">
                  <Download size={15} />
                </a>
              </li>
            );
          })}
        </ol>
      )}
      {props.itens.length > n && (
        <button className="btn arq-more" onClick={() => setN(n + PAGE)}>
          Mostrar mais ({props.itens.length - n})
        </button>
      )}
    </>
  );
}

// Navegar pelas pastas como no Explorador (só leitura).
function Pastas(props: { raizes: RootView[]; onOpen(itens: Item[], i: number): void; onError(m: string): void }) {
  const [loc, setLoc] = useState<{ r: string; p: string } | null>(() => load('emannu.arquivos.pasta', null));
  const [data, setData] = useState<{ raiz: RootView; p: string; itens: DirEntry[] } | null>(null);
  useEffect(() => {
    save('emannu.arquivos.pasta', loc);
    setData(null);
    if (!loc) return;
    let atual = true; // a resposta de uma pasta anterior não substitui a atual
    arquivosApi
      .pasta(loc.r, loc.p)
      .then((d) => atual && setData(d))
      .catch((e) => {
        if (!atual) return;
        props.onError(e.message);
        setLoc(null);
      });
    return () => {
      atual = false;
    };
  }, [loc?.r, loc?.p]);
  const files = useMemo<Item[]>(() => (data ? data.itens.filter((x) => x.tipo !== 'pasta').map((x) => ({ r: data.raiz.id, p: x.p, nome: x.nome, tipo: x.tipo as FileKind, ext: x.ext, bytes: x.bytes })) : []), [data]);

  if (!loc)
    return (
      <div className="arq-rows">
        {props.raizes.map((r) => (
          <button key={r.id} className="arq-row" onClick={() => setLoc({ r: r.id, p: '' })}>
            <span className="arq-row-icon">
              <Folder size={18} aria-hidden />
            </span>
            <span className="arq-row-text">
              <b>{r.nome}</b>
              <span className="hint">{r.grupo === 'musica' ? 'Músicas' : r.grupo === 'projeto' ? 'Projeto' : r.grupo === 'vault' ? 'Notas do Obsidian' : r.grupo === 'legado' ? 'O que o cockpit antigo listava' : 'Documentos'}</span>
            </span>
          </button>
        ))}
      </div>
    );
  const parts = loc.p ? loc.p.split('/') : [];
  return (
    <section className="arq-group">
      <nav className="arq-crumbs" aria-label="Caminho">
        <button className="btn btn-ghost btn-small" onClick={() => setLoc(null)}>
          Pastas
        </button>
        <span>/</span>
        <button className="btn btn-ghost btn-small" onClick={() => setLoc({ r: loc.r, p: '' })}>
          {data?.raiz.nome ?? props.raizes.find((r) => r.id === loc.r)?.nome ?? loc.r}
        </button>
        {parts.map((part, i) => (
          <span key={i} className="arq-crumb">
            <span>/</span>
            <button className="btn btn-ghost btn-small" onClick={() => setLoc({ r: loc.r, p: parts.slice(0, i + 1).join('/') })}>
              {part}
            </button>
          </span>
        ))}
      </nav>
      {!data ? (
        <Skeleton cards={3} />
      ) : !data.itens.length ? (
        <p className="empty">Pasta vazia.</p>
      ) : (
        <ol className="arq-rows arq-files">
          {data.itens.map((x) =>
            x.tipo === 'pasta' ? (
              <li key={x.p} className="arq-row">
                <button className="arq-row-main" onClick={() => setLoc({ r: loc.r, p: x.p })}>
                  <span className="arq-row-icon">
                    <Folder size={18} aria-hidden />
                  </span>
                  <span className="arq-row-text">
                    <b>{x.nome}</b>
                  </span>
                </button>
              </li>
            ) : (
              <li key={x.p} className="arq-row">
                <button className="arq-row-main" onClick={() => props.onOpen(files, files.findIndex((f) => f.p === x.p))}>
                  <span className="arq-row-icon">
                    <KindIcon tipo={x.tipo} />
                  </span>
                  <span className="arq-row-text">
                    <b>{x.nome}</b>
                    <span className="hint">
                      {sizeOf(x.bytes)} · {formatTime(x.mtime ?? null)}
                    </span>
                  </span>
                </button>
                <a className="btn btn-icon btn-ghost" href={fileUrl(loc.r, x.p, true)} aria-label={`Baixar ${x.nome}`} title="Baixar">
                  <Download size={15} />
                </a>
              </li>
            ),
          )}
        </ol>
      )}
    </section>
  );
}

// Abre uma foto, um vídeo ou um documento por cima da tela, com anterior/próximo, Baixar e Abrir.
export function Visualizador(props: { itens: Item[]; i: number; onClose(): void; rootName?(id: string): string }) {
  const [i, setI] = useState(props.i);
  const it = props.itens[i];
  const many = props.itens.length > 1;
  const prev = () => setI((x) => (x - 1 + props.itens.length) % props.itens.length);
  const next = () => setI((x) => (x + 1) % props.itens.length);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
      else if (many && e.key === 'ArrowLeft') prev();
      else if (many && e.key === 'ArrowRight') next();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [many]);
  // Arrastar para o lado troca de foto no celular.
  const touch = useRef<number | null>(null);
  const folder = it.p.split('/').slice(0, -1).join(' / ');
  // Fora da área da aba (que tem a própria camada): fica por cima da barra do topo.
  return createPortal(
    <div className="drawer-backdrop center viewer-backdrop" onClick={props.onClose}>
      <div className="viewer" role="dialog" aria-modal="true" aria-label={it.nome} onClick={(e) => e.stopPropagation()}>
        <header className="viewer-head">
          <div className="viewer-title">
            <b>{it.nome}</b>
            <span className="hint">
              {props.rootName?.(it.r) ?? it.r}
              {folder ? ` / ${folder}` : ''}
              {it.bytes !== undefined ? ` · ${sizeOf(it.bytes)}` : ''}
              {many ? ` · ${i + 1}/${props.itens.length}` : ''}
            </span>
          </div>
          <a className="btn btn-icon btn-ghost" href={fileUrl(it.r, it.p)} target="_blank" rel="noreferrer" aria-label="Abrir em outra aba" title="Abrir em outra aba">
            <ExternalLink size={16} />
          </a>
          <a className="btn btn-icon btn-ghost" href={fileUrl(it.r, it.p, true)} aria-label="Baixar" title="Baixar">
            <Download size={16} />
          </a>
          <button className="btn btn-icon btn-ghost" onClick={props.onClose} aria-label="Fechar">
            <X size={18} />
          </button>
        </header>
        <div
          className={`viewer-body viewer-${it.tipo}`}
          onTouchStart={(e) => (touch.current = e.touches[0].clientX)}
          onTouchEnd={(e) => {
            if (touch.current === null || !many || it.tipo !== 'image') return;
            const dx = e.changedTouches[0].clientX - touch.current;
            touch.current = null;
            if (Math.abs(dx) > 50) (dx > 0 ? prev : next)();
          }}
        >
          <Conteudo key={it.r + it.p} it={it} />
          {many && (
            <>
              <button className="viewer-nav prev" onClick={prev} aria-label="Anterior">
                <ChevronLeft size={22} />
              </button>
              <button className="viewer-nav next" onClick={next} aria-label="Próximo">
                <ChevronRight size={22} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

const TEXT_MAX = 2_000_000;

function Conteudo({ it }: { it: Item }) {
  const ext = it.ext ?? extOf(it.nome);
  const url = fileUrl(it.r, it.p);
  const [text, setText] = useState<string | null>(null);
  const [fail, setFail] = useState(false);
  // Sem tamanho conhecido, não carrega o texto inteiro: oferece Baixar.
  const isText = TEXT_EXT.has(ext) && it.bytes !== undefined && it.bytes <= TEXT_MAX;
  useEffect(() => {
    if (!isText) return;
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then(setText)
      .catch(() => setFail(true));
  }, []);
  const baixar = (msg: string) => (
    <div className="viewer-msg">
      <KindIcon tipo={it.tipo} size={34} />
      <p>{msg}</p>
      <a className="btn btn-primary" href={fileUrl(it.r, it.p, true)}>
        <Download size={15} aria-hidden /> Baixar
      </a>
    </div>
  );
  if (fail) return baixar('Não consegui abrir este arquivo aqui.');
  if (it.tipo === 'image') return <ImagemGrande it={it} />;
  if (it.tipo === 'video')
    return (
      <video key={url} src={url} controls autoPlay playsInline preload="metadata" onError={() => setFail(true)}>
        Este vídeo não toca neste aparelho.
      </video>
    );
  if (it.tipo === 'audio') return <audio src={url} controls autoPlay />;
  if (isText) {
    if (text === null) return <Skeleton cards={1} label="Abrindo" />;
    return ext === 'md' ? <Md text={text} className="viewer-md" /> : <pre className="viewer-pre">{text}</pre>;
  }
  if (ext === 'pdf') {
    // O Chrome do celular não mostra PDF dentro da página: abre no leitor do aparelho.
    if (!(navigator as any).pdfViewerEnabled) return baixar('O celular abre PDFs no leitor dele: toque em Baixar (ou no ícone de abrir em outra aba).');
    return <iframe className="viewer-frame" src={url} title={it.nome} />;
  }
  if (ext === 'html' || ext === 'htm') return <iframe className="viewer-frame viewer-html" src={url} title={it.nome} sandbox="" />;
  if (it.tipo === 'doc' || kindOf(`x.${ext}`) === 'doc') return baixar('Este tipo de documento abre no Word, Excel ou PowerPoint: baixe para ler.');
  return baixar('O app não mostra este tipo de arquivo; baixe para abrir.');
}

// Foto em tamanho de tela (prévia de 1280 px); se a prévia falhar, tenta o original.
function ImagemGrande({ it }: { it: Item }) {
  const [src, setSrc] = useState(miniUrl(it.r, it.p, 1280));
  return <img src={src} alt={it.nome} onError={() => src !== fileUrl(it.r, it.p) && setSrc(fileUrl(it.r, it.p))} />;
}
