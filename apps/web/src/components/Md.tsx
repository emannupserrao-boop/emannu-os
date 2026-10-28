// Markdown simples das notas do vault (títulos, listas, **negrito**, _itálico_, `código`, [links](url)),
// sem HTML cru: o texto vira elementos React, então nada da nota roda como código.
import { Fragment, type ReactNode } from 'react';

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (t.startsWith('**') || t.startsWith('__')) out.push(<b key={k}>{t.slice(2, -2)}</b>);
    else if (t.startsWith('`')) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (t.startsWith('[')) {
      const [, label, url] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!;
      out.push(/^https?:\/\//.test(url) ? <a key={k} href={url} target="_blank" rel="noreferrer">{label}</a> : <span key={k}>{label}</span>);
    } else out.push(<i key={k}>{t.slice(1, -1)}</i>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Md({ text, className = '' }: { text: string; className?: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let para: string[] = [];
  const flushList = () => {
    if (!list.length) return;
    const items = list;
    blocks.push(
      <ul key={`l${blocks.length}`}>
        {items.map((x, i) => (
          <li key={i}>{inline(x, `li${blocks.length}-${i}`)}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  const flushPara = () => {
    if (!para.length) return;
    blocks.push(<p key={`p${blocks.length}`}>{inline(para.join(' '), `p${blocks.length}`)}</p>);
    para = [];
  };
  for (const raw of text.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const li = /^([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (!line) {
      flushList();
      flushPara();
    } else if (h) {
      flushList();
      flushPara();
      blocks.push(<p key={`h${blocks.length}`} className="md-h">{inline(h[2], `h${blocks.length}`)}</p>);
    } else if (li) {
      flushPara();
      list.push(li[2]);
    } else if (/^[-*_]{3,}$/.test(line)) {
      flushList();
      flushPara();
    } else {
      flushList();
      para.push(line.replace(/^>\s?/, ''));
    }
  }
  flushList();
  flushPara();
  return <div className={`md ${className}`}>{blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</div>;
}
