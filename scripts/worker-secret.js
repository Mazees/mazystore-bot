import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

if (!process.env.API_SECRET || process.env.API_SECRET.length < 32) throw new Error('API_SECRET di .env belum valid.');
const child = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'secret', 'put', 'API_SECRET', '--config', 'worker/wrangler.local.jsonc'], { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.end(process.env.API_SECRET + '\n');
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
