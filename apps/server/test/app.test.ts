import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { Scheduler } from '../src/scheduler.ts';
import { Auth } from '../src/auth.ts';
import { Push } from '../src/push.ts';
import { buildApp } from '../src/app.ts';
import { jobNotification, objectiveNotification, wireNotifications } from '../src/notifications.ts';
import type { Job, Objective } from '../../../packages/shared/types.ts';

const REMOTE = { 'x-forwarded-for': '100.101.102.103', 'tailscale-user-login': 'emmanuel@example.com' };

let dir: string;
let store: Store;
let sched: Scheduler;
let auth: Auth;
let push: Push;
let sent: { endpoint: string; payload: any }[];
let failWith: number | null;
let app: Awaited<ReturnType<typeof buildApp>>;
let clock: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'emannu-app-'));
  store = new Store(':memory:');
  sched = new Scheduler({ store, logDir: join(dir, 'logs'), worktreesDir: join(dir, 'wt'), resolveExe: () => null });
  clock = Date.parse('2026-10-27T12:00:00Z');
  auth = new Auth(store, join(dir, 'admin-token'), () => clock);
  sent = [];
  failWith = null;
  push = new Push(store, join(dir, 'vapid.json'), async (sub, payload) => {
    if (failWith) throw Object.assign(new Error('x'), { statusCode: failWith });
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
  });
  app = await buildApp({ sched, auth, push });
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const cookieOf = (res: any) => String(res.headers['set-cookie'] ?? '').split(';')[0];

describe('acesso por PIN e token de aparelho', () => {
  it('sem token a API recusa; status e health são públicos', async () => {
    expect((await app.inject({ url: '/api/jobs' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200);
    const st = (await app.inject({ url: '/api/auth/status' })).json();
    expect(st).toMatchObject({ configured: false, authenticated: false, local: true });
  });

  it('o PIN só pode ser definido no próprio PC, uma única vez', async () => {
    const remote = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: REMOTE, payload: { pin: '123456' } });
    expect(remote.statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { pin: '12' } })).statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { pin: '246810', deviceName: 'PC' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['set-cookie']).toMatch(/HttpOnly; SameSite=Strict/);
    expect((await app.inject({ url: '/api/jobs', headers: { cookie: cookieOf(ok) } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { pin: '111111' } })).statusCode).toBe(409);
  });

  it('celular entra com PIN pelo Tailscale e recebe cookie Secure', async () => {
    auth.setPin('246810');
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...REMOTE, 'x-forwarded-proto': 'https' }, payload: { pin: '246810', deviceName: 'Android' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toMatch(/; Secure/);
    const st = (await app.inject({ url: '/api/auth/status', headers: { ...REMOTE, cookie: cookieOf(res) } })).json();
    expect(st).toMatchObject({ authenticated: true, local: false, device: { name: 'Android' } });
  });

  it('5 PINs errados bloqueiam por 15 minutos', async () => {
    auth.setPin('246810');
    const login = (pin: string) => app.inject({ method: 'POST', url: '/api/auth/login', headers: REMOTE, payload: { pin } });
    for (let i = 0; i < 4; i++) expect((await login('000000')).statusCode).toBe(401);
    expect((await login('000000')).statusCode).toBe(429);
    expect((await login('246810')).statusCode).toBe(429); // nem o certo entra durante o bloqueio
    clock += 16 * 60_000;
    expect((await login('246810')).statusCode).toBe(200);
  });

  it('revogar um aparelho corta o acesso dele', async () => {
    auth.setPin('246810');
    const phone = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { pin: '246810', deviceName: 'Android' } });
    const pc = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { pin: '246810', deviceName: 'PC' } });
    const list = (await app.inject({ url: '/api/auth/devices', headers: { cookie: cookieOf(pc) } })).json();
    const android = list.find((d: any) => d.name === 'Android');
    expect(list.find((d: any) => d.name === 'PC').current).toBe(true);
    await app.inject({ method: 'DELETE', url: `/api/auth/devices/${android.id}`, headers: { cookie: cookieOf(pc) } });
    expect((await app.inject({ url: '/api/jobs', headers: { cookie: cookieOf(phone) } })).statusCode).toBe(401);
  });

  it('token local de administrador (scripts no PC)', async () => {
    expect((await app.inject({ url: '/api/jobs', headers: { 'x-emannu-token': auth.adminToken } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/jobs', headers: { 'x-emannu-token': 'x'.repeat(64) } })).statusCode).toBe(401);
  });
});

describe('notificações', () => {
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p', auth: 'a' } };

  it('inscreve, envia e remove inscrição expirada', async () => {
    const admin = { 'x-emannu-token': auth.adminToken };
    expect((await app.inject({ url: '/api/push/key', headers: admin })).json().publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect((await app.inject({ method: 'POST', url: '/api/push/subscribe', headers: admin, payload: { endpoint: 'http://inseguro' } })).statusCode).toBe(400);
    await app.inject({ method: 'POST', url: '/api/push/subscribe', headers: admin, payload: sub });
    const r = (await app.inject({ method: 'POST', url: '/api/push/test', headers: admin })).json();
    expect(r).toEqual({ sent: 1, removed: 0 });
    expect(sent[0].payload.title).toBe('EMANNU OS');
    failWith = 410;
    expect(await push.notify({ title: 't', body: 'b', url: '/', tag: 'x' })).toEqual({ sent: 0, removed: 1 });
    expect(push.count()).toBe(0);
  });

  const job = (patch: Partial<Job>): Job => ({ id: 'j1', title: 'Tarefa', kind: 'task', status: 'running', objectiveId: null, step: null, error: null, ...patch }) as Job;

  it('só avisa o que importa', () => {
    expect(jobNotification(job({ status: 'review', step: 'Aguardando revisão do merge' }), 'running')?.title).toBe('Aguardando você');
    expect(jobNotification(job({ status: 'approval' }), undefined)?.title).toMatch(/aprovar início/);
    expect(jobNotification(job({ status: 'failed', error: 'boom' }), 'running')?.body).toContain('boom');
    expect(jobNotification(job({ status: 'done' }), 'running')?.title).toBe('Job concluído');
    expect(jobNotification(job({ status: 'done', objectiveId: 'o1' }), 'reviewing')).toBeNull();
    expect(jobNotification(job({ status: 'running' }), 'queued')).toBeNull();
    expect(jobNotification(job({ kind: 'review', status: 'done' }), 'running')).toBeNull();
    const o = { id: 'o1', title: 'Mapa', status: 'plan_ready' } as Objective;
    expect(objectiveNotification(o, 'planning')?.url).toBe('/?objetivo=o1');
    expect(objectiveNotification({ ...o, status: 'running' }, 'plan_ready')).toBeNull();
  });

  it('liga eventos do agendador sem repetir avisos', () => {
    const got: string[] = [];
    wireNotifications(sched, (p) => got.push(p.title));
    const j = job({ status: 'review' });
    sched.emit('job', j);
    sched.emit('job', j);
    sched.emit('notify', { kind: 'paused', agent: 'claude' });
    expect(got).toEqual(['Aguardando você', 'Fila do Claude pausada']);
  });
});
