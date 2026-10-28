import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { Login } from './components/Login.tsx';
import { UNAUTH_EVENT, authApi, hasSnapshot } from './api.ts';
import '@fontsource-variable/inter';
import './styles.css';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

type Gate = 'loading' | 'setup' | 'remote-setup' | 'login' | 'ok' | 'offline' | 'unreachable';

function Root() {
  const [gate, setGate] = useState<Gate>('loading');

  const check = useCallback(async () => {
    try {
      const s = await authApi.status();
      if (!s.configured) setGate(s.local ? 'setup' : 'remote-setup');
      else setGate(s.authenticated ? 'ok' : 'login');
    } catch {
      // PC fora do ar: abre com o último retrato salvo, se houver.
      setGate(hasSnapshot() ? 'offline' : 'unreachable');
    }
  }, []);

  useEffect(() => {
    check();
    const onUnauth = () => setGate('login');
    window.addEventListener(UNAUTH_EVENT, onUnauth);
    return () => window.removeEventListener(UNAUTH_EVENT, onUnauth);
  }, [check]);

  // Sem conexão: tenta de novo a cada 10 s até o PC voltar.
  useEffect(() => {
    if (gate !== 'offline' && gate !== 'unreachable') return;
    const t = setInterval(check, 10_000);
    return () => clearInterval(t);
  }, [gate, check]);

  if (gate === 'loading') return <p className="empty center-msg">Conectando ao PC…</p>;
  if (gate === 'setup' || gate === 'login' || gate === 'remote-setup') return <Login mode={gate} onDone={check} />;
  if (gate === 'unreachable')
    return (
      <div className="login">
        <div className="login-card">
          <h1>Sem conexão com o PC</h1>
          <p>O PC pode estar desligado ou dormindo, ou o Tailscale está desligado neste aparelho. Tentando de novo a cada 10 segundos…</p>
          <button className="btn btn-primary" onClick={check}>
            Tentar agora
          </button>
        </div>
      </div>
    );
  return <App onLoggedOut={() => setGate('login')} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
