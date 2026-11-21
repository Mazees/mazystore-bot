import { randomUUID } from 'node:crypto';
import { screen, orderDetails, variantDetails, money, phone, date, statusLabels } from './render.js';
import { orderActions, actionLabels, requiresReason, executeOrderAction, notifyOrderAction } from './actions.js';
import { buyerContact, waLink } from '../contact.js';
import { renderMessage } from '../ui.js';

const TTL = 30 * 60000;
const UI_VERSION = 6;
const shortcuts = { '/setujui': 'approve', '/selesaikan': 'complete', '/selesai': 'complete', '/tolakbukti': 'reject_proof', '/batal': 'cancel', '/batalkan': 'cancel', '/refund': 'refund', '/refundselesai': 'refund_complete', '/lanjutkan': 'clear_cancel' };
const legacy = new Set(['/produk','/tambahvarian','/ubahvarian','/harga','/ready','/order','/setujui','/tolakbukti','/selesai','/batalkan','/refund','/refundselesai','/lanjutkan','/balas','/gagalkirim','/ulang','/batalsetup']);
const groupLabels = { all: 'Semua pesanan', review: 'Menunggu verifikasi', processing: 'Sedang diproses', cancellation: 'Permintaan pembatalan', refund: 'Refund', ...statusLabels };
const locationKeys = ['screen','page','filter','categoryId','variantId','orderId','draft','step','pending','version','back'];
const location = state => Object.fromEntries(locationKeys.filter(key => state[key] !== undefined).map(key => [key, key === 'back' ? location(state.back) : state[key]]));
const child = (state, next) => ({ ...next, back: location(state) });

export class AdminNavigation {
  constructor(api, transport, local, runtime = () => ({}), config = {}, reportError = () => {}) {
    this.api = api; this.transport = transport; this.local = local; this.runtime = runtime;
    this.adminNumber = config.adminNumber || config.adminJid?.split('@')[0];
    this.reportError = reportError;
  }

  async unavailable(message) {
    const counts = this.local.outboxSummary?.() || {};
    return this.transport.text(message.jid, screen('Admin › Koneksi', `Worker/D1 belum dapat diakses.\nKode: API_NETWORK\nWhatsApp: ${this.runtime().whatsapp ? 'Terhubung' : 'Belum terhubung'}\nAntrean keluar: ${counts.pending || 0}\n\nPeriksa status pesanan sebelum mengulang tindakan. Coba /admin setelah koneksi pulih.`, { root: true }), `${message.jid}:${message.id}:admin:offline`);
  }

  async failure(message, error, state) {
    const code = error.code?.startsWith('API_') ? error.code : error.status ? 'API_HTTP' : 'ADMIN_INTERNAL';
    const source = error.stack?.split('\n').slice(1).join('\n').match(/\/src\/[a-zA-Z0-9_./-]+\.js:\d+:\d+/)?.[0];
    this.reportError({ code, status: error.status || 0, screen: state?.screen || 'entry', errorType: error.name || 'Error', ...(source ? { source } : {}) });
    if (code === 'API_NETWORK') return this.unavailable(message);
    const detail = code === 'ADMIN_INTERNAL'
      ? 'Terjadi error pada menu admin. Gangguan ini belum menunjukkan D1 bermasalah.'
      : code === 'API_RESPONSE' ? 'Respons Worker tidak sesuai. Periksa WORKER_URL dan status Worker.'
      : error.status === 401 || error.status === 403 ? 'Worker menolak akses. Periksa kesesuaian API_SECRET di panel dan Worker.'
      : error.status >= 500 ? 'Worker melaporkan gangguan layanan. Periksa status pesanan sebelum mengulang.'
      : error.message;
    return this.transport.text(message.jid, renderMessage('ADMIN · PERMINTAAN GAGAL', [`Kode: ${code}${error.status ? `\nHTTP: ${error.status}` : ''}`, detail, 'Ketik /admin untuk membuka ulang menu. Periksa status pesanan sebelum mengulang tindakan.']), `${message.jid}:${message.id}:admin:failure`);
  }

