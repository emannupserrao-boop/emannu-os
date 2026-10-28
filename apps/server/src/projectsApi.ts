// Rotas da aba Projetos e dos arquivos do legado.
// Os arquivos são servidos só se estiverem nos manifestos (lista fechada), em modo
// leitura e em "sandbox": um HTML antigo não roda scripts dentro do app.
import type { FastifyInstance } from 'fastify';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { Scheduler } from './scheduler.ts';
import { buildProjectCards } from './projects.ts';
import { importLegacy, type LegacyFile, type LegacyImport } from './legacy.ts';
import { sessionSummary } from './history.ts';
import type { ProjectCard } from '../../../packages/shared/types.ts';
import { DOC_DONE, allSources, computeTimeline, isStale, type ImmigrationState } from '../../../packages/shared/immigration.ts';

// Card do espaço próprio da Imigração Portugal (dados do módulo de Imigração).
function immigrationCard(s: ImmigrationState): ProjectCard {
  const today = new Date().toISOString().slice(0, 10);
  const rec = s.legal?.rotas.find((r) => r.id === s.legal!.recomendacao.rotaId) ?? null;
  const docs = s.docs?.itens ?? [];
  const next = computeTimeline(s, today).find((t) => t.diasAte >= 0) ?? null;
  const sources = allSources(s);
  const lastOk = s.research.map((r) => r.lastOkAt).filter(Boolean).sort().at(-1) ?? null;
  return {
    id: 'imigracao-portugal',
    nome: 'Imigração Portugal',
    isLegacy: false,
    logo: '/projetos/imigracao.png',
    badge: 'ESPAÇO PRÓPRIO',
    proposito: 'Planejar a mudança da família para Portugal como trabalhador, com a família junta e os dois podendo trabalhar.',
    estadoAtual: s.legal ? { texto: `${s.legal.recomendacao.titulo}. ${s.legal.recomendacao.porque}`, fonte: `${s.vaultFolder.replace(/\\/g, '/')}/Painel.md` } : null,
    legado: null,
    pasta: null,
    vaultFolder: s.vaultFolder,
    jobsAbertos: 0,
    aguardandoVoce: 0,
    entregas: [],
    midias: { total: 0, porTipo: {}, amostra: [] },
    documentos: [],
    imigracao: {
      rota: rec?.nome ?? null,
      familiaJunta: rec?.familiaJunta ?? null,
      naoConfirmados: (s.verificacao?.itens ?? []).filter((v) => v.resultado !== 'confirmado').length,
      vagas: s.jobs?.vagas.length ?? 0,
      vagasComVisto: s.jobs?.vagas.filter((v) => v.permiteVisto === 'sim').length ?? 0,
      candidaturasProntas: (s.jobs?.vagas ?? []).filter((v) => s.user.vagas[v.id]?.status === 'pronta').length,
      docsProntos: docs.filter((d) => DOC_DONE.includes(s.user.docs[d.id]?.status ?? 'falta')).length,
      docsTotal: docs.length,
      proximoPrazo: next ? { data: next.data, titulo: next.titulo, diasAte: next.diasAte } : null,
      fontes: sources.length,
      fontesRever: sources.filter((f) => isStale(f, today)).length,
      pesquisadoEm: lastOk,
    },
  };
}

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.pdf': 'application/pdf',
};

export function registerProjectsApi(app: FastifyInstance, sched: Scheduler, legacyDir: string | null) {
  let legacy: LegacyImport | null = legacyDir ? importLegacy(sched.store, legacyDir) : sched.store.kvGet('legado');
  let index = new Map<string, LegacyFile>();
  const reindex = () => {
    index = new Map([...(legacy?.media ?? []), ...(legacy?.documents ?? [])].map((f) => [f.id, f]));
  };
  reindex();

  const cards = async (): Promise<ProjectCard[]> => {
    const list = buildProjectCards(sched.store, sched.vault, legacy);
    const h = sched.history;
    if (h) {
      for (const c of list) {
        const sessions = await h.index.sessionsFor(h.dirsFor(c.id, c.pasta?.path ?? null));
        c.codigo = { total: sessions.length, sessoes: sessions.slice(0, 8).map(sessionSummary), historico: h.get(c.id), gerando: h.pending(c.id) };
      }
    }
    const imm = sched.immigration?.state();
    if (imm) list.unshift(immigrationCard(imm));
    return list;
  };

  app.get('/api/projetos', async () => cards());

  // Gera (ou refaz) o resumo do que já foi feito no Claude Code para um projeto.
  app.post<{ Params: { id: string } }>('/api/projetos/:id/historico', async (req) => {
    const h = sched.history;
    if (!h) throw new Error('Histórico do Claude Code desativado');
    const c = (await cards()).find((x) => x.id === req.params.id);
    if (!c) throw Object.assign(new Error('Projeto não encontrado'), { statusCode: 404 });
    return h.summarize(c.id, c.nome, h.dirsFor(c.id, c.pasta?.path ?? null), c.vaultFolder);
  });

  app.post('/api/legado/importar', async () => {
    if (!legacyDir) throw new Error('Pasta do cockpit antigo não configurada');
    legacy = importLegacy(sched.store, legacyDir, true);
    reindex();
    return { projetos: legacy?.projects.length ?? 0, midias: legacy?.media.length ?? 0, documentos: legacy?.documents.length ?? 0, ignorados: legacy?.skipped ?? [] };
  });

  app.get<{ Params: { id: string } }>('/api/legado/arquivo/:id', async (req, reply) => {
    const f = index.get(req.params.id);
    if (!f || !existsSync(f.path)) return reply.code(404).send({ error: 'Arquivo não encontrado' });
    const size = statSync(f.path).size;
    const type = MIME[extname(f.path).toLowerCase()] ?? 'application/octet-stream';
    reply
      .header('Content-Type', type)
      .header('Content-Security-Policy', 'sandbox')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, max-age=3600')
      .header('Accept-Ranges', 'bytes');
    // Áudio e vídeo pedem pedaços (Range) para tocar e avançar.
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start > end || start >= size) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`).header('Content-Length', end - start + 1);
      return reply.send(createReadStream(f.path, { start, end }));
    }
    reply.header('Content-Length', size);
    return reply.send(createReadStream(f.path));
  });
}
