import type { SistemaView } from '../../../../packages/shared/types.ts';
import { api, rendaApi } from '../api.ts';
import { useEffect, useState } from 'react';
import { authApi, clearSnapshot, formatTime, pushApi, type Device } from '../api.ts';
import { X } from 'lucide-react';

// Evento de instalação do PWA (Chrome/Android), guardado para o botão "Instalar".
let installPrompt: any = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
});

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function pushSupport(): string | null {
  if (!window.isSecureContext) return 'Notificações precisam de HTTPS: abra o app pelo endereço do Tailscale (https://…ts.net).';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'Este navegador não aceita notificações. No Android, use o Chrome.';
  return null;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export function Aparelhos(props: { sistema?: SistemaView | null; onClose(): void; onError(m: string): void; onLoggedOut(): void; confirm(message: string, run: () => Promise<unknown>): void }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [permission, setPermission] = useState<string>(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  const [busy, setBusy] = useState(false);
  const [canInstall, setCanInstall] = useState(!!installPrompt);
  const [pinAtual, setPinAtual] = useState('');
  const [pinNovo, setPinNovo] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const support = pushSupport();
  const standalone = window.matchMedia('(display-mode: standalone)').matches;

  const load = () => authApi.devices().then(setDevices).catch((e) => props.onError(e.message));
  useEffect(() => {
    load();
    if (!support) currentSubscription().then((s) => setSubscribed(!!s)).catch(() => setSubscribed(false));
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', onKey);
    const onPrompt = () => setCanInstall(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeinstallprompt', onPrompt);
    };
  }, []);

  const enablePush = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') throw new Error('Permissão de notificação negada. Libere em Configurações do Android → Apps → Chrome/EMANNU OS → Notificações.');
      const { publicKey } = await pushApi.key();
      if (!publicKey) throw new Error('O PC não tem notificações configuradas.');
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource }));
      await pushApi.subscribe(sub.toJSON() as PushSubscriptionJSON);
      setSubscribed(true);
      setMsg('Notificações ativadas neste aparelho.');
    } catch (e: any) {
      props.onError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const disablePush = async () => {
    const sub = await currentSubscription();
    if (sub) {
      await pushApi.unsubscribe(sub.endpoint).catch(() => {});
      await sub.unsubscribe();
    }
    setSubscribed(false);
  };

  const test = async () => {
    try {
      const r = await pushApi.test();
      setMsg(r.sent ? `Enviada para ${r.sent} aparelho(s). Deve chegar em alguns segundos.` : 'Nenhum aparelho com notificações ativas.');
    } catch (e: any) {
      props.onError(e.message);
    }
  };

  const changePin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await authApi.changePin(pinAtual, pinNovo);
      setPinAtual('');
      setPinNovo('');
      setMsg('PIN trocado. Os aparelhos já registrados continuam com acesso.');
    } catch (err: any) {
      props.onError(err.message);
    }
  };

  return (
    <div className="drawer-backdrop" onClick={props.onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Celular e notificações" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div className="drawer-title">
            <h2>Celular e notificações</h2>
          </div>
          <button className="btn btn-icon btn-ghost" onClick={props.onClose} aria-label="Fechar">
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>
        <div className="drawer-body">
          {msg && <p className="alert">{msg}</p>}

          <section>
            <h4>Instalar como app</h4>
            {standalone ? (
              <p>✓ Você já está usando o app instalado.</p>
            ) : canInstall ? (
              <button
                className="btn btn-primary"
                onClick={async () => {
                  installPrompt?.prompt();
                  await installPrompt?.userChoice;
                  installPrompt = null;
                  setCanInstall(false);
                }}
              >
                Instalar EMANNU OS
              </button>
            ) : (
              <p className="hint">No Chrome do Android: menu ⋮ → “Adicionar à tela inicial” (ou “Instalar app”).</p>
            )}
          </section>

          <section>
            <h4>Notificações</h4>
            {support ? (
              <p className="hint">{support}</p>
            ) : (
              <>
                <p>
                  {subscribed ? '✓ Ativas neste aparelho.' : 'Desativadas neste aparelho.'} <span className="hint">(permissão: {permission})</span>
                </p>
                <p className="hint">Avisa: “Aguardando você”, job concluído/falhou, plano ou entrega prontos e fila pausada por limite de uso.</p>
                <div className="job-actions flat">
                  {subscribed ? (
                    <button className="btn" onClick={disablePush}>
                      Desativar
                    </button>
                  ) : (
                    <button className="btn btn-primary" disabled={busy} onClick={enablePush}>
                      {busy ? 'Ativando…' : 'Ativar notificações'}
                    </button>
                  )}
                  <button className="btn" onClick={test}>
                    Enviar notificação de teste
                  </button>
                </div>
              </>
            )}
          </section>

          <section>
            <h4>Aparelhos com acesso</h4>
            {devices.map((d) => (
              <div key={d.id} className="row">
                <span>
                  <b>{d.name}</b>
                  {d.current ? ' (este)' : ''}
                  <br />
                  <span className="hint">visto {formatTime(d.lastSeen)}</span>
                </span>
                {d.current ? (
                  <button
                    className="btn btn-small"
                    onClick={() =>
                      props.confirm('Sair deste aparelho? Vai precisar do PIN para entrar de novo.', async () => {
                        await disablePush().catch(() => {});
                        await authApi.logout();
                        clearSnapshot();
                        props.onLoggedOut();
                      })
                    }
                  >
                    Sair
                  </button>
                ) : (
                  <button className="btn btn-small btn-danger" onClick={() => props.confirm(`Revogar o acesso de "${d.name}"?`, () => authApi.revoke(d.id).then(load))}>
                    Revogar
                  </button>
                )}
              </div>
            ))}
          </section>

          <SlackSection onError={props.onError} />

          <section>
            <h4>Modo jogo</h4>
            <p className="hint">
              Quando você joga no PC, renders, modelo local e instalações pesadas esperam. Pesquisas e textos na nuvem continuam. {props.sistema?.modoJogo.ativo ? `Agora: ${props.sistema.modoJogo.motivo}.` : 'Agora: sem jogo detectado.'}
            </p>
            <label className="check">
              <input
                type="checkbox"
                checked={!!props.sistema?.modoJogo.pausarTudo}
                onChange={(e) => rendaApi.setPauseAll(e.target.checked).catch((err) => props.onError(err.message))}
              />{' '}
              Pausar tudo durante o jogo (silêncio total)
            </label>
          </section>

          <section>
            <h4>Trocar o PIN</h4>
            <form className="formgrid" onSubmit={changePin}>
              <label className="field">
                <span>PIN atual</span>
                <input type="password" inputMode="numeric" value={pinAtual} onChange={(e) => setPinAtual(e.target.value.replace(/\D/g, ''))} />
              </label>
              <label className="field">
                <span>PIN novo (6 a 12 números)</span>
                <input type="password" inputMode="numeric" value={pinNovo} onChange={(e) => setPinNovo(e.target.value.replace(/\D/g, ''))} />
              </label>
              <button className="btn" type="submit" disabled={pinAtual.length < 6 || pinNovo.length < 6}>
                Trocar PIN
              </button>
            </form>
          </section>
        </div>
      </aside>
    </div>
  );
}

