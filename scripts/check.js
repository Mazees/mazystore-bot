import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(e => e.isDirectory() ? files(`${dir}/${e.name}`) : e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []))).flat();
}
let failed = false;
for (const path of (await Promise.all(['src', 'worker', 'scripts', 'test'].map(files))).flat()) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  if (result.status !== 0) { failed = true; console.error(result.stderr); }
}
if (failed) process.exitCode = 1;
else console.log('Syntax JavaScript valid.');

