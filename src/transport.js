import { generateDynamicQris, renderQris } from './qris.js';

export class Transport {
  constructor(store, api, config) { this.store = store; this.api = api; this.config = config; this.socket = null; this.draining = false; }
  attach(socket) { this.socket = socket; }
  detach(socket) { if (this.socket === socket) this.socket = null; }
  async text(jid, text, id, context = null) {
    const chars = Array.from(text);
    for (let offset = 0; offset < chars.length; offset += 4000) {
      this.store.enqueue(`${id}:part${offset / 4000}`, jid, { kind: 'text', text: chars.slice(offset, offset + 4000).join(''), context });
    }
  }
  async payment(jid, order, id) {
    const { createHash } = await import('node:crypto');
    const version = createHash('sha256').update(this.config.qris).digest('hex');
    if (order.qris_version !== version) throw new Error('QRIS order berbeda dari konfigurasi sekarang. Hubungi admin.');
    this.store.enqueue(id, jid, { kind: 'qris', total: order.total, caption: `*PEMBAYARAN ${order.id}*\nMerchant: ${this.config.merchant}\nTotal: Rp${order.total.toLocaleString('id-ID')}\n\nSetelah membayar, ketik /done lalu kirim foto bukti pembayaran.\n/batal — Batalkan pesanan`, context: null });
  }
  async image(jid, buffer, caption, context = null) {
    if (!this.socket) throw new Error('WhatsApp belum tersambung.');
    const result = await this.socket.sendMessage(jid, { image: buffer, caption });
    if (!result?.key?.id) throw new Error('Pengiriman gambar belum terkonfirmasi.');
    if (context) await this.api.map({ ...context, jid, waId: result.key.id });
    return result;
  }
  async drain() {
    if (this.draining || !this.socket) return;
    this.draining = true;
    try {
      let job;
      while (this.socket && (job = this.store.next())) {
        if (job.status === 'mapping') {
          try {
            if (job.payload.context) await this.api.map({ ...job.payload.context, jid: job.jid, waId: job.wa_id });
            this.store.setStatus(job.id, 'sent');
          } catch { break; }
          continue;
        }
        let content;
        try {
          content = job.payload.kind === 'qris'
            ? { image: await renderQris(generateDynamicQris(this.config.qris, job.payload.total, this.config.merchant)), caption: job.payload.caption }
            : { text: job.payload.text };
        } catch { this.store.setStatus(job.id, 'uncertain'); continue; }
        this.store.setStatus(job.id, 'sending');
        try {
          const sent = await this.socket.sendMessage(job.jid, content);
          if (!sent?.key?.id) throw new Error('No WA message id');
          this.store.saveMessage(sent.key.id, sent.message);
          this.store.setStatus(job.id, 'mapping', sent.key.id);
        } catch {
          this.store.setStatus(job.id, 'uncertain');
          break;
        }
      }
    } finally { this.draining = false; }
  }
}
