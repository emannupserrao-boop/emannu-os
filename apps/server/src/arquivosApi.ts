// Rotas da aba Arquivos. Tudo é leitura; o arquivo é pedido como /f/<raiz>/<caminho>, assim um
// HTML aberto no app acha as imagens ao lado dele pelo caminho relativo.
import type { FastifyInstance } from 'fastify';
import { HttpError, Library, sendFile } from './arquivos.ts';
import type { FileKind } from '../../../packages/shared/arquivos.ts';

const KINDS = new Set<FileKind>(['audio', 'image', 'video', 'doc']);
const kind = (t: unknown): FileKind => {
  if (!KINDS.has(t as FileKind)) throw new HttpError(400, 'Tipo inválido');
  return t as FileKind;
};

export function registerArquivosApi(app: FastifyInstance, lib: Library) {
  app.get('/api/arquivos', async () => {
    lib.index().catch(() => {});
    return { raizes: lib.roots().map(({ id, nome, grupo }) => ({ id, nome, grupo })), indice: lib.status() };
  });

  app.post('/api/arquivos/reindexar', async () => {
    await lib.index(true);
    return lib.status();
  });

  app.get<{ Querystring: { r?: string; p?: string } }>('/api/arquivos/pasta', async (req) => {
    const r = String(req.query.r ?? '');
    if (r === 'legado') return lib.legacyList(req.query.p || null);
    return lib.list(r, String(req.query.p ?? ''));
  });

  app.get<{ Querystring: { tipo?: string; r?: string } }>('/api/arquivos/grupos', async (req) => lib.groups(kind(req.query.tipo), req.query.r || undefined));

  app.get<{ Querystring: { tipo?: string; r?: string; dir?: string; q?: string; limite?: string } }>('/api/arquivos/itens', async (req) =>
    lib.items({
      tipo: req.query.tipo ? kind(req.query.tipo) : undefined,
      r: req.query.r || undefined,
      dir: req.query.dir,
      busca: req.query.q,
      limite: Number(req.query.limite) || undefined,
    }),
  );

  // Caminho do PC → arquivo do app (para abrir aqui o que outra aba só mostrava como caminho).
  app.get<{ Querystring: { caminho?: string } }>('/api/arquivos/localizar', async (req) => lib.locate(String(req.query.caminho ?? '')) ?? { r: null, p: null });

  app.get<{ Params: { r: string; '*': string }; Querystring: { baixar?: string } }>('/api/arquivos/f/:r/*', async (req, reply) => {
    const f = lib.resolve(req.params.r, req.params['*'] ?? '');
    if (!f.st.isFile()) throw new HttpError(404, 'Arquivo não encontrado');
    const name = f.root.grupo === 'legado' ? undefined : f.rel.split('/').at(-1);
    return sendFile(req, reply, f.abs, { download: req.query.baixar === '1', name });
  });

  app.get<{ Params: { r: string; '*': string }; Querystring: { w?: string } }>('/api/arquivos/mini/:r/*', async (req, reply) => {
    const t = await lib.thumb(req.params.r, req.params['*'] ?? '', Number(req.query.w) || 360);
    if (!t) throw new HttpError(404, 'Sem miniatura');
    return sendFile(req, reply, t.path, { type: t.type, maxAge: 86400 });
  });
}
