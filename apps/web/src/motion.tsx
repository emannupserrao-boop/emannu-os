// Movimento da interface: troca de telas, indicador das abas e esqueletos de carregamento.
import { useLayoutEffect, useRef } from 'react';
import { flushSync } from 'react-dom';

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

type VTDocument = Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void>; finished: Promise<void> } };

// Troca de tela animada pela View Transitions API (Chrome, Edge e Android).
// "kind" escolhe a animação no CSS (html[data-vt=...]); sem suporte, só troca.
export function withTransition(update: () => void, kind: 'view' | 'close' | 'reorder' = 'view') {
  const d = document as VTDocument;
  if (!d.startViewTransition || reduced()) return update();
  document.documentElement.dataset.vt = kind;
  const t = d.startViewTransition(() => flushSync(update));
  // Se a animação for pulada (ex.: dois painéis abertos), a troca acontece mesmo assim.
  t.ready.catch(() => {});
  t.finished.finally(() => {
    delete document.documentElement.dataset.vt;
  });
}

// Indicador que desliza até a aba ativa: mede o botão selecionado e passa a posição ao CSS.
export function useTabIndicator<T extends HTMLElement>(active: string) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const nav = ref.current;
    if (!nav) return;
    const place = () => {
      const on = nav.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!on) return;
      nav.style.setProperty('--ind-x', `${on.offsetLeft}px`);
      nav.style.setProperty('--ind-w', `${on.offsetWidth}px`);
      nav.style.setProperty('--ind-h', `${on.offsetHeight}px`);
      nav.style.setProperty('--ind-y', `${on.offsetTop}px`);
      // Na primeira medida não anima (evita o indicador "voar" do canto ao abrir).
      requestAnimationFrame(() => (nav.dataset.ready = '1'));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(nav);
    for (const b of nav.children) ro.observe(b);
    return () => ro.disconnect();
  }, [active]);
  return ref;
}

// Placeholder de carregamento com brilho que passa (no lugar de "Carregando…").
export function Skeleton({ cards = 3, label = 'Carregando…' }: { cards?: number; label?: string }) {
  return (
    <div className="skeleton-grid" role="status" aria-label={label}>
      {Array.from({ length: cards }, (_, i) => (
        <div key={i} className="skeleton-card" aria-hidden>
          <span className="sk sk-title" />
          <span className="sk" />
          <span className="sk sk-short" />
        </div>
      ))}
    </div>
  );
}
