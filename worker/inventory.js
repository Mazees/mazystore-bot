const sql = (db, query, ...args) => db.prepare(query).bind(...args);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const encrypted = value => typeof value === 'string' && value.length >= 40 && value.length <= 12000 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);

export async function inventoryRoute(request, db, path, bodyOf, hash) {
  const [, resource, id] = path, method = request.method;
  const url = new URL(request.url);
  if (resource === 'stock') {
    if (method === 'GET') {
      if (id) {
        const item = await sql(db,'SELECT * FROM inventory WHERE id=?',id).first();
        if (!item) fail(404,'Stok tidak ditemukan.');
        return item;
      }
      const orderId = url.searchParams.get('orderId');
      const items = orderId
        ? await sql(db,'SELECT * FROM inventory WHERE order_id=? ORDER BY created_at,id',orderId).all()
        : await sql(db,"SELECT id,variant_id,state,version FROM inventory WHERE variant_id=? AND state='available' ORDER BY created_at,id",url.searchParams.get('variantId')).all();
      return { items: items.results };
    }
    const data = await bodyOf(request, 1300000);
    if (method === 'POST' && !id) {
      if (typeof data.key !== 'string' || !data.key || data.key.length > 250 || typeof data.variantId!=='string' || !/^[a-z0-9-]{1,64}$/.test(data.variantId) || !Array.isArray(data.items) || !data.items.length || data.items.length > 100 || !data.items.every(encrypted)) fail(400,'Batch stok tidak valid.');
      const batchId = await hash(data.key);
      const previous = await sql(db,'SELECT * FROM stock_batches WHERE id=?',batchId).first();
      if (previous) {
        if (previous.variant_id !== data.variantId) fail(409,'Kunci batch sudah dipakai.');
        return { added: previous.quantity };
      }
      const variant = await sql(db,"SELECT v.id FROM variants v JOIN categories c ON c.id=v.category_id WHERE v.id=? AND v.delivery_mode='auto' AND c.deleted=0",data.variantId).first();
      if (!variant) fail(409,'Varian otomatis tidak tersedia.');
      await db.batch([
        sql(db,'INSERT OR IGNORE INTO stock_batches(id,variant_id,quantity) VALUES (?,?,?)',batchId,data.variantId,data.items.length),
        sql(db,"INSERT OR IGNORE INTO inventory(id,variant_id,payload) SELECT ? || '-' || key,?,value FROM json_each(?)",batchId,data.variantId,JSON.stringify(data.items)),
      ]);
      return { added: data.items.length };
    }
    if (method === 'POST' && id) {
      if (!['edit','delete'].includes(data.mode) || !Number.isSafeInteger(data.expectedVersion) || data.mode === 'edit' && !encrypted(data.payload)) fail(400,'Perubahan stok tidak valid.');
      const result = data.mode === 'delete'
        ? await sql(db,"DELETE FROM inventory WHERE id=? AND state='available' AND version=?",id,data.expectedVersion).run()
        : await sql(db,"UPDATE inventory SET payload=?,version=version+1 WHERE id=? AND state='available' AND version=?",data.payload,id,data.expectedVersion).run();
      if (!result.meta.changes) fail(409,'Stok sudah berubah atau dialokasikan. Perubahan ditolak.');
      return { ok: true };
    }
  }
  if (resource === 'deliveries') {
    if (method === 'GET') {
      if (!id) return { orders: (await db.prepare("SELECT * FROM orders WHERE delivery_mode='auto' AND status='processing' ORDER BY created_at").all()).results };
      return { parts: (await sql(db,'SELECT * FROM deliveries WHERE order_id=? ORDER BY part',id).all()).results };
    }
    if (method !== 'POST' || !id) fail(405,'Metode tidak tersedia.');
    const data = await bodyOf(request,1300000);
    const order = await sql(db,'SELECT * FROM orders WHERE id=?',id).first();
    if (!order || order.delivery_mode !== 'auto') fail(409,'Order bukan penyerahan otomatis.');
    if (data.mode === 'prepare') {
      if (order.status !== 'processing') fail(409,'Order tidak sedang diproses.');
      if (!Array.isArray(data.parts) || data.parts.length !== order.quantity || !data.parts.every(p => encrypted(p.payload) && /^[A-Za-z0-9]{10,100}$/.test(p.waId))) fail(400,'Bagian pengiriman tidak valid.');
      if ((await sql(db,'SELECT COUNT(*) AS n FROM inventory WHERE order_id=?',id).first()).n !== order.quantity) fail(409,'Alokasi stok tidak lengkap.');
      await sql(db,"INSERT OR IGNORE INTO deliveries(order_id,part,wa_id,payload) SELECT ?,key,json_extract(value,'$.waId'),json_extract(value,'$.payload') FROM json_each(?) WHERE EXISTS(SELECT 1 FROM orders WHERE id=? AND status='processing')",id,JSON.stringify(data.parts),id).run();
      return { ok: true };
    }
    if (data.mode === 'start') {
      if(!Number.isSafeInteger(data.part) || data.part<0 || data.part>=100)fail(400,'Nomor bagian tidak valid.');
      const result = await db.batch([
        sql(db,"UPDATE orders SET version=version+1 WHERE id=? AND status='processing' AND EXISTS(SELECT 1 FROM deliveries WHERE order_id=? AND part=? AND state='pending')",id,id,data.part),
        sql(db,"UPDATE deliveries SET state='sending',started=1 WHERE order_id=? AND part=? AND state='pending' AND EXISTS(SELECT 1 FROM orders WHERE id=? AND status='processing')",id,data.part,id),
      ]);
      if (!result[1].meta.changes) fail(409,'Pengiriman tidak dapat dimulai; status sudah berubah.');
      return { ok: true };
    }
    if (['sent','uncertain','received'].includes(data.mode)) {
      if(typeof data.waId!=='string' || data.waId.length>100)fail(400,'ID pesan tidak valid.');
      const result = await sql(db,`UPDATE deliveries SET state=? WHERE order_id=? AND wa_id=? AND started=1 AND state IN (${data.mode === 'received' ? "'sending','sent','uncertain'" : "'sending'"})`,data.mode,id,data.waId).run();
      return { changed: result.meta.changes };
    }
    if (data.mode === 'finish') {
      const key = `autodelivery:${id}`;
      const result = await db.batch([
        sql(db,"UPDATE orders SET status='completed',updated_at=CURRENT_TIMESTAMP,version=version+1,last_action_key=? WHERE id=? AND status='processing' AND (SELECT COUNT(*) FROM deliveries WHERE order_id=?)=quantity AND NOT EXISTS(SELECT 1 FROM deliveries WHERE order_id=? AND state!='received')",key,id,id,id),
        sql(db,"INSERT OR IGNORE INTO order_actions(action_key,order_id,action,actor) SELECT ?,?,'auto_complete','bot' WHERE EXISTS(SELECT 1 FROM orders WHERE id=? AND last_action_key=?)",key,id,id,key),
      ]);
      return { completed: Boolean(result[0].meta.changes), order: await sql(db,'SELECT * FROM orders WHERE id=?',id).first() };
    }
    fail(400,'Operasi pengiriman tidak valid.');
  }
  fail(404,'Endpoint tidak ditemukan.');
}