  async handle(message, owner) {
    let sequence = 0;
    const event = `${message.jid}:${message.id}`;
    const ctx = {
      owner, message, state: owner.session.admin,
      send: (jid, text, context) => this.transport.text(jid, text, `${event}:admin:${sequence++}`, context),
      save: async state => { ctx.state = state; await this.api.session(owner.buyer, { ...owner.session, admin: state }); },
    };
    const text = message.text.trim();
    const command = text.split(/\s+/)[0].toLowerCase();
    try {
      if (['/admin','/menu','/start'].includes(command)) return await this.show(ctx, { screen: 'home' });
      if (shortcuts[command] && (command !== '/batal' || message.quotedId)) return await this.shortcut(ctx, command, text.slice(command.length).trim(), event);
      if (message.quotedId) {
        let ref;
        try { ref = await this.api.message(owner.buyer, message.quotedId); }
        catch (error) {
          if (error.status !== 404) throw error;
          return await ctx.send(message.jid, renderMessage('ADMIN · KONTAK', ['Referensi tidak dikenali. Tidak ada pesan yang diteruskan.', 'Buka /admin → Pesanan & pembayaran → pilih pesanan → Hubungi buyer.']), null);
        }
        if (ref.kind !== 'menu') return await this.contact(ctx, ref.buyer, ref.order_id);
        if (!ctx.state || ctx.state.uiVersion !== UI_VERSION || Date.now() - ctx.state.at > TTL) return await this.show(ctx, { screen: 'home' }, 'Menu diperbarui atau sesi berakhir. Mulai dari sini.');
        if (ref.menu_token !== ctx.state.token) return await this.show(ctx, ctx.state, 'Menu yang dibalas sudah lama. Pilih dari menu terbaru.');
      }
      if (legacy.has(command)) {
        const target = ['/produk','/tambahvarian','/ubahvarian','/harga','/ready','/batalsetup'].includes(command) ? 'Kelola katalog' : ['/gagalkirim','/ulang'].includes(command) ? 'Status bot & pengiriman' : 'Pesanan & pembayaran';
        const view = ctx.state?.uiVersion === UI_VERSION && Date.now() - ctx.state.at <= TTL ? ctx.state : { screen: 'home' };
        return await this.show(ctx, view, `Perintah lama tidak dijalankan. Buka /admin → ${target}.`);
      }
      if (!ctx.state || ctx.state.uiVersion !== UI_VERSION || Date.now() - ctx.state.at > TTL) return await this.show(ctx, { screen: 'home' }, 'Pilihan dan draft lama sudah berakhir. Mulai dari sini.');
      if (command === '/kembali' || command === '/batal') return await this.show(ctx, ctx.state.back || { screen: 'home' });
      if (message.image) return await this.show(ctx, ctx.state, 'Gambar dan pesan dikirim langsung melalui WA buyer, bukan bot.');
      if (ctx.state.screen === 'broadcastInput') {
        if (!text || text.length > 2000) return await this.show(ctx, ctx.state, 'Pesan broadcast wajib 1–2000 karakter.');
        return await this.apply(ctx, child(ctx.state, { pending: { kind: 'broadcast', key: ctx.state.draft.key, text } }));
      }
      if (ctx.state.screen === 'input') return await this.input(ctx, text, event);
      if (ctx.state.screen === 'add') return await this.addInput(ctx, text);
      if (ctx.state.screen === 'addCategory') return await this.categoryInput(ctx, text);
      if (ctx.state.screen === 'renameCategory') return await this.renameCategoryInput(ctx, text);
      const option = ctx.state.options?.[/^\d+$/.test(text) ? String(Number(text)) : text];
      if (!option) return await this.show(ctx, ctx.state, 'Pilihan tidak valid. Gunakan angka yang ditampilkan.');
      return await this.select(ctx, option, event);
    } catch (error) {
      if (error.status === 409) {
        const s = ctx.state;
        if (s?.pending?.kind === 'category') return this.show(ctx, s.back || { screen: 'categories', page: 0 }, error.message);
        if (s?.pending?.kind === 'categoryEdit') return this.show(ctx, { screen: 'variants', categoryId: s.categoryId, page: 0, back: { screen: 'categories', page: 0 } }, error.message);
        const target = s?.orderId ? { screen: 'order', orderId: s.orderId, back: { screen: 'orders', filter: 'all', page: 0 } } : s?.variantId ? { screen: 'variant', variantId: s.variantId, categoryId: s.categoryId, back: { screen: 'variants', categoryId: s.categoryId, page: 0 } } : { screen: 'home' };
        return this.show(ctx, target, 'Data sudah berubah. Periksa detail terbaru dan pilih tindakan lagi.');
      }
      return this.failure(message, error, ctx.state);
    }
  }

