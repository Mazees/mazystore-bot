import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
const env = template.replace('replace-with-random-secret-at-least-32-characters', randomBytes(32).toString('hex')).replace('replace-with-64-hex-characters', randomBytes(32).toString('hex'));
try {
  await writeFile(new URL('../.env', import.meta.url), env, { flag: 'wx', mode: 0o600 });
  console.log('.env dibuat dengan secret acak. Isi ADMIN_NUMBER, WORKER_URL, dan PORT. Jangan bagikan .env.');
} catch (error) {
  if (error.code === 'EEXIST') console.log('.env sudah ada; tidak ditimpa.');
  else throw error;
}
