// Notificações no celular (Web Push). As chaves VAPID ficam em var/vapid.json; o
// conteúdo vai criptografado até o aparelho (o serviço de push do Google só repassa).
import webpush from 'web-push';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Store } from './db.ts';

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

interface StoredSub extends PushSubscriptionJSON {
  deviceId: string | null;
  createdAt: string;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

type Sender = (sub: PushSubscriptionJSON, payload: string) => Promise<unknown>;

export class Push {
  private store: Store;
  readonly publicKey: string;
  private send: Sender;

  constructor(store: Store, vapidPath: string, sender?: Sender) {
    this.store = store;
    let keys: { publicKey: string; privateKey: string };
    if (existsSync(vapidPath)) keys = JSON.parse(readFileSync(vapidPath, 'utf8'));
    else {
      keys = webpush.generateVAPIDKeys();
      mkdirSync(dirname(vapidPath), { recursive: true });
      writeFileSync(vapidPath, JSON.stringify(keys), { mode: 0o600 });
    }
    this.publicKey = keys.publicKey;
    webpush.setVapidDetails('mailto:emannu-os@example.invalid', keys.publicKey, keys.privateKey);
    this.send = sender ?? ((sub, payload) => webpush.sendNotification(sub, payload, { TTL: 6 * 3600 }));
  }

  private subs(): StoredSub[] {
    return this.store.kvGet<StoredSub[]>('push.subs') ?? [];
  }

  count(): number {
    return this.subs().length;
  }

  subscribe(sub: PushSubscriptionJSON, deviceId: string | null): void {
    if (!sub?.endpoint?.startsWith('https://') || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('Inscrição de notificação inválida');
    const rest = this.subs().filter((s) => s.endpoint !== sub.endpoint);
    this.store.kvSet('push.subs', [...rest, { endpoint: sub.endpoint, keys: sub.keys, deviceId, createdAt: new Date().toISOString() }]);
  }

  unsubscribe(endpoint: string): void {
    this.store.kvSet('push.subs', this.subs().filter((s) => s.endpoint !== endpoint));
  }

  // Remove inscrições de um aparelho revogado.
  forgetDevice(deviceId: string): void {
    this.store.kvSet('push.subs', this.subs().filter((s) => s.deviceId !== deviceId));
  }

  async notify(p: PushPayload): Promise<{ sent: number; removed: number }> {
    let sent = 0;
    const gone: string[] = [];
    await Promise.all(
      this.subs().map(async (s) => {
        try {
          await this.send({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(p));
          sent++;
        } catch (e: any) {
          // 404/410: o aparelho cancelou a inscrição.
          if (e?.statusCode === 404 || e?.statusCode === 410) gone.push(s.endpoint);
          else console.warn('Falha ao enviar notificação:', e?.statusCode ?? e?.message);
        }
      }),
    );
    if (gone.length) this.store.kvSet('push.subs', this.subs().filter((s) => !gone.includes(s.endpoint)));
    return { sent, removed: gone.length };
  }
}
