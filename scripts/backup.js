import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { DatabaseSync, backup } from 'node:sqlite';

if (!/^[a-f\d]{64}$/i.test(process.env.DATA_KEY || '')) throw new Error('DATA_KEY diperlukan. Jalankan dengan --env-file=.env.');
const store = new DatabaseSync(resolve(process.env.DATA_DIR || 'data', 'bot.sqlite'), { readOnly: true });
const output = resolve(process.env.DATA_DIR || 'data', `session-${Date.now()}-${randomBytes(4).toString('hex')}.backup`);
await backup(store, output);
try { chmodSync(output, 0o600); } catch { /* Windows uses inherited ACLs. */ }
store.close();
console.log(`Backup dibuat: ${output}. Unduh ke perangkat lain lalu hapus salinan hosting. Simpan DATA_KEY secara terpisah.`);
