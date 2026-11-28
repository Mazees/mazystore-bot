import { D1Rest } from './d1.js';
import { storeRequest } from './store-service.js';
import { shortenClaim } from './claim-link.js';

export class ApiError extends Error {
  constructor(status, message, code = 'API_HTTP') {
    super(message); this.name = 'ApiError'; this.status = status; this.code = code;
  }
}

export class StoreApi {
  constructor(config) { this.db = new D1Rest(config); }
  async call(path, method = 'GET', body) {
    const idempotent = method === 'GET' || method === 'POST' && typeof body?.key === 'string' && (path === '/orders' || path === '/categories' || path === '/stock' || /^\/orders\/[^/]+\/actions$/.test(path));
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await storeRequest(this.db, path, method, body); }
      catch (error) {
        if (/STOCK_ALLOCATED|AUTO_ORDER_ACTIVE|STOCK_VARIANT_UNAVAILABLE|STOCK_UNAVAILABLE/.test(error.message)) throw new ApiError(409, 'Stok atau order berubah. Periksa data terbaru.');
        if (!attempt && idempotent && (error.code === 'API_NETWORK' || error.status >= 500 || error.status === 429) && (error.retryAfter || 0) <= 60000) {
          await new Promise(resolve => setTimeout(resolve, error.retryAfter || 300));
          continue;
        }
        if (error.code?.startsWith('API_') && error.code !== 'API_SQL') throw error;
        if (error.code === 'API_SQL') throw new ApiError(error.status >= 500 ? error.status : 503, 'Query D1 gagal. Periksa status pesanan sebelum mengulang.');
        throw new ApiError(error.status || 503, error.status ? error.message : 'Layanan D1 bermasalah. Periksa status pesanan sebelum mengulang.');
      }
    }
  }
  health() { return this.db.prepare('SELECT 1 AS ok').first(); }
  catalog() { return this.call('/catalog'); }
  category(data) { return this.call('/categories', 'POST', data); }
  categoryAction(id, data) { return this.call(`/categories/${id}`, 'POST', data); }
  adminSummary() { return this.call('/admin/summary'); }
  broadcastRecipients(after = '') { return this.call(`/admin/recipients?after=${encodeURIComponent(after)}`); }
  adminOrders(filter = 'all') { return this.call(`/admin/orders?filter=${encodeURIComponent(filter)}`); }
  customer(buyer) { return this.call(`/customers/${encodeURIComponent(buyer)}`); }
  session(buyer, state) { return this.call(`/customers/${encodeURIComponent(buyer)}/session`, 'PUT', state); }
  createOrder(data) { return this.call('/orders', 'POST', data); }
  order(id) { return this.call(`/orders/${encodeURIComponent(id)}`); }
  async claimLink(orderId, adminNumber) { return { url: await shortenClaim(adminNumber, await this.order(orderId)) }; }
  orders() { return this.call('/orders'); }
  async action(id, data) {
    const order = await this.call(`/orders/${encodeURIComponent(id)}/actions`, 'POST', data);
    if (data.action === 'approve' && order.delivery_mode === 'auto' && order.status === 'processing') this.onDelivery?.();
    return order;
  }
  variant(data) { return this.call('/variants', 'POST', data); }
  stock(variantId) { return this.call(`/stock?variantId=${encodeURIComponent(variantId)}`); }
  stockItem(id) { return this.call(`/stock/${encodeURIComponent(id)}`); }
  orderStock(id) { return this.call(`/stock?orderId=${encodeURIComponent(id)}`); }
  addStock(data) { return this.call('/stock', 'POST', data); }
  changeStock(id, data) { return this.call(`/stock/${encodeURIComponent(id)}`, 'POST', data); }
  deliveryOrders() { return this.call('/deliveries'); }
  deliveryParts(id) { return this.call(`/deliveries/${encodeURIComponent(id)}`); }
  async delivery(id, data) {
    const result = await this.call(`/deliveries/${encodeURIComponent(id)}`, 'POST', data);
    if (['sent','received','uncertain'].includes(data.mode)) this.onDelivery?.();
    return result;
  }
  map(data) { return this.call('/messages', 'POST', data); }
  message(jid, id) { return this.call(`/messages/${encodeURIComponent(id)}?jid=${encodeURIComponent(jid)}`); }
}