  async contact(ctx, buyer, orderId = null) {
    const content = orderId
      ? buyerContact(await this.api.order(orderId))
      : renderMessage('ADMIN · HUBUNGI BUYER', [`Nomor: ${phone(buyer)}`, 'Klik link untuk chat langsung. Pesan dan gambar tidak diteruskan oleh bot.']) + '\n\n' + waLink(buyer, 'Halo, saya admin Mazy Store.');
    await ctx.send(ctx.message.jid, content, null);
  }

  async shortcut(ctx, command, reason, event) {
    if (command === '/batal' && !reason) reason = 'Dibatalkan admin.';
    const reply = text => ctx.send(ctx.message.jid, renderMessage('ADMIN · SHORTCUT', [text]), null);
    if (!ctx.message.quotedId) return reply(`Reply notifikasi order atau bukti pembayaran dengan ${command}${requiresReason(shortcuts[command]) ? ' alasan' : ''}. ID tidak perlu diketik.`);
    let ref = this.local.messageReference?.(ctx.message.jid, ctx.message.quotedId);
    if (!ref) {
      try { ref = await this.api.message(ctx.owner.buyer, ctx.message.quotedId); }
      catch (error) { if (error.status !== 404) throw error; }
    }
    if (!ref?.order_id || ref.kind === 'menu') return reply('Pesan yang dibalas tidak memiliki referensi order. Reply notifikasi order atau foto bukti pembayaran dari bot.');
    const order = await this.api.order(ref.order_id);
    if (order.buyer !== ref.buyer) return reply('Referensi buyer tidak cocok dengan order. Tidak ada perubahan.');
    const action = shortcuts[command];
    if (!orderActions(order).some(option => option.id === action)) return reply(`ID: ${order.id}\nStatus: ${statusLabels[order.status]}\nTindakan ${command} tidak tersedia untuk status ini. Tidak ada perubahan.`);
    if (requiresReason(action) && (!reason || reason.length > 2000)) return reply(`Reply pesan yang sama dengan ${command} alasan (1–2000 karakter).`);
    const pending = { action, reason: requiresReason(action) ? reason : '', key: `${event}:order:${action}`, version: order.version };
    const updated = await executeOrderAction(this.api, order, pending);
    await notifyOrderAction(updated, pending, ctx.send, this.adminNumber);
    return ctx.send(ctx.message.jid, renderMessage('ADMIN · PESANAN', [`ID: ${updated.id}\nBuyer: ${phone(updated.buyer)}\nStatus: ${statusLabels[updated.status]}`, updated.status === 'processing' ? '/selesaikan jika pesanan sudah selesai di proses' : ['awaiting_payment','awaiting_proof','review'].includes(updated.status) ? 'Reply /batal untuk membatalkan pesanan.' : '']), { buyer: updated.buyer, orderId: updated.id, role: 'admin', kind: 'relay', purpose: 'transaction' });
  }

  async apply(ctx, state) {
    ctx.state = state;
    return this.execute(ctx);
  }

