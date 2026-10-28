import { useState } from 'react';
import { authApi } from '../api.ts';

export function guessDeviceName(): string {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'Celular Android';
  if (/iPhone|iPad/i.test(ua)) return 'iPhone';
  return 'PC';
}

// mode: setup = definir o PIN (só no PC); login = entrar com o PIN; remote-setup = PIN ainda não definido.
export function Login(props: { mode: 'setup' | 'login' | 'remote-setup'; onDone(): void }) {
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [name, setName] = useState(guessDeviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (props.mode === 'setup' && pin !== pin2) return setError('Os dois PINs não são iguais.');
    setBusy(true);
    try {
      if (props.mode === 'setup') await authApi.setup(pin, name);
      else await authApi.login(pin, name);
      props.onDone();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-card">
        <div className="brand">
          <span className="brand-mark">E</span>
          <div className="brand-name">EMANNU OS</div>
        </div>
        {props.mode === 'remote-setup' ? (
          <>
            <h1>Falta definir o PIN</h1>
            <p>Por segurança, o PIN é criado no próprio PC. Abra o EMANNU OS no PC (Iniciar EMANNU OS.cmd) e defina o PIN; depois volte aqui.</p>
            <button className="btn btn-primary" onClick={props.onDone}>
              Tentar de novo
            </button>
          </>
        ) : (
          <form onSubmit={submit}>
            <h1>{props.mode === 'setup' ? 'Crie o PIN de acesso' : 'Entrar'}</h1>
            <p className="hint">
              {props.mode === 'setup'
                ? 'O PIN protege o acesso pelo celular. Use de 6 a 12 números. Cada aparelho entra uma vez e fica lembrado.'
                : 'Digite o PIN definido no PC. Este aparelho fica lembrado até você sair ou revogar.'}
            </p>
            <label className="field">
              <span>PIN</span>
              <input type="password" inputMode="numeric" autoComplete="current-password" pattern="\d{6,12}" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} required autoFocus />
            </label>
            {props.mode === 'setup' && (
              <label className="field">
                <span>Repita o PIN</span>
                <input type="password" inputMode="numeric" autoComplete="new-password" pattern="\d{6,12}" value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))} required />
              </label>
            )}
            <label className="field">
              <span>Nome deste aparelho</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
            </label>
            {error && <p className="job-error">{error}</p>}
            <button type="submit" className="btn btn-primary login-submit" disabled={busy || pin.length < 6}>
              {busy ? 'Entrando…' : props.mode === 'setup' ? 'Criar PIN e entrar' : 'Entrar'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
