import { claimDestination } from '../src/contact.js';
import { verifyClaimLink } from '../src/claim-link.js';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const text = (value, max = 2000) => typeof value === 'string' && value.length > 0 && value.length <= max;
const isBuyer = value => text(value, 100) && /^\d+@(s\.whatsapp\.net|lid)$/.test(value);
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const sql = (db, query, ...args) => db.prepare(query).bind(...args);

async function customer(db, buyer) {
  if (!isBuyer(buyer)) fail(400, 'Identitas buyer tidak valid.');
  const conversation = `C${(await hash(buyer)).slice(0, 16).toUpperCase()}`;
  await sql(db, 'INSERT OR IGNORE INTO customers(buyer,conversation_id) VALUES (?,?)', buyer, conversation).run();
  const row = await sql(db, 'SELECT * FROM customers WHERE buyer=?', buyer).first();
  const order = await sql(db, "SELECT * FROM orders WHERE buyer=? AND status NOT IN ('completed','cancelled','refunded')", buyer).first();
  return { ...row, session: JSON.parse(row.session), order };
}

async function bodyOf(request) {
  const raw = await request.text();
  if (raw.length > 16000) fail(413, 'Permintaan terlalu besar.');
  let body;
  try { body = JSON.parse(raw); } catch { fail(400, 'JSON tidak valid.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Body harus berupa object JSON.');
  return body;
}

async function route(request, env) {
  if (!env.API_SECRET || env.API_SECRET.length < 32) fail(503, 'API belum dikonfigurasi.');
  const token = request.headers.get('Authorization') ?? '';
  const a = await hash(token);
  const b = await hash(`Bearer ${env.API_SECRET}`);
  if (a !== b) fail(401, 'Tidak diizinkan.');
  const url = new URL(request.url);
  const path = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const db = env.DB;
  const method = request.method;
  if (path[0] !== 'v1') fail(404, 'Endpoint tidak ditemukan.');
  const [, resource, id, sub] = path;
  if (resource === 'admin' && method === 'GET') {
    if (id === 'recipients') {
      const after = url.searchParams.get('after') || '';
      if (after && !isBuyer(after)) fail(400, 'Cursor penerima tidak valid.');
      const rows = await sql(db, 'SELECT buyer FROM customers WHERE buyer>? ORDER BY buyer LIMIT 201', after).all();
      return { items: rows.results.slice(0,200).map(row => row.buyer), hasNext: rows.results.length > 200 };
    }
    if (id === 'summary') return db.prepare(`SELECT
      COALESCE(SUM(status='review'),0) AS review,
      COALESCE(SUM(status='processing'),0) AS processing,
      COALESCE(SUM(cancel_requested=1 AND status NOT IN ('completed','cancelled','refunded')),0) AS cancellations
      FROM orders`).first();
    if (id === 'orders') {
      const filters = {
        all: '1=1', review: "status='review'", processing: "status='processing'",
        cancellation: "cancel_requested=1 AND status NOT IN ('completed','cancelled','refunded')",
        refund: "status='refund_pending'", awaiting_payment: "status='awaiting_payment'",
        awaiting_proof: "status='awaiting_proof'", completed: "status='completed'",
        cancelled: "status='cancelled'", refunded: "status='refunded'",
      };
      const filter = filters[url.searchParams.get('filter') || 'all'];
      if (!filter) fail(400, 'Filter tidak valid.');
      const result = await db.prepare(`SELECT * FROM orders WHERE ${filter} ORDER BY created_at DESC,id DESC`).all();
      return { items: result.results };
    }
  }
  if (resource === 'catalog' && method === 'GET') {
    const [categories, variants] = await Promise.all([
      db.prepare('SELECT * FROM categories WHERE deleted=0 ORDER BY id').all(),
      db.prepare('SELECT v.* FROM variants v JOIN categories c ON c.id=v.category_id WHERE c.deleted=0 AND v.archived=0 ORDER BY v.category_id,v.id').all(),
    ]);
    return { categories: categories.results, variants: variants.results };
  }
  if (resource === 'categories' && method === 'POST' && !id) {
    const data = await bodyOf(request);
    const name = typeof data.name === 'string' ? data.name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleUpperCase('id-ID') : '';
    if (!text(name, 80) || !text(data.key, 250)) fail(400, 'Nama katalog wajib 1–80 karakter.');
    const previous = await sql(db, 'SELECT * FROM categories WHERE request_key=?', data.key).first();
    if (previous) {
      if (previous.deleted) fail(409, 'Katalog dari permintaan ini sudah dihapus. Mulai penambahan baru.');
      if (previous.name !== name) fail(409, 'Permintaan katalog ini sudah dipakai. Mulai penambahan baru.');
      return previous;
    }
    try { await sql(db, 'INSERT INTO categories(name,request_key) VALUES (?,?)', name, data.key).run(); }
    catch (error) {
      const retry = await sql(db, 'SELECT * FROM categories WHERE request_key=?', data.key).first();
      if (retry && retry.name === name) return retry;
      if (String(error).includes('UNIQUE')) fail(409, 'Nama katalog sudah ada. Pilih nama lain.');
      throw error;
    }
    return sql(db, 'SELECT * FROM categories WHERE request_key=?', data.key).first();
  }
  if (resource === 'categories' && method === 'POST' && id && !sub) {
    const data = await bodyOf(request);
    const categoryId = Number(id);
    if (!Number.isSafeInteger(categoryId) || categoryId < 1 || !['rename','delete'].includes(data.mode) || !Number.isSafeInteger(data.expectedVersion) || data.expectedVersion < 0) fail(400, 'Perubahan katalog tidak valid.');
    const current = await sql(db, 'SELECT * FROM categories WHERE id=?', categoryId).first();
    if (!current) fail(404, 'Katalog tidak ditemukan.');
    if (current.deleted) {
      if (data.mode === 'delete') return current;
      fail(404, 'Katalog sudah dihapus.');
    }
    const name = typeof data.name === 'string' ? data.name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleUpperCase('id-ID') : '';
    if (data.mode === 'rename' && !text(name,80)) fail(400, 'Nama katalog wajib 1–80 karakter.');
    if (current.version !== data.expectedVersion) {
      if (data.mode === 'rename' && current.name === name) return current;
      fail(409, 'Katalog berubah. Periksa detail terbaru.');
    }
    let result;
    try {
      result = data.mode === 'delete'
        ? await sql(db, 'UPDATE categories SET deleted=1,version=version+1 WHERE id=? AND deleted=0 AND version=?', categoryId, current.version).run()
        : await sql(db, 'UPDATE categories SET name=?,version=version+1 WHERE id=? AND deleted=0 AND version=?', name, categoryId, current.version).run();
    } catch (error) {
      if (String(error).includes('UNIQUE')) fail(409, 'Nama katalog sudah ada. Pilih nama lain.');
      throw error;
    }
    if (!result.meta.changes) fail(409, 'Katalog berubah. Periksa detail terbaru.');
    return sql(db, 'SELECT * FROM categories WHERE id=?', categoryId).first();
  }
  if (resource === 'customers' && id) {
    const row = await customer(db, id);
    if (method === 'GET' && !sub) return row;
    if (method === 'PUT' && sub === 'session') {
      const state = await bodyOf(request);
      if (!state || typeof state !== 'object' || Array.isArray(state) || JSON.stringify(state).length > 8000) fail(400, 'Sesi tidak valid.');
      await sql(db, 'UPDATE customers SET session=? WHERE buyer=?', JSON.stringify(state), id).run();
      return { ok: true };
    }
  }
  if (resource === 'variants' && method === 'POST') {
    const v = await bodyOf(request);
    if (!text(v.id, 64) || !/^[a-z0-9-]+$/.test(v.id)) fail(400, 'Kode varian tidak valid.');
    const current = await sql(db, 'SELECT * FROM variants WHERE id=?', v.id).first();
    if (v.mode !== 'add' && !current) fail(404, 'Varian tidak ditemukan.');
    if (current && !await sql(db, 'SELECT id FROM categories WHERE id=? AND deleted=0', current.category_id).first()) fail(404, 'Katalog sudah dihapus.');
    if (v.expectedVersion !== undefined && (!Number.isSafeInteger(v.expectedVersion) || v.expectedVersion !== current?.version)) fail(409, 'Varian berubah. Buka detail terbaru.');
    const update = async (fields, ...values) => {
      const result = await sql(db, `UPDATE variants SET ${fields},version=version+1 WHERE id=? AND version=?`, ...values, v.id, current.version).run();
      if (!result.meta.changes) fail(409, 'Varian berubah. Buka detail terbaru.');
    };
    if (v.mode === 'price') {
      if (!Number.isSafeInteger(v.price) || v.price < 1 || v.price > 9999999999) fail(400, 'Harga tidak valid.');
      await update('price=?', v.price);
    } else if (v.mode === 'ready') {
      if (typeof v.ready !== 'boolean') fail(400, 'Status ready tidak valid.');
      if (v.ready && current.archived) fail(409, 'Varian lama tidak tersedia. Tambahkan varian baru.');
      await update('ready=?', Number(v.ready));
    } else if (v.mode === 'name' || v.mode === 'terms') {
      if (!text(v.value, v.mode === 'name' ? 120 : 2000)) fail(400, 'Nilai tidak valid.');
      await update(`${v.mode}=?`, v.value);
    } else if (v.mode === 'delete') {
      const result = await sql(db, 'DELETE FROM variants WHERE id=? AND version=?', v.id, current.version).run();
      if (!result.meta.changes) fail(409, 'Varian berubah. Buka detail terbaru.');
      return { id: current.id, category_id: current.category_id, deleted: true };
    } else if (v.mode === 'add' || v.mode === 'edit') {
      if (!Number.isSafeInteger(v.categoryId) || v.categoryId < 1 || !text(v.name, 120) || !text(v.terms, 2000) || !Number.isSafeInteger(v.price) || v.price < 1 || v.price > 9999999999) fail(400, 'Detail varian tidak valid.');
      if (!await sql(db, 'SELECT id FROM categories WHERE id=? AND deleted=0', v.categoryId).first()) fail(400, 'Katalog tidak ditemukan.');
      if (v.mode === 'add') await sql(db, 'INSERT INTO variants(id,category_id,name,price,terms) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING', v.id, v.categoryId, v.name, v.price, v.terms).run();
      else await update('category_id=?,name=?,price=?,terms=?', v.categoryId, v.name, v.price, v.terms);
    } else fail(400, 'Operasi varian tidak valid.');
    const result = await sql(db, 'SELECT * FROM variants WHERE id=?', v.id).first();
    if (!result) fail(404, 'Varian tidak ditemukan.');
    return result;
  }
  if (resource === 'orders') {
    if (method === 'POST' && !id) {
      const data = await bodyOf(request);
      if (!isBuyer(data.buyer) || !text(data.key, 250) || !text(data.variantId, 64) || !Number.isSafeInteger(data.quantity) || data.quantity < 1 || data.quantity > 100 || !text(data.qrisVersion, 64) || !Number.isSafeInteger(data.expectedPrice) || !text(data.expectedTerms)) fail(400, 'Data order tidak valid.');
      await customer(db, data.buyer);
      const previous = await sql(db, 'SELECT * FROM orders WHERE request_key=?', data.key).first();
      if (previous) {
        if (previous.buyer !== data.buyer) fail(409, 'Kunci order sudah dipakai.');
        return previous;
      }
      const orderId = `MZ-${(await hash(data.key)).slice(0, 16).toUpperCase()}`;
      try {
        await sql(db, `INSERT INTO orders(id,request_key,buyer,variant_id,product,variant,terms,unit_price,quantity,total,status,qris_version)
          SELECT ?,?,?,v.id,c.name,v.name,v.terms,v.price,?,v.price * ?,'awaiting_payment',?
          FROM variants v JOIN categories c ON c.id=v.category_id WHERE v.id=? AND c.deleted=0 AND v.ready=1 AND v.archived=0 AND v.price=? AND v.terms=?`,
        orderId, data.key, data.buyer, data.quantity, data.quantity, data.qrisVersion, data.variantId, data.expectedPrice, data.expectedTerms).run();
      } catch (error) {
        const retry = await sql(db, 'SELECT * FROM orders WHERE request_key=?', data.key).first();
        if (retry) return retry;
        if (String(error).includes('UNIQUE')) fail(409, 'Masih ada order aktif. Gunakan /pesanan atau /batal.');
        throw error;
      }
      const result = await sql(db, 'SELECT * FROM orders WHERE id=?', orderId).first();
      if (!result) fail(409, 'Varian, harga, atau deskripsi berubah. Buka /menu dan periksa ulang.');
      return result;
    }
    if (method === 'GET' && !id) return { orders: (await db.prepare("SELECT * FROM orders WHERE status NOT IN ('completed','cancelled','refunded') ORDER BY created_at LIMIT 100").all()).results };
    const order = await sql(db, 'SELECT * FROM orders WHERE id=?', id).first();
    if (!order) fail(404, 'Order tidak ditemukan.');
    if (method === 'GET' && !sub) return order;
    if (method === 'POST' && sub === 'actions') {
      const data = await bodyOf(request);
      if (!text(data.key, 250) || !text(data.actor, 100) || (data.reason !== undefined && (typeof data.reason !== 'string' || data.reason.length > 2000))) fail(400, 'Tindakan tidak valid.');
      const previous = await sql(db, 'SELECT * FROM order_actions WHERE action_key=?', data.key).first();
      if (previous) {
        if (previous.order_id !== id || previous.action !== data.action || previous.actor !== data.actor) fail(409, 'Kunci tindakan sudah dipakai.');
        return order;
      }
      const admin = data.actor === 'admin';
      if (!admin && data.actor !== order.buyer) fail(403, 'Bukan pemilik order.');
      if (data.expectedVersion !== undefined && (!Number.isSafeInteger(data.expectedVersion) || data.expectedVersion !== order.version)) fail(409, 'Order berubah. Buka detail terbaru.');
      const transitions = {
        done: { from: ['awaiting_payment'], to: 'awaiting_proof', admin: false },
        submit_proof: { from: ['awaiting_proof'], to: 'review', admin: false, extra: ",proof_relay='pending',cancel_requested=0" },
        proof_sent: { from: ['review'], to: 'review', admin: false, extra: ",proof_relay='sent',cancel_requested=0" },
        reject_proof: { from: ['review'], to: 'awaiting_proof', admin: true, extra: ",proof_relay='none',cancel_requested=0" },
        approve: { from: ['review'], to: 'processing', admin: true },
        complete: { from: ['processing'], to: 'completed', admin: true },
        refund: { from: ['processing'], to: 'refund_pending', admin: true },
        refund_complete: { from: ['refund_pending'], to: 'refunded', admin: true },
        cancel: { from: ['awaiting_payment','awaiting_proof','review'], to: 'cancelled', admin, extra: ',cancel_requested=0' },
        request_cancel: { from: ['awaiting_proof','review','processing'], to: order.status === 'processing' ? 'processing' : 'cancelled', admin: false, extra: order.status === 'processing' ? ',cancel_requested=1' : ',cancel_requested=0' },
        clear_cancel: { from: ['awaiting_proof','review','processing'], to: order.status, admin: true, extra: ',cancel_requested=0' },
      };
      const t = transitions[data.action];
      if (!t || (t.admin && !admin)) fail(403, 'Tindakan tidak diizinkan.');
      if (!t.from.includes(order.status)) fail(409, 'Status order tidak sesuai untuk tindakan ini.');
      if (data.action === 'approve' && order.cancel_requested) fail(409, 'Selesaikan permintaan pembatalan terlebih dahulu.');
      if (['reject_proof','refund'].includes(data.action) || (admin && data.action === 'cancel')) {
        if (!text(data.reason)) fail(400, 'Alasan wajib diisi.');
      }
      const result = await db.batch([
        sql(db, `UPDATE orders SET status=?,last_action_key=?,updated_at=CURRENT_TIMESTAMP,version=version+1${t.extra || ''} WHERE id=? AND version=? AND status=?${data.action === 'approve' ? ' AND cancel_requested=0' : ''}`, t.to, data.key, id, order.version, order.status),
        sql(db, 'INSERT INTO order_actions(action_key,order_id,action,actor,reason) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM orders WHERE id=? AND last_action_key=?)', data.key, id, data.action, data.actor, data.reason || '', id, data.key),
      ]);
      if (!result[0].meta.changes) fail(409, 'Order sudah berubah. Periksa ulang.');
      return sql(db, 'SELECT * FROM orders WHERE id=?', id).first();
    }
  }
  if (resource === 'messages') {
    if (method === 'GET') {
      const result = await sql(db, 'SELECT * FROM messages WHERE jid=? AND wa_id=?', url.searchParams.get('jid'), id).first();
      if (!result) fail(404, 'Referensi pesan tidak ditemukan. Buka /admin → Pesanan & pembayaran.');
      return result;
    }
    if (method === 'POST') {
      const m = await bodyOf(request);
      if (!isBuyer(m.buyer) || !isBuyer(m.jid) || !text(m.waId, 200) || !['buyer','admin'].includes(m.role)) fail(400, 'Referensi pesan tidak valid.');
      const kind = m.kind || 'relay';
      if (!['relay','menu','card'].includes(kind) || (kind === 'menu' && !text(m.menuToken,100))) fail(400, 'Jenis referensi tidak valid.');
      await customer(db, m.buyer);
      if (m.orderId) {
        const owner = await sql(db, 'SELECT buyer FROM orders WHERE id=?', m.orderId).first();
        if (!owner || owner.buyer !== m.buyer) fail(400, 'Order tidak sesuai buyer.');
      }
      await sql(db, 'INSERT OR IGNORE INTO messages(jid,wa_id,buyer,order_id,role,kind,menu_token) VALUES (?,?,?,?,?,?,?)', m.jid, m.waId, m.buyer, m.orderId || null, m.role, kind, m.menuToken || null).run();
      return { ok: true };
    }
  }
  fail(404, 'Endpoint tidak ditemukan.');
}

export default {
  async fetch(request, env) {
    try {
      const path = new URL(request.url).pathname;
      if (path.startsWith('/c/')) {
        if (!['GET','HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
        const match = path.match(/^\/c\/([A-Za-z0-9-]{1,64})\/([1-9]\d{7,14})\/([A-Za-z0-9_-]{43})$/);
        if (!match || !await verifyClaimLink(match[1], match[2], match[3], env.API_SECRET)) fail(404, 'Link tidak ditemukan.');
        const order = await sql(env.DB, 'SELECT * FROM orders WHERE id=?', match[1]).first();
        if (!order) fail(404, 'Link tidak ditemukan.');
        if (order.status !== 'processing') fail(410, 'Link CLAIM sudah tidak aktif. Hubungi admin melalui /chat di bot.');
        return new Response(null, { status: 302, headers: { Location: claimDestination(match[2], order), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' } });
      }
      return json(await route(request, env));
    }
    catch (error) { return json({ error: error.status ? error.message : 'Layanan database bermasalah. Coba lagi.' }, error.status || 503); }
  },
};
