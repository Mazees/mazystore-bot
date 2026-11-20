export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class StoreApi {
  constructor(url, secret) { this.url = url; this.secret = secret; }
  async call(path, method = 'GET', body) {
    const response = await fetch(`${this.url}/v1${path}`, {
      method, headers: { Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok) throw new ApiError(response.status, result.error || 'Layanan toko tidak tersedia.');
    return result;
  }
  catalog() { return this.call('/catalog'); }
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
