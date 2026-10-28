// Worker do teste routine_claim_concurrent: abre o MESMO banco (outra conexão, outra
// thread) e tenta reservar a mesma execução ao mesmo tempo que os outros.
import { parentPort, workerData } from 'node:worker_threads';

const { Store } = await import('../src/db.ts');
const { RoutineStore } = await import('../src/routines.ts');
const store = new Store(workerData.db);
const rs = new RoutineStore(store);
const gate = new Int32Array(workerData.gate);
Atomics.add(gate, 1, 1);
Atomics.wait(gate, 0, 0);
const r = rs.claim('rotina-teste', 'projeto-x', '2026-10-28', () =>
  store.createJob({ title: 'job da rotina', prompt: 'x', agent: 'claude', projectId: 'p', risk: 'verde', status: 'queued', timeoutMin: 5, kind: 'research', planKey: 'historico:x' }),
);
parentPort.postMessage({ created: r.created, jobId: r.job?.id ?? null });
