const fault = (status, message, code, retryAfter = 0) => Object.assign(new Error(message), { status, code, retryAfter });

export class D1Rest {
  constructor({ accountId, databaseId, apiToken }) {
    this.url = 'https://api.cloudflare.com/client/v4/accounts/' + accountId + '/d1/database/' + databaseId + '/query';
    this.apiToken = apiToken;
    this.blockedUntil = 0;
  }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    if (!statements.length) return [];
    const delay = this.blockedUntil - Date.now();
    if (delay > 0) throw fault(429, 'Batas request D1 tercapai. Coba setelah jeda layanan.', 'API_HTTP', delay);
    let response;
    try {
      response = await fetch(this.url, {
        method: 'POST', headers: { Authorization: 'Bearer ' + this.apiToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch: statements.map(statement => ({ sql: statement.sql, params: statement.params })) }),
        signal: AbortSignal.timeout(15000),
      });
    } catch { throw fault(0, 'Koneksi D1 gagal atau melewati batas waktu. Periksa status pesanan sebelum mengulang.', 'API_NETWORK'); }
    if (response.status === 429) {
      const header = response.headers.get('Retry-After');
      const seconds = Number(header);
      const retryAfter = header && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
      const wait = Number.isFinite(retryAfter) ? Math.max(1000, retryAfter) : 60000;
      this.blockedUntil = Date.now() + wait;
      throw fault(429, 'Batas request D1 tercapai. Coba setelah jeda layanan.', 'API_HTTP', wait);
    }
    if ([401,403].includes(response.status)) throw fault(response.status, 'D1 menolak akses. Periksa token Cloudflare dan izin D1.', 'API_HTTP');
    let body;
    try { body = await response.json(); }
    catch { throw fault(response.status >= 400 ? response.status : 503, 'Respons D1 bukan JSON yang valid.', 'API_RESPONSE'); }
    if (!response.ok || body?.success === false || (Array.isArray(body?.result) && body.result.some(result => result?.success === false))) {
      // Keep database constraint names available to the local business rules, never return them directly to buyers.
      const errors = Array.isArray(body?.errors) ? body.errors : [];
      const detail = [...errors, ...(Array.isArray(body?.result) ? body.result : []).flatMap(result => Array.isArray(result?.errors) ? result.errors : [])].map(error => error?.message || '').join('; ');
      throw fault(response.status >= 400 ? response.status : 503, detail || 'Query D1 gagal.', 'API_SQL');
    }
    if (!Array.isArray(body?.result) || body.result.length !== statements.length || body.result.some(result => result?.success !== true || !Array.isArray(result.results) || !result.meta)) {
      throw fault(503, 'Format respons D1 tidak sesuai.', 'API_RESPONSE');
    }
    return body.result;
  }
}

class Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Statement(this.db, this.sql, params); }
  async all() { return (await this.db.batch([this]))[0]; }
  run() { return this.all(); }
  async first(column) {
    const row = (await this.all()).results[0] || null;
    return column && row ? row[column] : row;
  }
}
