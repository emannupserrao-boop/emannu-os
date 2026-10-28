// Player de música do app: um único <audio> que continua tocando ao trocar de aba,
// com os controles da tela de bloqueio do celular (Media Session).
import { useSyncExternalStore } from 'react';
import { fileUrl } from './api.ts';

export interface Track {
  r: string;
  p: string;
  nome: string;
  album: string;
}

interface PlayerState {
  fila: Track[];
  i: number;
  tocando: boolean;
  erro: string | null;
}

let state: PlayerState = { fila: [], i: 0, tocando: false, erro: null };
let time = { t: 0, dur: 0 };
const subs = new Set<() => void>();
const timeSubs = new Set<() => void>();
const set = (patch: Partial<PlayerState>) => {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
};

export const trackTitle = (t: Track) => t.nome.replace(/\.[^.]+$/, '');

let audio: HTMLAudioElement | null = null;
function el(): HTMLAudioElement {
  if (audio) return audio;
  const a = (audio = new Audio());
  a.preload = 'auto';
  a.addEventListener('play', () => set({ tocando: true, erro: null }));
  a.addEventListener('pause', () => set({ tocando: false }));
  a.addEventListener('ended', () => (state.i < state.fila.length - 1 ? go(state.i + 1) : set({ tocando: false })));
  a.addEventListener('error', () => {
    if (a.getAttribute('src')) set({ tocando: false, erro: 'Este arquivo não toca neste aparelho. Use Baixar.' });
  });
  const tick = () => {
    time = { t: a.currentTime || 0, dur: Number.isFinite(a.duration) ? a.duration : 0 };
    timeSubs.forEach((f) => f());
  };
  for (const ev of ['timeupdate', 'durationchange', 'loadedmetadata', 'seeked', 'emptied']) a.addEventListener(ev, tick);
  const ms = 'mediaSession' in navigator ? navigator.mediaSession : null;
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ['play', () => void a.play().catch(() => {})],
    ['pause', () => a.pause()],
    ['previoustrack', () => player.anterior()],
    ['nexttrack', () => player.proxima()],
    ['seekto', (d) => d.seekTime !== undefined && (a.currentTime = d.seekTime)],
  ];
  for (const [action, fn] of handlers) {
    try {
      ms?.setActionHandler(action, fn);
    } catch {}
  }
  return a;
}

function go(i: number) {
  const t = state.fila[i];
  if (!t) return;
  const a = el();
  a.src = fileUrl(t.r, t.p);
  set({ i, erro: null });
  a.play().catch(() => {});
  if ('mediaSession' in navigator && 'MediaMetadata' in window) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: trackTitle(t), artist: /^musicas|^what-lies/.test(t.r) ? 'WHAT LIES BTWN' : 'EMANNU OS', album: t.album });
  }
}

export const player = {
  tocar(fila: Track[], i = 0) {
    set({ fila });
    go(i);
  },
  alternar() {
    const a = el();
    if (!state.fila.length) return;
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  },
  proxima() {
    if (state.i < state.fila.length - 1) go(state.i + 1);
  },
  anterior() {
    const a = el();
    if (a.currentTime > 3 || state.i === 0) a.currentTime = 0;
    else go(state.i - 1);
  },
  ir(seg: number) {
    el().currentTime = seg;
  },
  parar() {
    const a = el();
    a.pause();
    a.removeAttribute('src');
    a.load();
    set({ fila: [], i: 0, tocando: false, erro: null });
  },
};

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};
const subscribeTime = (f: () => void) => {
  timeSubs.add(f);
  return () => timeSubs.delete(f);
};

export const usePlayer = () => useSyncExternalStore(subscribe, () => state);
export const usePlayerTime = () => useSyncExternalStore(subscribeTime, () => time);
