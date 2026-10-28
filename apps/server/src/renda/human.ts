// Autorização humana verificável (v3.1, seção 4.1): enviar, marcar resposta, registrar
// pagamento e marcar candidatura enviada só valem com
//   1) a sessão de um aparelho do Emannuel (cookie do aparelho; o token local de
//      administrador, que scripts e agentes conseguem ler no disco, NÃO serve) e
//   2) uma confirmação pedida pela interface para aquela ação, naquele item, usada uma vez.
// Campos no corpo da requisição ("autorizado": true etc.) são ignorados.
import { randomBytes } from 'node:crypto';
import type { Device } from '../auth.ts';

const TTL_MS = 2 * 60_000;

interface Pending {
  deviceId: string;
  acao: string;
  alvo: string;
  expires: number;
}

export class HumanConfirm {
  private pending = new Map<string, Pending>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private deviceOf(device: Device | 'admin' | null): Device {
    if (!device || device === 'admin') throw Object.assign(new Error('Só o Emannuel, pelo app num aparelho registrado, pode fazer isso.'), { statusCode: 403 });
    return device;
  }

  request(device: Device | 'admin' | null, acao: string, alvo: string): { id: string; expiraEm: string } {
    const d = this.deviceOf(device);
    for (const [k, p] of this.pending) if (p.expires < this.now()) this.pending.delete(k);
    const id = randomBytes(16).toString('base64url');
    const expires = this.now() + TTL_MS;
    this.pending.set(id, { deviceId: d.id, acao, alvo, expires });
    return { id, expiraEm: new Date(expires).toISOString() };
  }

  // Consome a confirmação. Lança 403 se faltar, expirou, é de outro aparelho ou de outra ação.
  verify(device: Device | 'admin' | null, id: unknown, acao: string, alvo: string): void {
    const d = this.deviceOf(device);
    const p = typeof id === 'string' ? this.pending.get(id) : undefined;
    if (typeof id === 'string') this.pending.delete(id);
    if (!p || p.expires < this.now() || p.deviceId !== d.id || p.acao !== acao || p.alvo !== alvo) {
      throw Object.assign(new Error('Confirmação inválida ou expirada. Toque no botão de novo e confirme.'), { statusCode: 403 });
    }
  }
}
