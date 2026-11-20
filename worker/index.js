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
  if (resource === 'catalog' && method === 'GET') {
    const [categories, variants] = await Promise.all([
      db.prepare('SELECT * FROM categories ORDER BY id').all(),
      db.prepare('SELECT * FROM variants ORDER BY category_id,id').all(),
    ]);
    return { categories: categories.results, variants: variants.results };
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
  if (resource === 'conversations' && method === 'GET') {
    const row = await sql(db, 'SELECT buyer FROM customers WHERE conversation_id=?', id).first();
    if (!row) fail(404, 'Percakapan tidak ditemukan.');
    return customer(db, row.buyer);
  }
  if (resource === 'variants' && method === 'POST') {
    const v = await bodyOf(request);
    if (!text(v.id, 64) || !/^[a-z0-9-]+$/.test(v.id)) fail(400, 'Kode varian tidak valid.');
    if (v.mode === 'price') {
      if (!Number.isSafeInteger(v.price) || v.price < 1 || v.price > 9999999999) fail(400, 'Harga tidak valid.');
      await sql(db, 'UPDATE variants SET price=? WHERE id=?', v.price, v.id).run();
    } else if (v.mode === 'ready') {
      if (typeof v.ready !== 'boolean') fail(400, 'Status ready tidak valid.');
      await sql(db, 'UPDATE variants SET ready=? WHERE id=?', Number(v.ready), v.id).run();
    } else if (v.mode === 'add' || v.mode === 'edit') {
      if (!Number.isInteger(v.categoryId) || v.categoryId < 1 || v.categoryId > 7 || !text(v.name, 120) || !text(v.terms, 2000) || !Number.isSafeInteger(v.price) || v.price < 1 || v.price > 9999999999) fail(400, 'Detail varian tidak valid.');
      if (v.mode === 'add') await sql(db, 'INSERT INTO variants(id,category_id,name,price,terms) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING', v.id, v.categoryId, v.name, v.price, v.terms).run();
      else await sql(db, 'UPDATE variants SET category_id=?,name=?,price=?,terms=? WHERE id=?', v.categoryId, v.name, v.price, v.terms, v.id).run();
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
          FROM variants v JOIN categories c ON c.id=v.category_id WHERE v.id=? AND v.ready=1 AND v.price=? AND v.terms=?`,
        orderId, data.key, data.buyer, data.quantity, data.quantity, data.qrisVersion, data.variantId, data.expectedPrice, data.expectedTerms).run();
      } catch (error) {
        const retry = await sql(db, 'SELECT * FROM orders WHERE request_key=?', data.key).first();
        if (retry) return retry;
        if (String(error).includes('UNIQUE')) fail(409, 'Masih ada order aktif. Gunakan /pesanan atau /batal.');
        throw error;
      }
      const result = await sql(db, 'SELECT * FROM orders WHERE id=?', orderId).first();
      if (!result) fail(409, 'Varian, harga, atau ketentuan berubah. Buka /menu dan periksa ulang.');
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
      const transitions = {
        done: { from: ['awaiting_payment'], to: 'awaiting_proof', admin: false },
        submit_proof: { from: ['awaiting_proof'], to: 'review', admin: false, extra: ",proof_relay='pending'" },
        proof_sent: { from: ['review'], to: 'review', admin: false, extra: ",proof_relay='sent'" },
        reject_proof: { from: ['review'], to: 'awaiting_proof', admin: true, extra: ",proof_relay='none'" },
        approve: { from: ['review'], to: 'processing', admin: true },
        complete: { from: ['processing'], to: 'completed', admin: true },
        refund: { from: ['processing'], to: 'refund_pending', admin: true },
        refund_complete: { from: ['refund_pending'], to: 'refunded', admin: true },
        cancel: { from: admin ? ['awaiting_payment','awaiting_proof','review'] : ['awaiting_payment'], to: 'cancelled', admin },
        request_cancel: { from: ['awaiting_proof','review','processing'], to: order.status, admin: false, extra: ',cancel_requested=1' },
        clear_cancel: { from: ['awaiting_proof','review','processing'], to: order.status, admin: true, extra: ',cancel_requested=0' },
      };
      const t = transitions[data.action];
      if (!t || (t.admin && !admin)) fail(403, 'Tindakan tidak diizinkan.');
      if (!t.from.includes(order.status)) fail(409, 'Status order tidak sesuai untuk tindakan ini.');
      if (data.action === 'approve' && order.cancel_requested) fail(409, 'Selesaikan permintaan pembatalan terlebih dahulu.');
      if (['reject_proof','refund'].includes(data.action) && !text(data.reason)) fail(400, 'Alasan wajib diisi.');
      const result = await db.batch([
        sql(db, `UPDATE orders SET status=?,last_action_key=?,updated_at=CURRENT_TIMESTAMP${t.extra || ''} WHERE id=? AND status=?${data.action === 'approve' ? ' AND cancel_requested=0' : ''}`, t.to, data.key, id, order.status),
        sql(db, 'INSERT INTO order_actions(action_key,order_id,action,actor,reason) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM orders WHERE id=? AND last_action_key=?)', data.key, id, data.action, data.actor, data.reason || '', id, data.key),
      ]);
      if (!result[0].meta.changes) fail(409, 'Order sudah berubah. Periksa ulang.');
      return sql(db, 'SELECT * FROM orders WHERE id=?', id).first();
    }
  }
  if (resource === 'messages') {
    if (method === 'GET') {
      const result = await sql(db, 'SELECT * FROM messages WHERE jid=? AND wa_id=?', url.searchParams.get('jid'), id).first();
      if (!result) fail(404, 'Referensi pesan tidak ditemukan. Gunakan /balas.');
      return result;
    }
    if (method === 'POST') {
      const m = await bodyOf(request);
      if (!isBuyer(m.buyer) || !isBuyer(m.jid) || !text(m.waId, 200) || !['buyer','admin'].includes(m.role)) fail(400, 'Referensi pesan tidak valid.');
      await customer(db, m.buyer);
      if (m.orderId) {
        const owner = await sql(db, 'SELECT buyer FROM orders WHERE id=?', m.orderId).first();
        if (!owner || owner.buyer !== m.buyer) fail(400, 'Order tidak sesuai buyer.');
      }
      await sql(db, 'INSERT OR IGNORE INTO messages(jid,wa_id,buyer,order_id,role) VALUES (?,?,?,?,?)', m.jid, m.waId, m.buyer, m.orderId || null, m.role).run();
      return { ok: true };
    }
  }
  fail(404, 'Endpoint tidak ditemukan.');
}

export default {
  async fetch(request, env) {
    try { return json(await route(request, env)); }
    catch (error) { return json({ error: error.status ? error.message : 'Layanan database bermasalah. Coba lagi.' }, error.status || 503); }
  },
};
