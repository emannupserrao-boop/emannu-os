// Tarefas preparadas pelos agentes; o estado é confirmado pelo humano na API.
import { randomBytes } from 'node:crypto';
import type { Store } from '../db.ts';
import { localDate } from '../routines.ts';
import { HOJE_BLOCOS, type HojeTarefa, type HojeTarefaEstado, type NovaHojeTarefa } from '../../../../packages/shared/renda.ts';

export function validarDataTarefa(data: unknown): asserts data is string {
  if (typeof data !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new Error('Data inválida (YYYY-MM-DD).');
  const parsed = new Date(`${data}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== data) throw new Error('Data inválida.');
}

const toTarefa = (r: any): HojeTarefa => ({
  id: r.id, data: r.data, bloco: r.bloco, titulo: r.titulo, detalhe: r.detalhe,
  minutos: r.minutos, ordem: r.ordem, textoCopiar: r.texto_copiar, url: r.url, arquivo: r.arquivo,
  estado: r.estado, criadaEm: r.criada_em, feitaEm: r.feita_em, origem: r.origem,
});

export class HojeTarefas {
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  criar(input: NovaHojeTarefa, now = new Date()): HojeTarefa {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Informe a tarefa.');
    const data = input.data === undefined ? localDate(now) : input.data;
    validarDataTarefa(data);
    if (typeof input.titulo !== 'string' || input.titulo.trim().length < 3 || input.titulo.trim().length > 140) throw new Error('Título deve ter de 3 a 140 caracteres.');
    if (typeof input.bloco !== 'string' || !Object.hasOwn(HOJE_BLOCOS, input.bloco)) throw new Error('Bloco inválido.');
    if (!Number.isInteger(input.minutos) || input.minutos < 1 || input.minutos > 45) throw new Error('Minutos devem ser de 1 a 45.');
    const ordem = input.ordem === undefined ? 0 : input.ordem;
    if (!Number.isSafeInteger(ordem)) throw new Error('Ordem deve ser um inteiro.');
    if (!['claude', 'codex', 'rocky', 'emannuel'].includes(input.origem)) throw new Error('Origem inválida.');
    for (const value of [input.detalhe, input.textoCopiar, input.url, input.arquivo]) {
      if (value !== undefined && typeof value !== 'string') throw new Error('Campos de texto inválidos.');
    }
    if (input.url !== undefined) {
      let url: URL;
      try { url = new URL(input.url); } catch { throw new Error('URL deve ser http(s).'); }
      if (!/^https?:\/\//i.test(input.url) || !['http:', 'https:'].includes(url.protocol)) throw new Error('URL deve ser http(s).');
    }
    // Unidade ou compartilhamento UNC; nunca caminho relativo ou protocolo file:.
    if (input.arquivo !== undefined && (
      !/^(?:[a-z]:[\\/]|\\\\[^\\/?:*"<>|]+\\[^\\/?:*"<>|]+(?:\\|$))/i.test(input.arquivo)
      || /[\u0000-\u001f<>"|?*]/.test(input.arquivo)
      || /:/.test(input.arquivo.replace(/^[a-z]:/i, ''))
    )) throw new Error('Arquivo deve ser um caminho absoluto Windows.');
    const id = `tarefa-${randomBytes(6).toString('hex')}`;
    this.store.db.prepare(`INSERT INTO hoje_tarefas
      (id, data, bloco, titulo, detalhe, minutos, ordem, texto_copiar, url, arquivo, criada_em, origem)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, data, input.bloco, input.titulo.trim(), input.detalhe ?? '', input.minutos, ordem,
        input.textoCopiar ?? null, input.url ?? null, input.arquivo ?? null, now.toISOString(), input.origem);
    return this.obter(id)!;
  }

  obter(id: string): HojeTarefa | null {
    const r = this.store.db.prepare('SELECT * FROM hoje_tarefas WHERE id = ?').get(id);
    return r ? toTarefa(r) : null;
  }

  listar(data = localDate(new Date())): HojeTarefa[] {
    validarDataTarefa(data);
    return this.store.db.prepare('SELECT * FROM hoje_tarefas WHERE data = ? ORDER BY ordem, criada_em, rowid').all(data).map(toTarefa);
  }

  abertasAte(data: string): HojeTarefa[] {
    validarDataTarefa(data);
    return this.store.db.prepare("SELECT * FROM hoje_tarefas WHERE estado = 'aberta' AND data <= ? ORDER BY ordem, data, criada_em, rowid").all(data).map(toTarefa);
  }

  // Só chamado pela API depois da confirmação humana.
  mudarEstado(id: string, estado: HojeTarefaEstado, now = new Date()): HojeTarefa {
    if (!['aberta', 'feita', 'pulada'].includes(estado)) throw new Error('Estado inválido.');
    const r = this.store.db.prepare(`UPDATE hoje_tarefas SET
      feita_em = CASE WHEN ? = 'feita' THEN coalesce(feita_em, ?) ELSE NULL END, estado = ? WHERE id = ?`)
      .run(estado, now.toISOString(), estado, id);
    if (!r.changes) throw new Error('Tarefa não encontrada.');
    return this.obter(id)!;
  }

  remover(id: string): void {
    const r = this.store.db.prepare("DELETE FROM hoje_tarefas WHERE id = ? AND estado = 'aberta'").run(id);
    if (!r.changes) throw new Error('Só é possível remover uma tarefa aberta existente.');
  }
}