  async show(ctx, view, notice = '') {
    const s = { ...view, uiVersion: UI_VERSION, at: Date.now(), token: randomUUID(), options: {}, hasNext: false };
    const menu = [];
    let path = 'Admin';
    let body;
    const choices = entries => {
      menu.push(...entries);
      return '';
    };
    const list = (items, label, type) => choices(items.map(item => ({ id: item.id || item.conversation_id, type, label: label(item) })));
    if (s.screen === 'home') {
      const summary = await this.api.adminSummary();
      body = `*PERLU DITANGANI*\nPembayaran: *${summary.review}* menunggu verifikasi\nPembatalan: *${summary.cancellations}* permintaan\nSedang diproses: *${summary.processing}* pesanan\n\n${choices([
        { type: 'go', screen: 'orderGroups', label: 'Pesanan & pembayaran' },
        { type: 'go', screen: 'categories', page: 0, label: 'Kelola katalog' },
        { type: 'go', screen: 'system', label: 'Status bot & pengiriman' },
        { type: 'go', screen: 'broadcast', label: 'Broadcast pelanggan' },
      ])}`;
    } else if (s.screen === 'broadcast') {
      path += ' › Broadcast';
      const counts = this.local.broadcastSummary();
      body = `Broadcast teks ke pelanggan yang tercatat pernah chat bot.\nNomor admin dan bot dikecualikan.\n\nAntrean: ${counts.pending}\nTerkirim ke WA: ${counts.sent}\nPerlu diperiksa: ${counts.uncertain}\n\nRingkasan kiriman tersimpan 24 jam; bukan tanda dibaca.`;
      choices([{ type: 'newBroadcast', label: 'Tulis broadcast' }, { type: 'refresh', label: 'Perbarui status' }, ...(counts.pending ? [{ type: 'cancelBroadcast', label: 'Hentikan sisa antrean broadcast' }] : [])]);
    } else if (s.screen === 'broadcastInput') {
      path += ' › Broadcast › Tulis pesan';
      body = 'Ketik pesan broadcast (1–2000 karakter).\nSaat ini mendukung teks saja.\n\nPesan langsung masuk antrean setelah dikirim di sini. /kembali untuk batal.';
    } else if (s.screen === 'orderGroups') {
      path += ' › Pesanan & pembayaran';
      body = choices([
        ...[['review','Menunggu verifikasi'],['processing','Sedang diproses'],['cancellation','Permintaan pembatalan'],['refund','Refund']].map(([filter,label]) => ({ type: 'go', screen: 'orders', page: 0, filter, label })),
        { type: 'go', screen: 'filters', page: 0, label: 'Semua pesanan & riwayat' },
      ]);
    } else if (s.screen === 'filters') {
      path += ' › Pesanan › Filter';
      const filters = [['all','Semua status'],['awaiting_payment','Belum membayar'],['awaiting_proof','Menunggu bukti'],['review','Menunggu verifikasi'],['processing','Sedang diproses'],['refund','Menunggu refund'],['completed','Selesai'],['cancelled','Dibatalkan'],['refunded','Refund selesai']];
      const page = filters.slice(s.page * 5, s.page * 5 + 5);
      s.hasNext = (s.page + 1) * 5 < filters.length;
      body = choices(page.map(([filter,label]) => ({ type: 'go', screen: 'orders', filter, page: 0, label })));
    } else if (s.screen === 'orders') {
      path += ` › Pesanan › ${groupLabels[s.filter]}`;
      const page = await this.api.adminOrders(s.filter, s.page || 0);
      s.hasNext = page.hasNext;
      list(page.items, o => o.id, 'order');
      body = page.items.length ? '' : 'Belum ada pesanan pada daftar ini.';
    } else if (s.screen === 'order') {
      const order = await this.api.order(s.orderId);
      s.version = order.version;
      path += ' › Pesanan › Detail';
      body = `${orderDetails(order)}${order.status === 'review' ? '\nPeriksa uang masuk sebelum menyetujui.\n' : ''}\n${choices(orderActions(order).map(a => ({ ...a, type: 'orderAction' })))}`;
    } else if (s.screen === 'categories' || s.screen === 'variants' || s.screen === 'variant') {
      const { categories, variants } = await this.api.catalog();
      const category = categories.find(c => c.id === s.categoryId);
      path += ' › Katalog';
      if (s.screen === 'categories') {
        const rows = categories.slice(s.page * 5, s.page * 5 + 5);
        s.hasNext = (s.page + 1) * 5 < categories.length;
        body = list(rows, c => `${c.name} (${variants.filter(v => v.category_id === c.id && !v.archived).length})`, 'category');
        choices([{ type: 'addCategory', label: 'Tambah katalog' }]);
      } else if (s.screen === 'variants') {
        if (!category) return this.show(ctx, { screen: 'categories', page: 0, back: { screen: 'home' } }, 'Katalog sudah dihapus atau tidak tersedia.');
        s.categoryVersion = category.version;
        path = `${category.name} (${variants.filter(v => v.category_id === s.categoryId && !v.archived).length})`;
        const rows = variants.filter(v => v.category_id === s.categoryId && !v.archived);
        s.hasNext = (s.page + 1) * 5 < rows.length;
        list(rows.slice(s.page * 5, s.page * 5 + 5), v => `${v.name} · ${money(v.price)}\nStatus: ${v.ready ? 'Ready' : 'Kosong'}`, 'variant');
        body = rows.length ? '' : 'Belum ada varian.';
        choices([{ type: 'addVariant', label: 'Tambah varian' }, { type: 'renameCategory', label: 'Ubah nama katalog' }, { type: 'deleteCategory', label: 'Hapus katalog' }]);
      } else {
        const variant = variants.find(v => v.id === s.variantId);
        if (!variant) throw Object.assign(new Error('Varian tidak ditemukan.'), { status: 404 });
        s.categoryId = variant.category_id;
        s.version = variant.version;
        path += ` › ${categories.find(c => c.id === variant.category_id).name} › Detail`;
        body = `${variantDetails(variant)}\n\n${choices([
          { type: 'edit', id: 'price', label: 'Ubah harga' }, { type: 'edit', id: 'name', label: 'Ubah nama' }, { type: 'edit', id: 'terms', label: 'Ubah deskripsi' },
          { type: 'variantAction', id: 'ready', ready: !variant.ready, label: variant.ready ? 'Tandai Kosong' : 'Tandai Ready' },
          { type: 'variantAction', id: 'delete', label: 'Hapus varian permanen' },
        ])}`;
      }
    } else if (s.screen === 'addCategory') {
      path += ' › Katalog › Tambah katalog';
      body = 'Ketik nama katalog baru.\nContoh: CANVA PRO\n\nMaksimal 80 karakter. Varian ditambahkan setelah katalog disimpan.';
    } else if (s.screen === 'renameCategory') {
      path += ' › Katalog › Ubah nama';
      body = `Nama sekarang: ${s.pending.oldName}\n\nKetik nama baru (1–80 karakter).`;
    } else if (s.screen === 'input') {
      path += s.orderId ? ' › Pesanan › Alasan' : ' › Katalog › Ubah varian';
      body = s.orderId ? `${actionLabels[s.pending.action]}\nOrder: ${s.orderId}\n\nKetik alasan (1–2000 karakter).` : s.pending.field === 'price' ? 'Ketik harga baru dalam rupiah, angka saja.\nContoh: 90000' : `Ketik ${s.pending.field === 'name' ? 'nama baru (maksimal 120 karakter)' : 'deskripsi baru (maksimal 2000 karakter)'}.`;
    } else if (s.screen === 'add') {
      path += ' › Katalog › Tambah varian';
      body = { name: 'Langkah 1/3\nKetik nama varian (maksimal 120 karakter).', price: `Langkah 2/3\nNama: ${s.draft.name}\n\nKetik harga dalam rupiah, angka saja.`, terms: `Langkah 3/3\n${s.draft.name} · ${money(s.draft.price)}\n\nKetik deskripsi (maksimal 2000 karakter).` }[s.step];
    } else if (s.screen === 'system') {
      path += ' › Status bot & pengiriman';
      await this.api.adminSummary();
      const runtime = this.runtime();
      const counts = this.local.outboxSummary();
      body = `WhatsApp: ${runtime.whatsapp ? '🟢 Terhubung' : '⚪ Belum terhubung'}\nD1: 🟢 Terjangkau\nAntrean keluar: ${counts.pending}\nHasil kirim meragukan: ${counts.uncertain}\n\n${choices([{ type: 'go', screen: 'uncertain', page: 0, label: 'Periksa pengiriman meragukan' }, { type: 'refresh', label: 'Perbarui status' }])}`;
    } else if (s.screen === 'uncertain') {
      path += ' › Pengiriman › Perlu diperiksa';
      const page = this.local.uncertainPage(s.page || 0);
      s.hasNext = page.hasNext;
      list(page.items, job => `${phone(job.jid)}\n${date(new Date(job.created).toISOString())}`, 'retry');
      body = page.items.length ? 'Memilih pesan langsung mengirim ulang. Pesan sebelumnya mungkin sudah sampai; periksa chat tujuan dulu.' : 'Tidak ada pengiriman meragukan.';
    }
    if (body === undefined) return this.show(ctx, { screen: 'home' });
    const input = s.screen === 'input' || s.screen === 'add' || s.screen === 'addCategory' || s.screen === 'renameCategory' || s.screen === 'broadcastInput';
    if (!input) {
      if (s.page > 0) menu.push({ type: 'page', delta: -1, label: 'Halaman sebelumnya' });
      if (s.hasNext) menu.push({ type: 'page', delta: 1, label: 'Halaman berikutnya' });
      if (s.screen !== 'home') menu.push({ type: 'back', label: 'Kembali' }, { type: 'home', label: 'Beranda' });
    }
    s.options = Object.fromEntries(menu.map((option, index) => [String(index + 1), option]));
    await ctx.save(s);
    await ctx.send(ctx.message.jid, screen(path, body.trim(), { page: s.page, root: s.screen === 'home', notice, input, options: menu }), { buyer: ctx.owner.buyer, role: 'admin', kind: 'menu', menuToken: s.token });
  }