// ⚙ → Integrações: ponte para o Rocky (dot do ChatGPT) pelo Slack. Experimental.
function SlackSection(props: { onError(m: string): void }) {
  const [st, setSt] = useState<{ configurada: boolean; canal: string | null; estado: string; motivo: string | null } | null>(null);
  const [token, setToken] = useState('');
  const [canal, setCanal] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api<any>('/api/integracoes/slack').then(setSt).catch(() => {});
  useEffect(() => {
    load();
  }, []);
  const human = async (method: string, body?: unknown) => {
    const { id } = await api<{ id: string }>('/api/confirmacoes', { acao: 'integracao:slack', alvo: 'slack' });
    return api('/api/integracoes/slack', body ?? {}, method, { 'X-Emannu-Confirm': id });
  };
  const LABEL: Record<string, string> = { nao_configurada: 'não configurada', nao_testada: 'configurada, falta testar', ativa: 'ativa', abandonada: 'abandonada (o Rocky não respondeu à integração)' };
  return (
    <section>
      <h4>Integrações: Rocky pelo Slack (experimental)</h4>
      <p className="hint">
        Para falar com o seu dot Rocky no Chat: crie um Slack pessoal, conecte o Rocky a ele pelo ChatGPT, crie o canal privado #rocky (só vocês dois) e um app do Slack seu. Cole aqui o token do app e o ID do canal. O token fica só neste PC, fora do git e do vault.
      </p>
      <p className="hint">Estado: {st ? (LABEL[st.estado] ?? st.estado) : '…'}{st?.motivo ? ` — ${st.motivo}` : ''}</p>
      <div className="formgrid">
        <label className="field">
          <span>Token (xoxp-… ou xoxb-…)</span>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
        </label>
        <label className="field">
          <span>ID do canal #rocky</span>
          <input value={canal} onChange={(e) => setCanal(e.target.value)} placeholder="C0123ABCD" />
        </label>
        <button
          className="btn"
          disabled={!token || !canal || busy}
          onClick={() => {
            setBusy(true);
            human('PUT', { token, canal })
              .then(() => {
                setToken('');
                load();
              })
              .catch((e) => props.onError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          Salvar
        </button>
        {st?.configurada && (
          <button
            className="btn"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              api('/api/integracoes/slack/testar', {})
                .then(load)
                .catch((e) => props.onError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? 'Testando (até 3 min)…' : 'Testar a ponte'}
          </button>
        )}
      </div>
    </section>
  );
}

