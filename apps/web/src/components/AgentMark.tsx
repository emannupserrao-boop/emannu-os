import { useState } from 'react';
import type { AgentId } from '../../../../packages/shared/types.ts';

// Para usar os logos oficiais, coloque apps/web/public/agents/<id>.png
// (claude.png, codex.png, rocky.png...). Sem arquivo, aparece a marca simples.
const FALLBACK: Record<AgentId, { letter: string; bg: string; fg: string }> = {
  claude: { letter: 'C', bg: '#d97757', fg: '#1a1208' },
  codex: { letter: 'X', bg: '#eceef2', fg: '#111214' },
  rocky: { letter: 'R', bg: 'linear-gradient(135deg,#3b82f6 0 55%,#e5484d 55%)', fg: '#ffffff' },
  hermes: { letter: 'H', bg: 'linear-gradient(135deg,#2b2545,#1a1726)', fg: '#c9b8ff' },
  openclaw: { letter: 'O', bg: 'linear-gradient(135deg,#46201c,#221212)', fg: '#ff9f86' },
};

// Lembra quais logos não existem, para não tentar carregar de novo em cada card.
const missing = new Set<AgentId>();

export function AgentMark({ id, size = 32 }: { id: AgentId; size?: number }) {
  const [failed, setFailed] = useState(missing.has(id));
  const f = FALLBACK[id];
  if (!failed) {
    return (
      <img
        className="agent-mark"
        src={`/agents/${id}.png`}
        alt=""
        width={size}
        height={size}
        onError={() => {
          missing.add(id);
          setFailed(true);
        }}
      />
    );
  }
  return (
    <span className="agent-mark" aria-hidden style={{ width: size, height: size, background: f.bg, color: f.fg, fontSize: size * 0.48 }}>
      {f.letter}
    </span>
  );
}