  async select(ctx, option, event) {
    const s = ctx.state;
    if (option.type === 'back') return this.show(ctx, s.back || { screen: 'home' });
    if (option.type === 'home') return this.show(ctx, { screen: 'home' });
    if (option.type === 'page') return this.show(ctx, { ...location(s), page: (s.page || 0) + option.delta });
    if (option.type === 'go') {
      const { type, label, ...next } = option;
      return this.show(ctx, child(s, next));
    }
    if (option.type === 'refresh') return this.show(ctx, location(s));
    if (option.type === 'newBroadcast') return this.show(ctx, child(s, { screen: 'broadcastInput', draft: { key: randomUUID() } }));
    if (option.type === 'cancelBroadcast') return this.apply(ctx, child(s, { pending: { kind: 'cancelBroadcast' } }));
    if (option.type === 'order') return this.show(ctx, child(s, { screen: 'order', orderId: option.id }));
    if (option.type === 'category') return this.show(ctx, child(s, { screen: 'variants', categoryId: option.id, page: 0 }));
    if (option.type === 'addCategory') return this.show(ctx, child(s, { screen: 'addCategory', draft: { key: `${event}:category` } }));
    if (option.type === 'renameCategory' || option.type === 'deleteCategory') {
      const category = (await this.api.catalog()).categories.find(c => c.id === s.categoryId);
      if (!category) return this.show(ctx, { screen: 'categories', page: 0 }, 'Katalog sudah dihapus.');
      if (category.version !== s.categoryVersion) return this.show(ctx, location(s), 'Katalog berubah. Pilih tindakan lagi.');
      const pending = { kind: 'categoryEdit', mode: option.type === 'renameCategory' ? 'rename' : 'delete', version: category.version, oldName: category.name };
      const next = child(s, { screen: 'renameCategory', categoryId: category.id, pending });
      return option.type === 'renameCategory' ? this.show(ctx, next) : this.apply(ctx, next);
    }
    if (option.type === 'variant') return this.show(ctx, child(s, { screen: 'variant', categoryId: s.categoryId, variantId: option.id }));
    if (option.type === 'orderAction') {
      const order = await this.api.order(s.orderId);
      if (order.version !== s.version) return this.show(ctx, location(s), 'Order berubah. Pilih lagi dari detail terbaru.');
      if (!orderActions(order).some(a => a.id === option.id)) return this.show(ctx, location(s), 'Tindakan tidak lagi tersedia.');
      if (option.id === 'contact') return this.contact(ctx, order.buyer, order.id);
      const pending = { kind: 'order', action: option.id, version: order.version, key: `${event}:order:${option.id}` };
      const next = child(s, { screen: 'input', orderId: order.id, pending });
      return requiresReason(option.id) ? this.show(ctx, next) : this.apply(ctx, next);
    }
    if (option.type === 'edit' || option.type === 'variantAction') {
      const v = (await this.api.catalog()).variants.find(row => row.id === s.variantId);
      if (!v || v.version !== s.version) return this.show(ctx, location(s), 'Varian berubah. Pilih lagi dari detail terbaru.');
      const pending = { kind: 'variant', field: option.id, ready: option.ready, version: v.version, label: option.label };
      const next = child(s, { screen: 'input', categoryId: s.categoryId, variantId: v.id, pending });
      return option.type === 'edit' ? this.show(ctx, next) : this.apply(ctx, next);
    }
    if (option.type === 'addVariant') return this.show(ctx, child(s, { screen: 'add', step: 'name', categoryId: s.categoryId, draft: { id: `v-${randomUUID().replaceAll('-','').slice(0,16)}`, categoryId: s.categoryId } }));
    if (option.type === 'retry') {
      const job = this.local.uncertainById(option.id);
      if (!job) return this.show(ctx, location(s), 'Pesan tidak lagi berada dalam daftar ini.');
      return this.apply(ctx, child(s, { pending: { kind: 'retry', ...job } }));
    }
  }

