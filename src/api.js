import { claimLink } from './claim-link.js';

export class ApiError extends Error {
  constructor(status, message, code = 'API_HTTP') {
    super(message); this.name = 'ApiError'; this.status = status; this.code = code;
  }
}

export class StoreApi {
  constructor(url, secret) { this.url = url; this.secret = secret; }
  async call(path, method = 'GET', body) {
    const idempotent = method === 'GET' || method === 'POST' && typeof body?.key === 'string' && (path === '/orders' || path === '/categories' || path === '/stock' || /^\/orders\/[^/]+\/actions$/.test(path));
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await this.request(path, method, body); }
      catch (error) {
        if (attempt || !idempotent || error.code !== 'API_NETWORK' && !(error.status >= 500)) throw error;
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
  }
  async request(path, method, body) {
    let response;
    try {
      response = await fetch(`${this.url}/v1${path}`, {
        method, headers: { Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
      });
    } catch { throw new ApiError(0, 'Koneksi ke Worker gagal atau melewati batas waktu.', 'API_NETWORK'); }
    let result;
    try { result = await response.json(); }
    catch { throw new ApiError(response.status, 'Respons Worker bukan JSON yang valid. Periksa WORKER_URL dan status layanan.', 'API_RESPONSE'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ApiError(response.status, 'Format respons Worker tidak sesuai.', 'API_RESPONSE');
    if (!response.ok) throw new ApiError(response.status, typeof result.error === 'string' ? result.error : 'Layanan toko tidak tersedia.');
    return result;
  }
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
  async claimLink(orderId, adminNumber) { return { url: await claimLink(this.url, orderId, adminNumber, this.secret) }; }
  orders() { return this.call('/orders'); }
  action(id, data) { return this.call(`/orders/${encodeURIComponent(id)}/actions`, 'POST', data); }
  variant(data) { return this.call('/variants', 'POST', data); }
  stock(variantId) { return this.call(`/stock?variantId=${encodeURIComponent(variantId)}`); }
  stockItem(id) { return this.call(`/stock/${encodeURIComponent(id)}`); }
  orderStock(id) { return this.call(`/stock?orderId=${encodeURIComponent(id)}`); }
  addStock(data) { return this.call('/stock', 'POST', data); }
  changeStock(id, data) { return this.call(`/stock/${encodeURIComponent(id)}`, 'POST', data); }
  deliveryOrders() { return this.call('/deliveries'); }
  deliveryParts(id) { return this.call(`/deliveries/${encodeURIComponent(id)}`); }
  delivery(id, data) { return this.call(`/deliveries/${encodeURIComponent(id)}`, 'POST', data); }
  map(data) { return this.call('/messages', 'POST', data); }
  message(jid, id) { return this.call(`/messages/${encodeURIComponent(id)}?jid=${encodeURIComponent(jid)}`); }
}
