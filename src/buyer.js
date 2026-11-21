import { createHash } from 'node:crypto';
import { renderMessage, numbered } from './ui.js';
import { claimMessage, helpMessage } from './contact.js';
import { statusLabels, money, orderStatus } from './admin/render.js';

export const labels = statusLabels;
const orderText = o => `ID Pesanan: ${o.id}\nProduk: ${o.product}\nVarian: ${o.variant}\nJumlah: ${o.quantity}\nHarga satuan: ${money(o.unit_price)}\nTotal: ${money(o.total)}\nStatus: ${orderStatus(o)}${o.cancel_requested ? '\nAda permintaan pembatalan.' : ''}`;

export class BuyerNavigation {
  constructor(api, transport, config) { this.api = api; this.transport = transport; this.config = config; this.adminNumber = config.adminNumber || config.adminJid.split('@')[0]; }

  async handle(message) {
    let sequence = 0;
    const api = this.api;
    const event = `${message.jid}:${message.id}`;
    const say = (text, jid = message.jid, context = null) => this.transport.text(jid, text, `${event}:${sequence++}`, context);
    const c = await api.customer(message.buyer);
    if (c.session.chat !== undefined || c.session.chatOrderId !== undefined) {
      const { chat, chatOrderId, ...state } = c.session;
      await api.session(c.buyer, state);
      c.session = state;
    }
    const text = message.text.trim();
    const command = text.split(/\s+/)[0].toLowerCase();
    const context = { buyer: c.buyer, orderId: c.order?.id || null, role: 'buyer', kind: 'relay', purpose: 'transaction' };
    const notice = value => say(value, this.config.adminJid, context);
    const save = async state => { c.session = { ...state, buyerUiVersion: 4 }; await api.session(c.buyer, c.session); };
    const action = (name, extra = {}) => api.action(c.order.id, { action: name, key: `${event}:${name}`, actor: c.buyer, ...extra });
    const info = (value, title = 'MAZY STORE · INFO') => say(renderMessage(title, [value]));
    const help = () => say(helpMessage(this.adminNumber));
    const active = async () => {
      if (!c.order) return info('Tidak ada pesanan aktif. Ketik /menu untuk belanja atau /chat untuk menghubungi admin.');
      await say(renderMessage('MAZY STORE · PESANAN', [orderText(c.order), c.order.status === 'awaiting_payment' ? 'Setelah membayar, ketik /done.' : c.order.status === 'awaiting_proof' ? 'Kirim foto bukti pembayaran.' : c.order.status === 'review' ? 'Bukti sedang diperiksa admin.' : c.order.status === 'refund_pending' ? c.order.refund_accepted ? 'Refund sudah kamu setujui. Tunggu admin mengembalikan uang.\n/chat - Hubungi admin' : 'Admin menawarkan refund. Uang belum dikembalikan.\n/setujui - Setujui refund agar admin mengembalikan uang\n/chat - Hubungi admin jika belum sepakat' : 'Penyerahan barang dilakukan melalui chat pribadi admin.', ['awaiting_payment','awaiting_proof','review'].includes(c.order.status) ? '/batal - Batalkan pesanan langsung' : '']));
      if (c.order.status === 'awaiting_payment') await this.transport.payment(c.buyer, c.order, `${event}:payment`);
      if (c.order.status === 'processing') await say(await claimMessage(api, this.adminNumber, c.order));
    };
    const options = async (title, sections, state, entries) => {
      await save({ ...state, options: entries });
      return say(renderMessage(title, [...sections, numbered(entries), `*${state.stage === 'menu' ? 'CARA PILIH PRODUK' : 'PILIHAN'}*\nBalas angka *1 sampai ${entries.length}* untuk memilih.\n/chat - Hubungi admin`]));
    };
    const menu = async () => {
      const { categories, variants } = await api.catalog();
      const entries = categories.map(cat => {
        const rows = variants.filter(v => v.category_id === cat.id && !v.archived);
        const ready = rows.filter(v => v.ready);
        const prices = ready.length > 2 ? `Mulai ${money(Math.min(...ready.map(v => v.price)))}` : ready.map(v => `${v.name} · ${money(v.price)}`).join('\n');
        return { type: 'category', id: cat.id, label: `${cat.name}\n${prices || 'Belum tersedia'}` };
      });
      entries.push({ type: 'order', label: 'Pesanan saya' }, { type: 'help', label: 'Hubungi admin' });
      return options('MAZY STORE · MENU', ['*KATALOG PRODUK DIGITAL & AI*'], { stage: 'menu' }, entries);
    };
    const variants = async (categoryId) => {
      const catalog = await api.catalog();
      const cat = catalog.categories.find(row => row.id === categoryId);
      if (!cat) return menu();
      const rows = catalog.variants.filter(v => v.category_id === categoryId && !v.archived);
      const entries = rows.map(v => ({ type: 'variant', id: v.id, label: `${v.name}\n${money(v.price)} · ${v.ready ? 'Ready' : 'Kosong'}\n*Deskripsi*\n${v.terms}` }));
      entries.push({ type: 'home', label: 'Kembali ke katalog' }, { type: 'help', label: 'Hubungi admin' });
      return options(cat.name, [rows.length ? '' : 'Belum ada varian.'], { stage: 'variant', categoryId }, entries);
    };
    const quantity = async state => {
      const v = (await api.catalog()).variants.find(row => row.id === state.variantId && !row.archived);
      if (!v?.ready) { await menu(); return info('Varian sedang Kosong. Pilih produk lain.'); }
      await save({ stage: 'quantity', variantId: v.id, categoryId: v.category_id, price: v.price, terms: v.terms });
      return say(renderMessage('MAZY STORE · JUMLAH', [`${v.name}\nHarga satuan: ${money(v.price)}\n*Deskripsi*\n${v.terms}`, `Masukkan kuantitas 1–${this.config.maxQuantity}.`, '/kembali: pilih varian\n/menu: katalog utama']));
    };
    if (command === '/menu' || command === '/start') return menu();
    if (command === '/pesanan') return active();
    if (command === '/chat') return help();
    if (command === '/akhirichat') return info('Komunikasi sekarang langsung ke WA admin. Ketik /chat untuk link kontak, atau /menu untuk katalog.');
    if (command === '/batal') {
      if (!c.order) return info('Tidak ada pesanan aktif.');
      if (['awaiting_payment','awaiting_proof','review'].includes(c.order.status)) {
        const updated = await action('cancel');
        await save({ stage: 'menu' });
        await notice(renderMessage('ORDER DIBATALKAN BUYER', [orderText(updated)]));
        return info('Pesanan dibatalkan. Jika sudah terlanjur membayar, ketik /chat dan kirim bukti langsung ke admin.');
      }
      return info('Pembayaran sudah disetujui sehingga pesanan tidak bisa dibatalkan. Refund harus ditawarkan admin dan disetujui buyer.\n/pesanan - Lihat status refund\n/chat - Hubungi admin');
    }
    if (command === '/setujui') {
      if (!c.order || c.order.status !== 'refund_pending') return info('Belum ada penawaran refund untuk disetujui. Ketik /pesanan untuk melihat status.');
      if (c.order.refund_accepted) return info('Refund sudah kamu setujui. Tunggu admin mengembalikan uang.\n/chat - Hubungi admin');
      const updated = await action('accept_refund', { expectedVersion: c.order.version });
      await notice(renderMessage('ADMIN · REFUND', [orderText(updated), 'Buyer sudah menyetujui refund. Kembalikan uang melalui chat pribadi buyer, lalu reply pesan ini:\n/selesai - Tandai uang sudah dikembalikan']));
      return info('Refund sudah kamu setujui. Uang belum dikembalikan; tunggu admin memproses pengembalian uang.\n/chat - Hubungi admin');
    }
    if (command === '/done') {
      if (!c.order) return info('Belum ada order aktif. Ketik /menu.');
      if (c.order.status === 'awaiting_payment') {
        const updated = await action('done');
        await notice(renderMessage('MENUNGGU BUKTI BAYAR', [orderText(updated), 'Buyer mengetik /done. Tunggu foto bukti dan periksa uang masuk.', 'Reply bukti: /setujui\n/batal - Batalkan pesanan']));
      }
      else if (c.order.status !== 'awaiting_proof') return active();
      return say(renderMessage('MAZY STORE · BUKTI BAYAR', [`ID Pesanan: ${c.order.id}`, 'Kirim foto bukti pembayaran. Pembayaran baru dianggap lunas setelah diperiksa admin.\n/batal - Batalkan pesanan langsung']));
    }
    if (message.image) {
      if (c.order?.status === 'awaiting_payment') return info('Ketik /done terlebih dahulu, kemudian kirim ulang foto bukti pembayaran.');
      if (c.order?.status === 'awaiting_proof' || c.order?.status === 'review' && (c.order.proof_relay !== 'sent' || c.order.cancel_requested)) {
        const buffer = await message.image();
        if (c.order.status === 'awaiting_proof') await action('submit_proof');
        let caption = renderMessage('BUKTI PEMBAYARAN', [`ID: ${c.order.id}\nBuyer: ${c.buyer.split('@')[0]}\nProduk: ${c.order.product}\nVarian: ${c.order.variant}\nJumlah: ${c.order.quantity}\nTotal: ${money(c.order.total)}`, 'Reply foto ini:\n/setujui\n/tolakbukti alasan\n/batal - Batalkan pesanan']);
        if (caption.length > 1000) caption = renderMessage('BUKTI PEMBAYARAN', [`ID: ${c.order.id}\nBuyer: ${c.buyer.split('@')[0]}\nTotal: ${money(c.order.total)}`, 'Reply: /setujui\n/batal - Batalkan pesanan']);
        await this.transport.image(this.config.adminJid, buffer, caption, context);
        await action('proof_sent');
        return info('Bukti berhasil diteruskan. Menunggu verifikasi pembayaran oleh admin.\n/batal - Batalkan pesanan langsung');
      }
      if (c.order?.status === 'review') return info('Bukti sudah diteruskan dan menunggu verifikasi.\n/batal - Batalkan pesanan langsung\n/chat - Hubungi admin');
      return say(helpMessage(this.adminNumber));
    }
    if (command === '/kembali') {
      if (c.order) return menu();
      if (c.session.stage === 'quantity') return variants(c.session.categoryId);
      return menu();
    }
    if (command.startsWith('/')) return info('Perintah tersedia:\n/menu: katalog\n/pesanan: status order\n/done: sudah membayar\n/batal: batalkan sebelum pembayaran disetujui\n/setujui: setujui penawaran refund\n/chat: link WA admin');
    if (c.session.buyerUiVersion !== 4) return menu();
    const state = c.session;
    if (state.stage === 'quantity' && !c.order) {
      if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < 1 || Number(text) > this.config.maxQuantity) return info(`Masukkan jumlah bulat 1–${this.config.maxQuantity}.\n/kembali: pilih varian\n/menu: katalog`);
      const v = (await api.catalog()).variants.find(row => row.id === state.variantId && !row.archived);
      if (!v?.ready) { await menu(); return info('Varian sedang Kosong.'); }
      if (v.price !== state.price || v.terms !== state.terms) {
        await quantity(state);
        return info('Harga atau deskripsi berubah. Masukkan ulang kuantitas untuk menggunakan harga terbaru.');
      }
      const order = await api.createOrder({ key: event, buyer: c.buyer, variantId: v.id, quantity: Number(text), expectedPrice: state.price, expectedTerms: state.terms, qrisVersion: createHash('sha256').update(this.config.qris).digest('hex') });
      await say(renderMessage('MAZY STORE · PESANAN', [orderText(order)]));
      await this.transport.payment(c.buyer, order, `${event}:payment`);
      await say(renderMessage('ORDER BARU', [orderText(order), 'Buyer belum diverifikasi membayar.\nReply pesan ini dengan /batal untuk membatalkan.']), this.config.adminJid, { ...context, orderId: order.id });
      await save({ stage: 'ordered' });
      return;
    }
    const option = /^\d+$/.test(text) ? state.options?.[Number(text) - 1] : null;
    if (option?.type === 'home') return menu();
    if (option?.type === 'help') return help();
    if (option?.type === 'order') return active();
    if (c.order) return active();
    if (option?.type === 'category') return variants(option.id);
    if (option?.type === 'variant') return quantity({ variantId: option.id });
    if (option?.type === 'quantity') return quantity(state);
    return info('Pilihan tidak valid. Gunakan angka pada menu terakhir.\n/menu: buka katalog\n/kembali: langkah sebelumnya');
  }
}
