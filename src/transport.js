import { NavigationPoll } from './poll.js';
import { orderActions } from './admin/actions.js';
import { generateDynamicQris, renderQris } from './qris.js';
import { generateMessageIDV2 } from 'baileys';
import { renderMessage, splitMessage } from './ui.js';
import { sendNewsletterImage } from './newsletter-image.js';

export class Transport {
  constructor(store, api, config) { this.polls=new NavigationPoll(store,this);this.store = store; this.api = api; this.config = config; this.socket = null; this.draining = false; this.mapping = false; this.nextBroadcastAt = 0; }
  attach(socket) { this.socket = socket; }
  detach(socket) { if (this.socket === socket) this.socket = null; }
  async send(jid, content, fixedMessageId = null) {
    const socket = this.socket;
    if (!socket) throw new Error('WhatsApp belum tersambung.');
    const messageId = fixedMessageId || generateMessageIDV2(socket.user?.id);
    this.store.markOutgoing(messageId);
    if (jid.endsWith('@newsletter') && Buffer.isBuffer(content.image)) return sendNewsletterImage(socket, jid, content, messageId);
    return socket.sendMessage(jid, content, { messageId });
  }
  async text(jid, text, id, context = null) {
    if(context?.orderId && jid===this.config.adminJid && context.kind!=='menu')return this.orderNavigation(jid,text,context.orderId);
    if(context?.orderId && context.role==='admin' && jid!==this.config.adminJid) {
      const order=await this.api.order(context.orderId);
      if(order.status==='refund_pending' && !order.refund_accepted)return this.polls.create(jid,{buyer:order.buyer,route:'command',orderId:order.id,question:text.replace(/\/setujui[^\n]*/g,'Pilih Setujui refund pada polling.'),options:[{label:'Setujui refund',command:'/setujui'},{label:'Hubungi admin',command:'/chat'}]});
    }
    splitMessage(text).forEach((part, index) => this.store.enqueue(`${id}:part${index}`, jid, { kind: 'text', text: part, context }));
  }
  async orderNavigation(jid,text,orderId) {
    const order=await this.api.order(orderId);
    const question=text.split('\n').filter(line=>!/^\s*(Reply|\/(setujui|tolakbukti|batal|selesaikan|selesai|refund|lanjutkan))/.test(line)).join('\n');
    return this.polls.create(jid,{buyer:this.config.adminJid,route:'order',orderId,status:order.status,question,options:orderActions(order)});
  }
  async payment(jid, order, id) {
    const { createHash } = await import('node:crypto');
    const version = createHash('sha256').update(this.config.qris).digest('hex');
    if (order.qris_version !== version) throw new Error('QRIS order berbeda dari konfigurasi sekarang. Hubungi admin.');
    this.store.enqueue(id, jid, { kind: 'qris', total: order.total, caption: renderMessage('MAZY STORE · PEMBAYARAN', [`ID: ${order.id}\nMerchant: ${this.config.merchant}\nTotal: Rp${order.total.toLocaleString('id-ID')}`, 'Setelah membayar, pilih Sudah Bayar pada polling lalu kirim foto bukti pembayaran.', '/batal: batalkan pesanan']), context: null });
  }
  async image(jid, buffer, caption, context = null) {
    if (!this.socket) throw new Error('WhatsApp belum tersambung.');
    const result = await this.send(jid, { image: buffer, caption });
    if (!result?.key?.id) throw new Error('Pengiriman gambar belum terkonfirmasi.');
    if (context) this.store.enqueue(`ref:${result.key.id}`, jid, { context }, 'mapping', result.key.id);
    if(context?.orderId && jid===this.config.adminJid)await this.orderNavigation(jid,'BUKTI PEMBAYARAN\n'+caption,context.orderId);
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
            : { text: job.payload.text };
        } catch { this.store.setStatus(job.id, 'uncertain'); continue; }
        this.store.setStatus(job.id, 'sending');
        try {
          if (job.payload.kind === 'delivery') {
            try { await this.api.delivery(job.payload.orderId,{mode:'start',part:job.payload.part}); }
            catch(error) {
              this.store.setStatus(job.id,error.status===409?'retired':'uncertain');
              continue;
            }
          }
          const sent = await this.send(job.jid, content, job.payload.waId);
          if (!sent?.key?.id) throw new Error('No WA message id');
          if(job.payload.kind==='delivery' && sent.key.id!==job.payload.waId)throw new Error('Unexpected delivery message id');
          this.store.saveMessage(sent.key.id, sent.message);
          this.store.setStatus(job.id, job.payload.context ? 'mapping' : 'sent', sent.key.id);
          if(job.payload.kind==='delivery')await this.api.delivery(job.payload.orderId,{mode:'sent',waId:job.payload.waId});
        } catch {
          this.store.setStatus(job.id, 'uncertain');
          if(job.payload.kind==='delivery') {
            try {await this.api.delivery(job.payload.orderId,{mode:'uncertain',waId:job.payload.waId});}catch { /* D1 retains sending until the next inspection. */ }
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