  async categoryInput(ctx, text) {
    const name = text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleUpperCase('id-ID');
    if (!name || name.length > 80) return this.show(ctx, ctx.state, 'Nama katalog wajib 1–80 karakter.');
    return this.apply(ctx, child(ctx.state, { pending: { kind: 'category', name, key: ctx.state.draft.key } }));
  }

  async renameCategoryInput(ctx, text) {
    const name = text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleUpperCase('id-ID');
    if (!name || name.length > 80) return this.show(ctx, ctx.state, 'Nama katalog wajib 1–80 karakter.');
    return this.apply(ctx, child(ctx.state, { categoryId: ctx.state.categoryId, pending: { ...ctx.state.pending, name } }));
  }

  async input(ctx, text) {
    const s = ctx.state;
    const pending = { ...s.pending };
    if (s.orderId) {
      if (!text || text.length > 2000) return this.show(ctx, s, 'Alasan wajib 1–2000 karakter.');
      pending.reason = text;
    } else if (pending.field === 'price') {
      if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 9999999999) return this.show(ctx, s, 'Harga harus angka bulat 1–9999999999.');
      pending.value = Number(text);
    } else {
      if (!text || text.length > (pending.field === 'name' ? 120 : 2000)) return this.show(ctx, s, 'Isian kosong atau terlalu panjang.');
      pending.value = text;
    }
    return this.apply(ctx, child(s, { orderId: s.orderId, variantId: s.variantId, categoryId: s.categoryId, pending }));
  }

  async addInput(ctx, text) {
    const s = ctx.state;
    const draft = { ...s.draft };
    if (s.step === 'price') {
      if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 9999999999) return this.show(ctx, s, 'Harga harus angka bulat 1–9999999999.');
      draft.price = Number(text);
    } else {
      if (!text || text.length > (s.step === 'name' ? 120 : 2000)) return this.show(ctx, s, 'Isian kosong atau terlalu panjang.');
      draft[s.step] = text;
    }
    if (s.step === 'terms') return this.apply(ctx, child(s, { categoryId: s.categoryId, pending: { kind: 'add', draft } }));
    return this.show(ctx, child(s, { screen: 'add', categoryId: s.categoryId, step: s.step === 'name' ? 'price' : 'terms', draft }));
  }

  async execute(ctx) {
    const s = ctx.state;
    const pending = s.pending;
    if (pending.kind === 'broadcast') {
      const recipients = await this.recipients();
      this.local.queueBroadcast(pending.key, recipients, pending.text);
      return this.show(ctx, { screen: 'broadcast', back: { screen: 'home' } }, recipients.length ? `✓ Broadcast untuk ${recipients.length} pelanggan masuk antrean.` : 'Belum ada pelanggan yang dapat menerima broadcast.');
    }
    if (pending.kind === 'cancelBroadcast') {
      const count = this.local.cancelBroadcast();
      return this.show(ctx, { screen: 'broadcast', back: { screen: 'home' } }, `✓ ${count} kiriman broadcast dibatalkan.`);
    }
    if (pending.kind === 'categoryEdit') {
      const category = await this.api.categoryAction(s.categoryId, { mode: pending.mode, expectedVersion: pending.version, name: pending.name });
      if (pending.mode === 'delete') return this.show(ctx, { screen: 'categories', page: 0, back: { screen: 'home' } }, '✓ Katalog dihapus. Pesanan lama tetap tersimpan.');
      return this.show(ctx, { screen: 'variants', categoryId: category.id, page: 0, back: { screen: 'categories', page: 0 } }, '✓ Nama katalog diperbarui.');
    }
    if (pending.kind === 'category') {
      const category = await this.api.category({ name: pending.name, key: pending.key });
      return this.show(ctx, { screen: 'variants', categoryId: category.id, page: 0, back: s.back?.back || { screen: 'categories', page: 0 } }, '✓ Katalog ditambahkan. Pilih Tambah varian untuk mengisi produk.');
    }
    if (pending.kind === 'order') {
      const before = await this.api.order(s.orderId);
      if (before.version !== pending.version) return this.show(ctx, { screen: 'order', orderId: before.id, back: { screen: 'orders', filter: 'all', page: 0 } }, 'Order berubah. Pilih ulang tindakan.');
      const updated = await executeOrderAction(this.api, before, pending);
      await notifyOrderAction(updated, pending, ctx.send, this.adminNumber);
      return this.show(ctx, { screen: 'order', orderId: updated.id, back: { screen: 'orders', filter: 'all', page: 0 } }, '✓ Perubahan tersimpan dan pemberitahuan buyer masuk antrean.');
    }
    if (pending.kind === 'add') {
      const v = await this.api.variant({ ...pending.draft, mode: 'add' });
      return this.show(ctx, { screen: 'variant', variantId: v.id, categoryId: v.category_id, back: { screen: 'variants', categoryId: v.category_id, page: 0 } }, '✓ Varian dibuat dengan status Kosong. Periksa sebelum menandainya Ready.');
    }
    if (pending.kind === 'variant') {
      const v = await this.api.variant({ id: s.variantId, mode: pending.field, expectedVersion: pending.version, ...(pending.field === 'price' ? { price: pending.value } : ['name','terms'].includes(pending.field) ? { value: pending.value } : pending.field === 'ready' ? { ready: pending.ready } : {}) });
      if (v.deleted) return this.show(ctx, { screen: 'variants', categoryId: v.category_id, page: 0, back: { screen: 'categories', page: 0 } }, '✓ Varian dihapus permanen. Pesanan lama tetap tersimpan.');
      return this.show(ctx, { screen: 'variant', variantId: v.id, categoryId: v.category_id, back: { screen: 'variants', categoryId: v.category_id, page: 0 } }, '✓ Perubahan tersimpan.');
    }
    if (pending.kind === 'retry') {
      const job = this.local.uncertainById(pending.id);
      if (!job || job.jid !== pending.jid) return this.show(ctx, { screen: 'uncertain', page: 0, back: { screen: 'system' } }, 'Pesan sudah berubah atau kedaluwarsa.');
      const retried = this.local.retry(job.id);
      return this.show(ctx, { screen: 'uncertain', page: 0, back: { screen: 'system' } }, retried ? '✓ Pesan masuk antrean pengiriman ulang.' : 'Pesan tidak lagi dapat diulang.');
    }
  }

  async recipients() {
    const normalize = jid => jid?.replace(/:\d+@/, '@');
    const excluded = new Set([`${this.adminNumber}@s.whatsapp.net`, normalize(this.transport.socket?.user?.id), normalize(this.transport.socket?.user?.lid)]);
    const recipients = new Set();
    let after = '';
    while (true) {
      const page = await this.api.broadcastRecipients(after);
      for (const jid of page.items) if (!excluded.has(jid)) recipients.add(jid);
      if (!page.hasNext) break;
      after = page.items.at(-1);
    }
    return [...recipients];
  }
}
