// Esqueceu o PIN? Apaga o PIN e todos os aparelhos registrados. Depois, abra o
// EMANNU OS no PC para criar um PIN novo; cada celular entra de novo.
// Uso (com o EMANNU OS fechado): node --disable-warning=ExperimentalWarning scripts/redefinir-pin.mjs
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const db = join(resolve(import.meta.dirname, '..'), 'var', 'emannu.db');
if (!existsSync(db)) {
  console.log('Banco não encontrado:', db);
  process.exit(1);
}
const d = new DatabaseSync(db);
d.prepare("DELETE FROM kv WHERE key IN ('auth.pin', 'auth.devices', 'push.subs')").run();
console.log('PIN e aparelhos apagados. Abra o EMANNU OS no PC para criar um PIN novo.');
