import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { StoreBot } from '../src/bot.js';

const secret = 'test-api-secret-with-more-than-32-characters';
let mf;
let db;
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'mazy-test', modules: true, script: await readFile(new URL('../worker/index.js', import.meta.url), 'utf8'), compatibilityDate: '2026-11-20', bindings: { API_SECRET: secret }, d1Databases: ['DB'] }));
  db = await mf.getD1Database('DB');
  const migration = await readFile(new URL('../worker/migrations/0001_init.sql', import.meta.url), 'utf8');
  for (const statement of migration.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
});
after(async () => { await mf?.dispose(); });

async function request(path, method = 'GET', body, authorized = true) {
  const response = await mf.dispatchFetch(`http://localhost/v1${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: `Bearer ${secret}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { status: response.status, data };
}
const buyer = n => `62812345${String(n).padStart(3,'0')}@s.whatsapp.net`;
const action = (id, name, key, actor = 'admin', reason = '') => request(`/orders/${id}/actions`, 'POST', { action: name, key, actor, reason });
const create = (n, key, quantity = 2) => request('/orders', 'POST', { key, buyer: buyer(n), variantId: 'gpt-plus-private', quantity, expectedPrice: 90000, expectedTerms: 'Durasi 1 bulan. Ketentuan layanan perlu dilengkapi admin sebelum dibuka.', qrisVersion: 'test-qris' });

test('API is private and seeded catalog is closed', async () => {
  assert.equal((await request('/catalog', 'GET', undefined, false)).status, 401);
  const catalog = (await request('/catalog')).data;
  assert.equal(catalog.categories.length, 7);
  assert.ok(catalog.variants.every(v => v.ready === 0));
  assert.equal((await create(1, 'closed')).status, 409);
  assert.equal((await request('/variants', 'POST', { mode: 'ready', id: 'gpt-plus-private', ready: true })).status, 200);
});

test('server calculates total, rejects invalid quantity and enforces one active order', async () => {
  for (const qty of [0, -1, 1.5, 101, '2']) assert.equal((await create(2, `bad-${qty}`, qty)).status, 400);
  const { data: order } = await create(2, 'order-2');
  assert.equal(order.total, 180000);
  assert.equal((await create(2, 'order-2')).data.id, order.id);
  assert.equal((await create(2, 'another-2')).status, 409);
  const races = await Promise.all([create(3, 'race-a'), create(3, 'race-b')]);
  assert.deepEqual(races.map(r => r.status).sort(), [200,409]);
});

test('done is not paid; proof review, approval and refund transitions are guarded', async () => {
  const { data: o } = await create(4, 'flow-4');
  assert.equal((await action(o.id, 'approve','early')).status, 409);
  assert.equal((await action(o.id, 'done','done-4', buyer(4))).data.status, 'awaiting_proof');
  assert.equal((await action(o.id, 'done','done-4', buyer(4))).status, 200);
  assert.equal((await action(o.id, 'submit_proof','proof-4', buyer(4))).data.status, 'review');
  assert.equal((await action(o.id, 'approve','fake-admin', buyer(4))).status, 403);
  assert.equal((await action(o.id, 'approve','approve-4')).data.status, 'processing');
  assert.equal((await action(o.id, 'approve','approve-4')).status, 200);
  assert.equal((await action(o.id, 'cancel','cancel-paid', buyer(4))).status, 409);
  assert.equal((await action(o.id, 'refund','refund-no-reason')).status, 400);
  assert.equal((await action(o.id, 'refund','refund-4','admin','Seller tidak tersedia')).data.status, 'refund_pending');
  assert.equal((await action(o.id, 'refund_complete','refunded-4')).data.status, 'refunded');
  assert.equal((await create(4, 'next-4')).status, 200);
});

test('payment and price edits preserve snapshots; cancellation request blocks approval', async () => {
  const { data: o } = await create(5, 'flow-5');
  await action(o.id,'done','done-5',buyer(5));
  await action(o.id,'submit_proof','proof-5',buyer(5));
  await action(o.id,'request_cancel','cancel-request-5',buyer(5));
  assert.equal((await action(o.id,'approve','blocked-5')).status,409);
  await action(o.id,'clear_cancel','clear-5');
  assert.equal((await action(o.id,'approve','approve-5')).status,200);
  await request('/variants','POST',{id:'gpt-plus-private',mode:'price',price:95000});
  assert.equal((await request(`/orders/${o.id}`)).data.total,180000);
  assert.equal((await create(6,'stale-price')).status,409);
  await request('/variants','POST',{id:'gpt-plus-private',mode:'price',price:90000});
});

test('message references are isolated by chat and preserve buyer ownership', async () => {
  const { data: o } = await create(7,'refs-7');
  const admin = buyer(999);
  assert.equal((await request('/messages','POST',{jid:admin,waId:'proof-id',buyer:buyer(7),orderId:o.id,role:'buyer'})).status,200);
  assert.equal((await request(`/messages/proof-id?jid=${encodeURIComponent(admin)}`)).data.buyer,buyer(7));
  assert.equal((await request(`/messages/proof-id?jid=${encodeURIComponent(buyer(8))}`)).status,404);
  assert.equal((await request('/messages','POST',{jid:admin,waId:'wrong-owner',buyer:buyer(8),orderId:o.id,role:'buyer'})).status,400);
});

test('bot flow: quantity, /done then image, admin quote routing and chat OTP', async () => {
  const calls = [];
  const api = {
    async call(path, method, body) { const result = await request(path,method,body); if (result.status >= 400) { const e = new Error(result.data.error); e.status = result.status; throw e; } return result.data; },
    catalog() { return this.call('/catalog'); },
    customer(id) { return this.call(`/customers/${encodeURIComponent(id)}`); },
    session(id,s) { return this.call(`/customers/${encodeURIComponent(id)}/session`,'PUT',s); },
    createOrder(data) { return this.call('/orders','POST',data); },
    order(id) { return this.call(`/orders/${id}`); },
    action(id,data) { return this.call(`/orders/${id}/actions`,'POST',data); },
    message(jid,id) { return this.call(`/messages/${id}?jid=${encodeURIComponent(jid)}`); },
  };
  const adminJid = buyer(900);
  const transport = {
    async text(jid,text,id,context) { calls.push({kind:'text',jid,text,id,context}); },
    async payment(jid,order) { calls.push({kind:'payment',jid,order}); },
    async image(jid,buffer,caption,context) {
      calls.push({kind:'image',jid,buffer,caption,context});
      await request('/messages','POST',{...context,jid,waId:'proof-bot'});
    },
  };
  const bot = new StoreBot(api,transport,{adminJid,maxQuantity:100,qris:'test-payload'},{});
  let sequence = 0;
  const send = (text, extra={}) => bot.handle({jid:buyer(100),buyer:buyer(100),id:`bot-${++sequence}`,text,...extra});
  await send('/menu'); await send('6');
  // Variants are ordered by id: private then sharing.
  await send('1'); await send('2'); await send('1');
  const order = (await api.customer(buyer(100))).order;
  assert.equal(order.quantity,2);
  assert.equal(order.total,180000);
  assert.ok(calls.some(c=>c.kind==='payment'));
  await send('',{image:async()=>Buffer.from('image')});
  assert.ok(calls.at(-1).text.includes('/done'));
  await send('/done');
  assert.equal((await api.customer(buyer(100))).order.status,'awaiting_proof');
  await send('',{image:async()=>Buffer.from('image')});
  assert.equal((await api.customer(buyer(100))).order.status,'review');
  assert.equal(calls.find(c=>c.kind==='image').jid,adminJid);
  await bot.handle({jid:adminJid,buyer:adminJid,id:'admin-reply',text:'Kirim OTP',quotedId:'proof-bot'});
  assert.equal(calls.at(-1).jid,buyer(100));
  // Replying to the admin notification activates chat without requiring /chat.
  await send('123456');
  assert.equal(calls.at(-1).jid,adminJid);
  assert.ok(calls.at(-1).text.includes('123456'));
  assert.equal(calls.at(-1).context.orderId,order.id);
  await bot.handle({jid:adminJid,buyer:adminJid,id:'admin-reject',text:`/tolakbukti ${order.id} Bukti kurang jelas`});
  assert.equal((await api.customer(buyer(100))).session.chat,false);
  await send('',{image:async()=>Buffer.from('new-proof')});
  assert.equal((await api.customer(buyer(100))).order.status,'review');
  await bot.handle({jid:adminJid,buyer:adminJid,id:'admin-approve',text:`/setujui ${order.id}`});
  assert.equal((await api.customer(buyer(100))).order.status,'processing');
  assert.equal((await api.customer(buyer(100))).session.chat,true);
  await bot.handle({jid:adminJid,buyer:adminJid,id:'admin-complete',text:`/selesai ${order.id}`});
  await send('Perlu bantuan login lagi');
  assert.equal(calls.at(-1).context.orderId,order.id);
  await send('/menu');
  assert.ok(!((await api.customer(buyer(100))).session.chat));
});
