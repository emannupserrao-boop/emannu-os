// Barra do player no rodapé: aparece quando há música na fila, em qualquer aba.
import { useEffect } from 'react';
import { Download, Pause, Play, SkipBack, SkipForward, X } from 'lucide-react';
import { fileUrl } from '../api.ts';
import { player, trackTitle, usePlayer, usePlayerTime } from '../player.ts';

const clock = (s: number) => {
  if (!Number.isFinite(s) || s <= 0) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

export function PlayerBar() {
  const s = usePlayer();
  const { t, dur } = usePlayerTime();
  const on = s.fila.length > 0;
  useEffect(() => {
    document.body.classList.toggle('has-player', on);
  }, [on]);
  if (!on) return null;
  const tr = s.fila[s.i];
  return (
    <div className="player" role="region" aria-label="Player de música">
      <div className="player-info">
        <b title={tr.nome}>{trackTitle(tr)}</b>
        <span className="hint">
          {s.erro ?? (
            <>
              {tr.album} · {s.i + 1}/{s.fila.length}
            </>
          )}
        </span>
      </div>
      <div className="player-ctrl">
        <button className="btn btn-icon btn-ghost" onClick={player.anterior} aria-label="Música anterior">
          <SkipBack size={16} />
        </button>
        <button className="btn btn-icon btn-primary player-play" onClick={player.alternar} aria-label={s.tocando ? 'Pausar' : 'Tocar'}>
          {s.tocando ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button className="btn btn-icon btn-ghost" onClick={player.proxima} disabled={s.i >= s.fila.length - 1} aria-label="Próxima música">
          <SkipForward size={16} />
        </button>
      </div>
      <div className="player-seek">
        <span>{clock(t)}</span>
        <input type="range" min={0} max={dur || 0} step={0.5} value={Math.min(t, dur || 0)} onChange={(e) => player.ir(Number(e.target.value))} aria-label="Posição da música" />
        <span>{clock(dur)}</span>
      </div>
      <div className="player-extra">
        <a className="btn btn-icon btn-ghost" href={fileUrl(tr.r, tr.p, true)} aria-label="Baixar música" title="Baixar">
          <Download size={16} />
        </a>
        <button className="btn btn-icon btn-ghost" onClick={player.parar} aria-label="Fechar o player" title="Fechar">
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
