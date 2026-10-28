// Modo jogo (v3.1, seção 12): quando o Emannuel está jogando no PC, a fila de GPU
// (modelo local, benchmark, ComfyUI/LTX, renders, instalação do LM Studio e downloads de
// modelos, testes pesados) não começa nada novo. Jobs leves na nuvem continuam.
// Detecção a cada 60 s; 10 min sem jogo → retoma sozinho.
import { execFile } from 'node:child_process';
import type { Store } from './db.ts';
import { GAME_PROCESSES } from './config.ts';

export interface GameSignals {
  // Executáveis abertos (nome e caminho).
  processes: { name: string; path: string | null }[];
  // App em primeiro plano em tela cheia (nome do executável), ou null.
  fullscreen: string | null;
  // Uso de GPU (%) e processos de fora usando a placa.
  gpuUtil: number | null;
}

export interface GameModeState {
  ativo: boolean;
  desde: string | null;
  motivo: string | null;
  pausarTudo: boolean;
  historico: { inicio: string; fim: string | null; motivo: string }[];
}

const IDLE_MS = 10 * 60_000;
// Navegadores, o próprio EMANNU OS e a tela de bloqueio/login do Windows em tela cheia não contam como jogo
// (LockApp.exe deixou o modo jogo ligado das 05h17 às 07h30 de 28/10 com o PC bloqueado).
const NOT_GAMES = /^(lockapp|logonui|chrome|msedge|firefox|brave|opera|vivaldi|arc|claude|explorer|applicationframehost|code|windowsterminal|obs64|vlc|mpc-hc64)\.exe$/i;

// Sinais vindos do Windows (PowerShell + nvidia-smi). Falhas viram "sem sinal".
export function probeWindows(): Promise<GameSignals> {
  const ps = `
$ErrorActionPreference='SilentlyContinue'
Add-Type -Namespace E -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out RECT r); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p); public struct RECT { public int L; public int T; public int R; public int B; }'
Add-Type -AssemblyName System.Windows.Forms
$fg=$null; $h=[E.W]::GetForegroundWindow(); $r=New-Object E.W+RECT; $pid2=0
if ([E.W]::GetWindowRect($h,[ref]$r)) { [void][E.W]::GetWindowThreadProcessId($h,[ref]$pid2); $s=[System.Windows.Forms.Screen]::FromHandle($h).Bounds
  if ($r.L -le $s.Left -and $r.T -le $s.Top -and $r.R -ge $s.Right -and $r.B -ge $s.Bottom) { $fg=(Get-Process -Id $pid2).ProcessName + '.exe' } }
$p=Get-Process | Select-Object @{n='name';e={$_.ProcessName+'.exe'}}, @{n='path';e={$_.Path}}
@{ processes=$p; fullscreen=$fg } | ConvertTo-Json -Compress -Depth 3`;
  const run = (exe: string, args: string[]) =>
    new Promise<string>((done) => execFile(exe, args, { timeout: 15_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => done(err ? '' : String(out))));
  return Promise.all([run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]), run('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'])]).then(([a, b]) => {
    let j: any = {};
    try {
      j = JSON.parse(a);
    } catch {}
    const util = Number.parseFloat(b.trim().split(/\r?\n/)[0] ?? '');
    return { processes: Array.isArray(j.processes) ? j.processes : [], fullscreen: j.fullscreen ?? null, gpuUtil: Number.isFinite(util) ? util : null };
  });
}

export function detectGame(sig: GameSignals, opts: { games?: string[]; ourGpuBusy?: boolean } = {}): string | null {
  const games = (opts.games ?? GAME_PROCESSES).map((g) => g.toLowerCase());
  const byName = sig.processes.find((p) => games.includes(p.name.toLowerCase()));
  if (byName) return `jogo aberto: ${byName.name}`;
  const steam = sig.processes.find((p) => p.path && /\\steamapps\\common\\/i.test(p.path));
  if (steam) return `jogo da Steam aberto: ${steam.name}`;
  if (sig.fullscreen && !NOT_GAMES.test(sig.fullscreen)) return `tela cheia: ${sig.fullscreen}`;
  if (sig.gpuUtil !== null && sig.gpuUtil > 60 && !opts.ourGpuBusy) return `GPU em ${Math.round(sig.gpuUtil)}% por outro programa`;
  return null;
}

export class GameMode {
  private store: Store;
  private probe: () => Promise<GameSignals>;
  private lastSeen = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  onChange: (s: GameModeState) => void = () => {};
  // O EMANNU OS está usando a GPU agora (não confundir com jogo).
  ourGpuBusy: () => boolean = () => false;

  constructor(store: Store, probe: () => Promise<GameSignals> = probeWindows) {
    this.store = store;
    this.probe = probe;
  }

  state(): GameModeState {
    return this.store.kvGet<GameModeState>('modojogo') ?? { ativo: false, desde: null, motivo: null, pausarTudo: false, historico: [] };
  }

  private save(s: GameModeState) {
    this.store.kvSet('modojogo', s);
    this.onChange(s);
  }

  setPauseAll(on: boolean): GameModeState {
    const s = { ...this.state(), pausarTudo: on };
    this.save(s);
    return s;
  }

  async check(now = Date.now()): Promise<GameModeState> {
    let reason: string | null = null;
    try {
      reason = detectGame(await this.probe(), { ourGpuBusy: this.ourGpuBusy() });
    } catch {
      reason = null;
    }
    const s = this.state();
    if (reason) {
      this.lastSeen = now;
      if (!s.ativo) {
        const at = new Date(now).toISOString();
        this.save({ ...s, ativo: true, desde: at, motivo: reason, historico: [{ inicio: at, fim: null, motivo: reason }, ...s.historico].slice(0, 50) });
      }
    } else if (s.ativo && now - (this.lastSeen || Date.parse(s.desde ?? '0')) >= IDLE_MS) {
      const at = new Date(now).toISOString();
      this.save({ ...s, ativo: false, desde: null, motivo: null, historico: s.historico.map((h, i) => (i === 0 && !h.fim ? { ...h, fim: at } : h)) });
    }
    return this.state();
  }

  // Este job pode começar agora?
  blocks(job: { gpuRequired: boolean }): string | null {
    const s = this.state();
    if (!s.ativo) return null;
    if (s.pausarTudo) return 'Modo jogo: tudo pausado (você pediu silêncio total)';
    return job.gpuRequired ? 'Modo jogo: GPU pausada até você parar de jogar' : null;
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), intervalMs);
    void this.check();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
