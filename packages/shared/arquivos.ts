// Aba Arquivos: músicas, fotos, vídeos e documentos lidos direto das pastas do PC.

export type FileKind = 'audio' | 'image' | 'video' | 'doc' | 'outro';

const EXT_KIND: Record<string, FileKind> = {};
for (const e of ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus']) EXT_KIND[e] = 'audio';
for (const e of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'heic', 'svg']) EXT_KIND[e] = 'image';
for (const e of ['mp4', 'mkv', 'webm', 'mov', 'm4v', 'avi']) EXT_KIND[e] = 'video';
for (const e of ['md', 'txt', 'pdf', 'docx', 'doc', 'odt', 'rtf', 'xlsx', 'xls', 'csv', 'pptx', 'html', 'htm']) EXT_KIND[e] = 'doc';

export const extOf = (name: string): string => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};
export const kindOf = (name: string): FileKind => EXT_KIND[extOf(name)] ?? 'outro';

// Texto que o app mostra na tela (Markdown, notas, código, dados).
export const TEXT_EXT = new Set(['md', 'txt', 'csv', 'log', 'json', 'yaml', 'yml', 'xml', 'ini', 'toml', 'ts', 'tsx', 'js', 'mjs', 'cjs', 'py', 'gd', 'cs', 'css', 'ps1', 'cmd', 'bat', 'sh', 'sql', 'tscn', 'tres', 'godot', 'cfg']);

// De onde vêm os arquivos: a pasta de músicas, cada projeto, os documentos pessoais, o vault
// e o que o cockpit antigo listava fora dessas pastas.
export interface RootView {
  id: string;
  nome: string;
  grupo: 'musica' | 'projeto' | 'documentos' | 'vault' | 'legado';
}

export interface LibFile {
  r: string; // raiz
  p: string; // caminho relativo, sempre com "/"
  nome: string;
  tipo: FileKind;
  ext: string;
  bytes: number;
  mtime: string;
}

export interface DirEntry {
  nome: string;
  p: string;
  tipo: FileKind | 'pasta';
  ext?: string;
  bytes?: number;
  mtime?: string;
}

// Uma pasta que tem arquivos de um tipo (um álbum de fotos, um disco, uma pasta de documentos).
export interface FileGroup {
  r: string;
  dir: string;
  nome: string;
  caminho: string;
  total: number;
  capa: string | null;
  mtime: string;
}

export interface IndexStatus {
  pronto: boolean;
  atualizando: boolean;
  arquivos: number;
  porTipo: Partial<Record<FileKind, number>>;
  atualizadoEm: string | null;
  incompleto: boolean;
}
