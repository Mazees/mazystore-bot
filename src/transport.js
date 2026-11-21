import { generateDynamicQris, renderQris } from './qris.js';
import { generateMessageIDV2, generateWAMessageFromContent } from 'baileys';
import { renderMessage, splitMessage } from './ui.js';
import { sendNewsletterImage } from './newsletter-image.js';

export class Transport {
  constructor(store, api, config) { this.store = store; this.api = api; this.config = config; this.socket = null; this.draining = false; this.mapping = false; this.nextBroadcastAt = 0; }
  attach(socket) { this.socket = socket; }
  detach(socket) { if (this.socket === socket) this.socket = null; }
  async send(jid, content) {
    const socket = this.socket;
    if (!socket) throw new Error('WhatsApp belum tersambung.');
    const messageId = generateMessageIDV2(socket.user?.id);
    this.store.markOutgoing(messageId);
    if (jid.endsWith('@newsletter') && Buffer.isBuffer(content.image)) return sendNewsletterImage(socket, jid, content, messageId);
    if (content.urlButton) {
      const { label, url } = content.urlButton;
      const message = generateWAMessageFromContent(jid, {
        viewOnceMessage: { message: {
          messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
          interactiveMessage: {
            header: { title: 'MAZY STORE', hasMediaAttachment: false },
            body: { text: content.text },
            footer: { text: 'Uji tombol v2' },
            nativeFlowMessage: { messageParamsJson: '', buttons: [{ name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: label, url, merchant_url: url }) }] },
          },
        } },
      }, { userJid: socket.user?.id, messageId });
      await socket.relayMessage(jid, message.message, {
        messageId,
        additionalNodes: [
          { tag: 'biz', attrs: {}, content: [{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] }] },
          { tag: 'bot', attrs: { biz_bot: '1' } },
        ],
      });
      return message;
    }
    return socket.sendMessage(jid, content, { messageId });
  }
  async text(jid, text, id, context = null) {
    splitMessage(text).forEach((part, index) => this.store.enqueue(`${id}:part${index}`, jid, { kind: 'text', text: part, context }));
  }
  async urlButton(jid, text, label, url, id) {
    const parsed = new URL(url);
    if (!/^\d+@(s\.whatsapp\.net|lid)$/.test(jid) || parsed.protocol !== 'https:' || parsed.username || parsed.password || !text || text.length > 1000 || !label || label.length > 40) throw new Error('Tombol URL tidak valid.');
    this.store.enqueue(id, jid, { kind: 'url_button', text, urlButton: { label, url } });
  }
  async payment(jid, order, id) {
    const { createHash } = await import('node:crypto');
    const version = createHash('sha256').update(this.config.qris).digest('hex');
    if (order.qris_version !== version) throw new Error('QRIS order berbeda dari konfigurasi sekarang. Hubungi admin.');
    this.store.enqueue(id, jid, { kind: 'qris', total: order.total, caption: renderMessage('MAZY STORE · PEMBAYARAN', [`ID: ${order.id}\nMerchant: ${this.config.merchant}\nTotal: Rp${order.total.toLocaleString('id-ID')}`, 'Setelah membayar, ketik /done lalu kirim foto bukti pembayaran.', '/batal: batalkan pesanan']), context: null });
  }
  async image(jid, buffer, caption, context = null) {
    if (!this.socket) throw new Error('WhatsApp belum tersambung.');
    const result = await this.send(jid, { image: buffer, caption });
    if (!result?.key?.id) throw new Error('Pengiriman gambar belum terkonfirmasi.');
    if (context) this.store.enqueue(`ref:${result.key.id}`, jid, { context }, 'mapping', result.key.id);
    return result;
  }
  async drain() {
    if (this.draining || !this.socket) return;
    this.draining = true;
    try {
      let job;
      while (this.socket && (job = this.store.next() || (Date.now() >= this.nextBroadcastAt ? this.store.next('broadcast') : null))) {
        if (job.status === 'broadcast') this.nextBroadcastAt = Date.now() + 5000;
        let content;
        try {
          content = job.payload.kind === 'qris'
            ? { image: await renderQris(generateDynamicQris(this.config.qris, job.payload.total, this.config.merchant)), caption: job.payload.caption }
            : { text: job.payload.text, ...(job.payload.kind === 'url_button' ? { urlButton: job.payload.urlButton } : {}) };
        } catch { this.store.setStatus(job.id, 'uncertain'); continue; }
        this.store.setStatus(job.id, 'sending');
        try {
          const sent = await this.send(job.jid, content);
          if (!sent?.key?.id) throw new Error('No WA message id');
          this.store.saveMessage(sent.key.id, sent.message);
          this.store.setStatus(job.id, job.payload.context ? 'mapping' : 'sent', sent.key.id);
          if (job.payload.kind === 'url_button') await this.text(job.jid, renderMessage('ADMIN · HASIL UJI TOMBOL V2', ['Relay tombol selesai tanpa error. Ini belum membuktikan pesan diterima atau tombol tampil.', 'Jika kartu tombol tidak terlihat di HP, format uji v2 belum bekerja pada koneksi ini. Gunakan link cadangan.']), `${job.id}:result`);
        } catch (error) {
          this.store.setStatus(job.id, 'uncertain');
          if (job.payload.kind === 'url_button') {
            const status = error?.output?.statusCode;
            await this.text(job.jid, renderMessage('ADMIN · HASIL UJI TOMBOL V2', [`Relay tombol gagal. Kode: BUTTON_RELAY_FAILED${Number.isInteger(status) ? `\nHTTP: ${status}` : ''}`, 'Pengiriman tidak diulang otomatis. Gunakan link cadangan.']), `${job.id}:result`);
            continue;
          }
          break;
        }
      }
    } finally { this.draining = false; }
    await this.drainMappings();
  }

  async drainMappings() {
    if (this.mapping) return;
    this.mapping = true;
    try {
      let job;
      while ((job = this.store.next('mapping'))) {
        try {
          if (job.payload.context) await this.api.map({ ...job.payload.context, jid: job.jid, waId: job.wa_id });
          this.store.setStatus(job.id, 'sent');
        } catch { break; }
      }
    } finally { this.mapping = false; }
  }
}
