// Abas principais com ordem personalizável: arrastar (PC) ou setas (celular).
// A ordem fica salva no PC (vale para todos os aparelhos) e também no aparelho.
import { useState, type ComponentType, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, GripVertical, Pencil, RotateCcw } from 'lucide-react';
import { useTabIndicator, withTransition } from '../motion.tsx';

export interface TabDef<K extends string> {
  key: K;
  label: string;
  Icon: ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: boolean }>;
}

// Junta a ordem salva com as abas que existem hoje (abas novas entram no fim).
// Ordem salva + abas novas na posição padrão delas (ex.: Renda entra em primeiro).
export function mergeOrder<K extends string>(saved: unknown, all: K[]): K[] {
  const out = [...new Set(Array.isArray(saved) ? (saved.filter((k) => all.includes(k)) as K[]) : [])];
  all.forEach((k, i) => {
    if (!out.includes(k)) out.splice(Math.min(i, out.length), 0, k);
  });
  return out;
}

export function TabsBar<K extends string>(props: {
  tabs: TabDef<K>[];
  order: K[];
  active: K;
  indicatorKey: string;
  badge(key: K): ReactNode;
  onGo(key: K): void;
  onOrder(order: K[]): void;
}) {
  const [editing, setEditing] = useState(false);
  const [drag, setDrag] = useState<K | null>(null);
  const ref = useTabIndicator<HTMLElement>(`${props.indicatorKey}|${props.order.join()}|${editing}`);
  const byKey = Object.fromEntries(props.tabs.map((t) => [t.key, t])) as Record<K, TabDef<K>>;
  const move = (key: K, to: number, animate = true) => {
    const o = props.order.filter((k) => k !== key);
    o.splice(Math.max(0, Math.min(o.length, to)), 0, key);
    if (o.join() === props.order.join()) return;
    animate ? withTransition(() => props.onOrder(o), 'reorder') : props.onOrder(o);
  };

  if (editing) {
    return (
      <div className="tabs-editor" role="group" aria-label="Personalizar a ordem das abas">
        <ol className="tabs-edit-list">
          {props.order.map((key, i) => {
            const t = byKey[key];
            return (
              <li
                key={key}
                className={`tabchip ${drag === key ? 'dragging' : ''}`}
                style={{ viewTransitionName: `aba-${key}` }}
                draggable
                onDragStart={(e) => {
                  setDrag(key);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (drag && drag !== key) move(drag, i, false);
                }}
                onDragEnd={() => setDrag(null)}
              >
                <GripVertical size={16} strokeWidth={1.75} aria-hidden />
                <t.Icon size={16} strokeWidth={1.75} aria-hidden />
                <span>{t.label}</span>
                <button className="btn btn-icon btn-ghost btn-small" disabled={i === 0} onClick={() => move(key, i - 1)} aria-label={`Mover ${t.label} para a esquerda`}>
                  <ArrowLeft size={15} />
                </button>
                <button className="btn btn-icon btn-ghost btn-small" disabled={i === props.order.length - 1} onClick={() => move(key, i + 1)} aria-label={`Mover ${t.label} para a direita`}>
                  <ArrowRight size={15} />
                </button>
              </li>
            );
          })}
        </ol>
        <div className="tabs-edit-actions">
          <span className="hint">Arraste as abas ou use as setas.</span>
          <button className="btn btn-small btn-ghost" onClick={() => withTransition(() => props.onOrder(props.tabs.map((t) => t.key)), 'reorder')}>
            <RotateCcw size={15} aria-hidden /> Ordem padrão
          </button>
          <button className="btn btn-small btn-primary" onClick={() => setEditing(false)}>
            <Check size={15} aria-hidden /> Pronto
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="tabs-wrap">
      <nav className="views seg" role="tablist" aria-label="Visão" ref={ref}>
        {props.order.map((key) => {
          const t = byKey[key];
          return (
            <button key={key} role="tab" aria-selected={props.active === key} className={props.active === key ? 'on' : ''} style={{ viewTransitionName: `aba-${key}` }} onClick={() => props.onGo(key)}>
              <t.Icon size={16} strokeWidth={1.75} aria-hidden />
              {t.label}
              {props.badge(key)}
            </button>
          );
        })}
      </nav>
      <button className="btn btn-icon btn-ghost tabs-edit" onClick={() => setEditing(true)} aria-label="Personalizar a ordem das abas" title="Personalizar a ordem das abas">
        <Pencil size={16} strokeWidth={1.75} />
      </button>
    </div>
  );
}
