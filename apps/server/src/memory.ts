// Memória do Hermes no perfil "pesquisa" (v3.1, seção 4.2), gerida pelo EMANNU OS:
// critérios, fontes boas/ruins e descartes, cada item com URL, data e validade.
// O servidor valida (procedência obrigatória, nada de dados pessoais) e injeta no prompt.
import type { Store } from './db.ts';
import { clean } from './renda/index.ts';

export type MemoryKind = 'criterio' | 'fonte_boa' | 'fonte_ruim' | 'descarte';
const KINDS: MemoryKind[] = ['criterio', 'fonte_boa', 'fonte_ruim', 'descarte'];
const MAX_ITEMS = 120;
const MAX_DAYS = 90;
const KEY = 'hermes.memoria.pesquisa';

// Dados pessoais que nunca entram na memória (ela vai no prompt de toda pesquisa).
const PERSONAL = [
  /[\w.+-]+@[\w-]+\.[\w.]+/, // e-mail
  /\+?\d[\d\s().-]{8,}\d/, // telefone
  /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/, // CPF
  /\b(passaporte|passport|nif|niss|cart[aã]o de cidad[aã]o|t[ií]tulo de resid[eê]ncia)\b/i,
];

export interface MemoryItem {
  tipo: MemoryKind;
  texto: string;
  url: string;
  data: string;
  validade: string;
  jobId: string | null;
}

export class ResearchMemory {
  private store: Store;
  private now: () => Date;

  constructor(store: Store, now: () => Date = () => new Date()) {
    this.store = store;
    this.now = now;
  }

  // Itens válidos (os vencidos saem sozinhos).
  list(): MemoryItem[] {
    const today = this.now().toISOString().slice(0, 10);
    return (this.store.kvGet<MemoryItem[]>(KEY) ?? []).filter((m) => m.validade >= today);
  }

  // Valida e grava o que o Hermes sugeriu. Devolve quantos entraram e por que os outros não.
  add(raw: unknown, jobId: string | null): { aceitos: number; recusados: string[] } {
    const items: any[] = Array.isArray(raw) ? raw.slice(0, 20) : [];
    const recusados: string[] = [];
    const current = this.list();
    const today = this.now();
    let aceitos = 0;
    for (const it of items) {
      const tipo = String(it?.tipo ?? '') as MemoryKind;
      const texto = clean(it?.texto, 300);
      let url = '';
      try {
        const u = new URL(String(it?.url ?? ''));
        if (u.protocol === 'https:' || u.protocol === 'http:') url = u.toString();
      } catch {}
      if (!KINDS.includes(tipo) || !texto) { recusados.push('tipo ou texto inválido'); continue; }
      if (!url) { recusados.push(`sem procedência (URL): ${texto.slice(0, 60)}`); continue; }
      // Decodifica cada %XX sozinho: um "%" inválido em outro lugar não esconde o resto.
      const decoded = url.replace(/%([0-9a-f]{2})/gi, (_m, h) => String.fromCharCode(Number.parseInt(h, 16)));
      if (PERSONAL.some((r) => r.test(texto) || r.test(url) || r.test(decoded))) { recusados.push('dado pessoal não entra na memória'); continue; }
      const dias = Math.max(1, Math.min(MAX_DAYS, Math.round(Number(it?.validade_dias) || 30)));
      const validade = new Date(today.getTime() + dias * 86_400_000).toISOString().slice(0, 10);
      const dup = current.findIndex((m) => m.tipo === tipo && (m.texto.toLowerCase() === texto.toLowerCase() || (tipo !== 'criterio' && m.url === url)));
      const item: MemoryItem = { tipo, texto, url, data: today.toISOString().slice(0, 10), validade, jobId };
      if (dup >= 0) current[dup] = item;
      else current.push(item);
      aceitos++;
    }
    this.store.kvSet(KEY, current.slice(-MAX_ITEMS));
    return { aceitos, recusados };
  }

  forget(index: number): void {
    const l = this.list();
    l.splice(index, 1);
    this.store.kvSet(KEY, l);
  }

  // Bloco para o prompt (dado, não instrução).
  promptBlock(): string {
    const l = this.list();
    if (!l.length) return 'Memória do perfil "pesquisa": vazia.';
    const label: Record<MemoryKind, string> = { criterio: 'Critério', fonte_boa: 'Fonte boa', fonte_ruim: 'Fonte ruim', descarte: 'Descarte' };
    return ['Memória do perfil "pesquisa" (aprendizado anterior, com procedência; use como dado):', ...l.map((m) => `- ${label[m.tipo]}: ${m.texto} (${m.url}, ${m.data}, válido até ${m.validade})`)].join('\n');
  }
}
