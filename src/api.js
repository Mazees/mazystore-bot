export class ApiError extends Error {
  constructor(status, message, code = 'API_HTTP') {
    super(message); this.name = 'ApiError'; this.status = status; this.code = code;
  }
}

export class StoreApi {
  constructor(url, secret) { this.url = url; this.secret = secret; }
  async call(path, method = 'GET', body) {
    const idempotent = method === 'GET' || method === 'POST' && typeof body?.key === 'string' && (path === '/orders' || path === '/categories' || /^\/orders\/[^/]+\/actions$/.test(path));
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
  catalog(includeArchived = false) { return this.call(`/catalog${includeArchived ? '?archived=1' : ''}`); }
  category(data) { return this.call('/categories', 'POST', data); }
  adminSummary() { return this.call('/admin/summary'); }
  adminOrders(filter = 'all', page = 0) { return this.call(`/admin/orders?filter=${encodeURIComponent(filter)}&page=${page}`); }
  adminConversations(page = 0) { return this.call(`/admin/conversations?page=${page}`); }
  customer(buyer) { return this.call(`/customers/${encodeURIComponent(buyer)}`); }
  session(buyer, state) { return this.call(`/customers/${encodeURIComponent(buyer)}/session`, 'PUT', state); }
  createOrder(data) { return this.call('/orders', 'POST', data); }
  order(id) { return this.call(`/orders/${encodeURIComponent(id)}`); }
  orders() { return this.call('/orders'); }
  action(id, data) { return this.call(`/orders/${encodeURIComponent(id)}/actions`, 'POST', data); }
  variant(data) { return this.call('/variants', 'POST', data); }
  map(data) { return this.call('/messages', 'POST', data); }
  message(jid, id) { return this.call(`/messages/${encodeURIComponent(id)}?jid=${encodeURIComponent(jid)}`); }
  conversation(id) { return this.call(`/conversations/${encodeURIComponent(id)}`); }
}
