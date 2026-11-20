import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { BufferJSON } from 'baileys';
import { LocalStore } from '../src/local-store.js';
import { sqliteAuth } from '../src/auth.js';
import { Transport } from '../src/transport.js';
import { createApp } from '../src/server.js';
import { collectImage } from '../src/media.js';
import { validateQris, generateDynamicQris } from '../src/qris.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mazy-test-'));
  const key = randomBytes(32).toString('hex');
  const store = new LocalStore(dir,key,BufferJSON);
  return { dir, key, store, cleanup() { store.close(); rmSync(dir,{recursive:true,force:true}); } };
}

test('SQLite auth roundtrip preserves buffers and encrypts sensitive content', async () => {
  const f = fixture();
  try {
    const auth = sqliteAuth(f.store);
    auth.saveCreds();
    await auth.state.keys.set({ session: { test: Buffer.from('secret-otp-123456') } });
    const saved = await sqliteAuth(f.store).state.keys.get('session',['test']);
    assert.equal(saved.test.toString(),'secret-otp-123456');
    const raw = f.store.db.prepare('SELECT value FROM auth WHERE key=?').get('session:test');
    assert.ok(!raw.value.includes('secret-otp'));
    f.store.db.prepare('UPDATE auth SET value=? WHERE key=?').run(raw.value.slice(0,-8) + 'AAAAAAAA','session:test');
    assert.throws(()=>f.store.authGet('session:test'));
  } finally { f.cleanup(); }
});

test('outbox does not resend after mapping failure and requires explicit retry for uncertain delivery', async () => {
  const f = fixture();
  try {
    let sent = 0;
    let mapFails = true;
    const transport = new Transport(f.store,{async map() { if(mapFails) throw new Error('D1 down'); }},{});
    transport.attach({async sendMessage() { sent++; return {key:{id:'out-1'},message:{conversation:'otp'}}; }});
    await transport.text('62812345678@s.whatsapp.net','OTP 123456','event-1',{buyer:'62811111111@s.whatsapp.net',role:'admin'});
    await transport.drain();
    assert.equal(sent,1);
    assert.equal(f.store.next().status,'mapping');
    mapFails = false;
    await transport.drain();
    assert.equal(sent,1);
    assert.equal(f.store.next(),null);
    transport.attach({async sendMessage() { throw new Error('uncertain'); }});
    await transport.text('62812345678@s.whatsapp.net','test','event-2');
    await transport.drain();
    assert.equal(f.store.uncertain().length,1);
    assert.ok(f.store.retry(f.store.uncertain()[0].id));
    assert.equal(f.store.next().status,'pending');
  } finally { f.cleanup(); }
});

test('restart marks in-flight send uncertain and TTL removes transient text', () => {
  const f = fixture();
  let reopened;
  try {
    f.store.enqueue('job','62812345678@s.whatsapp.net',{text:'secret'});
    f.store.setStatus('job','sending');
    f.store.close();
    reopened = new LocalStore(f.dir,f.key,BufferJSON);
    assert.equal(reopened.uncertain().length,1);
    reopened.db.prepare('UPDATE outbox SET created=0').run();
    reopened.cleanup();
    assert.equal(reopened.uncertain().length,0);
  } finally { reopened?.close(); rmSync(f.dir,{recursive:true,force:true}); }
});

test('media streaming enforces actual byte limit', async () => {
  assert.equal((await collectImage(Readable.from([Buffer.from('12'),Buffer.from('34')]),4)).toString(),'1234');
  await assert.rejects(()=>collectImage(Readable.from([Buffer.from('12345')]),4),/terlalu besar/);
});

test('Express exposes health and readiness, without exposing configuration', async () => {
  const status = { whatsapp:false,database:false,stopping:false };
  const server = createApp(status).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${url}/healthz`)).status,200);
    assert.equal((await fetch(`${url}/readyz`)).status,503);
    status.whatsapp = status.database = true;
    assert.equal((await fetch(`${url}/readyz`)).status,200);
    assert.equal((await fetch(`${url}/.env`)).status,404);
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});

test('attached merchant QRIS validates and accepts exact order amount', () => {
  const base = readFileSync(new URL('../config/qris.txt',import.meta.url),'utf8').trim();
  const merchant = validateQris(base,'MZ STORE').merchant;
  const result = validateQris(generateDynamicQris(base,270000,'MZ STORE'));
  assert.equal(result.merchant,merchant);
  assert.equal(result.fields.find(f=>f.tag==='54').value,'270000');
});
