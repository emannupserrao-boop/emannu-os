// Acesso ao EMANNU OS: um PIN (definido no PC) e um token por aparelho.
// - O PIN só é usado para registrar um aparelho; depois o aparelho usa o token (cookie httpOnly).
// - Cada aparelho pode ser revogado. Tentativas erradas de PIN bloqueiam por um tempo.
// - Scripts locais usam o token de administrador gravado em var/admin-token (só quem tem
//   acesso ao disco do PC consegue ler).
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Store } from './db.ts';

export interface Device {
  id: string;
  name: string;
  createdAt: string;
  lastSeen: string;
}

interface StoredDevice extends Device {
  tokenHash: string;
}

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export class Auth {
  private store: Store;
  readonly adminToken: string;
  private fails = 0;
  private lockedUntil = 0;
  private now: () => number;

  constructor(store: Store, adminTokenPath: string, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
    if (existsSync(adminTokenPath)) this.adminToken = readFileSync(adminTokenPath, 'utf8').trim();
    else {
      this.adminToken = randomBytes(32).toString('hex');
      mkdirSync(dirname(adminTokenPath), { recursive: true });
      writeFileSync(adminTokenPath, this.adminToken, { mode: 0o600 });
    }
  }

  isConfigured(): boolean {
    return !!this.store.kvGet('auth.pin');
  }

  static validPin(pin: unknown): pin is string {
    return typeof pin === 'string' && /^\d{6,12}$/.test(pin);
  }

  setPin(pin: string): void {
    if (!Auth.validPin(pin)) throw new Error('O PIN precisa ter de 6 a 12 números.');
    const salt = randomBytes(16).toString('hex');
    this.store.kvSet('auth.pin', { salt, hash: scryptSync(pin, salt, 32).toString('hex') });
  }

  // Confere o PIN com limite de tentativas. Retorna o motivo da recusa, ou null se correto.
  checkPin(pin: unknown): { ok: true } | { ok: false; error: string; status: number } {
    const t = this.now();
    if (t < this.lockedUntil) {
      return { ok: false, status: 429, error: `Muitas tentativas. Tente de novo em ${Math.ceil((this.lockedUntil - t) / 60_000)} min.` };
    }
    const saved = this.store.kvGet<{ salt: string; hash: string }>('auth.pin');
    if (!saved) return { ok: false, status: 409, error: 'O PIN ainda não foi definido (faça isso no PC).' };
    const good = typeof pin === 'string' && timingSafeEqual(scryptSync(pin, saved.salt, 32), Buffer.from(saved.hash, 'hex'));
    if (good) {
      this.fails = 0;
      return { ok: true };
    }
    this.fails++;
    if (this.fails >= MAX_FAILS) {
      this.lockedUntil = t + LOCK_MS;
      this.fails = 0;
      return { ok: false, status: 429, error: 'PIN errado. Acesso bloqueado por 15 minutos.' };
    }
    return { ok: false, status: 401, error: `PIN errado. Restam ${MAX_FAILS - this.fails} tentativa(s).` };
  }

  private devices(): StoredDevice[] {
    return this.store.kvGet<StoredDevice[]>('auth.devices') ?? [];
  }

  listDevices(): Device[] {
    return this.devices().map(({ tokenHash: _h, ...d }) => d);
  }

  createDevice(name: string): { device: Device; token: string } {
    const token = randomBytes(32).toString('base64url');
    const at = new Date(this.now()).toISOString();
    const device: StoredDevice = { id: randomBytes(6).toString('hex'), name: name.trim().slice(0, 60) || 'Aparelho', createdAt: at, lastSeen: at, tokenHash: sha256(token) };
    this.store.kvSet('auth.devices', [...this.devices(), device]);
    const { tokenHash: _h, ...pub } = device;
    return { device: pub, token };
  }

  // Aparelho dono do token (ou "admin" para o token local). Atualiza o "visto por último".
  verify(token: string | undefined): Device | 'admin' | null {
    if (!token) return null;
    if (token.length === this.adminToken.length && timingSafeEqual(Buffer.from(token), Buffer.from(this.adminToken))) return 'admin';
    const hash = sha256(token);
    const list = this.devices();
    const d = list.find((x) => x.tokenHash === hash);
    if (!d) return null;
    const at = new Date(this.now()).toISOString();
    if (this.now() - Date.parse(d.lastSeen) > 60_000) {
      d.lastSeen = at;
      this.store.kvSet('auth.devices', list);
    }
    const { tokenHash: _h, ...pub } = d;
    return pub;
  }

  revoke(id: string): boolean {
    const list = this.devices();
    const next = list.filter((d) => d.id !== id);
    this.store.kvSet('auth.devices', next);
    return next.length !== list.length;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
