import { randomUUID } from 'node:crypto';
import { screen, orderDetails, variantDetails, money, phone, date, statusLabels } from './render.js';
import { orderActions, actionLabels, requiresReason, executeOrderAction, notifyOrderAction } from './actions.js';
import { buyerContact, waLink } from '../contact.js';
import { grid } from '../ui.js';

const TTL = 30 * 60000;
const UI_VERSION = 3;
const legacy = new Set(['/produk','/tambahvarian','/ubahvarian','/harga','/ready','/order','/setujui','/tolakbukti','/selesai','/batalkan','/refund','/refundselesai','/lanjutkan','/balas','/gagalkirim','/ulang','/batalsetup']);
const groupLabels = { all: 'Semua pesanan', review: 'Menunggu verifikasi', processing: 'Sedang diproses', cancellation: 'Permintaan pembatalan', refund: 'Refund', ...statusLabels };
const locationKeys = ['screen','page','filter','categoryId','variantId','orderId','conversationId','archived','draft','step','pending','version','buyer','contactOrderId','back'];
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
    return this.transport.text(message.jid, screen('Admin › Koneksi', `Worker/D1 belum dapat diakses.\nKode: API_NETWORK\nWhatsApp: ${this.runtime().whatsapp ? 'Terhubung' : 'Belum terhubung'}\nAntrean keluar: ${counts.pending || 0}\n\nPeriksa status pesanan sebelum mengulang konfirmasi. Coba /admin setelah koneksi pulih.`, { root: true }), `${message.jid}:${message.id}:admin:offline`);
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
    return this.transport.text(message.jid, grid('ADMIN · PERMINTAAN GAGAL', [`Kode: ${code}${error.status ? `\nHTTP: ${error.status}` : ''}`, detail, 'Ketik /admin untuk membuka ulang menu. Periksa status pesanan sebelum mengulang konfirmasi.']), `${message.jid}:${message.id}:admin:failure`);
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
      if (message.quotedId) {
        let ref;
        try { ref = await this.api.message(owner.buyer, message.quotedId); }
        catch (error) {
          if (error.status !== 404) throw error;
          return await ctx.send(message.jid, grid('ADMIN · KONTAK', ['Referensi tidak dikenali. Tidak ada pesan yang diteruskan.', 'Buka /admin → Pesanan & pembayaran → pilih pesanan → Hubungi buyer.']), null);
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
      if (ctx.state.screen === 'input') return await this.input(ctx, text, event);
      if (ctx.state.screen === 'add') return await this.addInput(ctx, text);
      const option = ctx.state.options?.[text];
      if (!option) return await this.show(ctx, ctx.state, 'Pilihan tidak valid. Gunakan angka yang ditampilkan.');
      return await this.select(ctx, option, event);
    } catch (error) {
      if (error.status === 409) {
        const s = ctx.state;
        const target = s?.orderId ? { screen: 'order', orderId: s.orderId, back: { screen: 'orders', filter: 'all', page: 0 } } : s?.variantId ? { screen: 'variant', variantId: s.variantId, categoryId: s.categoryId, back: { screen: 'variants', categoryId: s.categoryId, page: 0 } } : { screen: 'home' };
        return this.show(ctx, target, 'Data sudah berubah. Periksa detail terbaru dan pilih tindakan lagi.');
      }
      return this.failure(message, error, ctx.state);
    }
  }

  async contact(ctx, buyer, orderId = null) {
    const content = orderId
      ? buyerContact(await this.api.order(orderId))
      : grid('ADMIN · HUBUNGI BUYER', [`Nomor: ${phone(buyer)}`, 'Klik link untuk chat langsung. Pesan dan gambar tidak diteruskan oleh bot.']) + '\n\n' + waLink(buyer, 'Halo, saya admin Mazy Store.');
    await ctx.send(ctx.message.jid, content, null);
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
      ])}`;
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
      list(page.items, o => `${phone(o.buyer)} · ${money(o.total)}\n${o.product} — ${o.variant}\n${o.id} · ${statusLabels[o.status]}`, 'order');
      body = page.items.length ? '' : 'Belum ada pesanan pada daftar ini.';
    } else if (s.screen === 'order') {
      const order = await this.api.order(s.orderId);
      s.version = order.version;
      path += ' › Pesanan › Detail';
      body = `${orderDetails(order)}\n${choices(orderActions(order).map(a => ({ ...a, type: 'orderAction' })))}`;
    } else if (s.screen === 'categories' || s.screen === 'variants' || s.screen === 'variant') {
      const { categories, variants } = await this.api.catalog(true);
      const category = categories.find(c => c.id === s.categoryId);
      path += ' › Katalog';
      if (s.screen === 'categories') {
        const rows = categories.slice(s.page * 5, s.page * 5 + 5);
        s.hasNext = (s.page + 1) * 5 < categories.length;
        body = list(rows, c => `${c.name} (${variants.filter(v => v.category_id === c.id && !v.archived).length})`, 'category');
      } else if (s.screen === 'variants') {
        if (!category) throw Object.assign(new Error('Kategori tidak ditemukan.'), { status: 404 });
        path = `${category.name} (${variants.filter(v => v.category_id === s.categoryId && !v.archived).length})${s.archived ? ' › Arsip' : ''}`;
        const rows = variants.filter(v => v.category_id === s.categoryId && Boolean(v.archived) === Boolean(s.archived));
        s.hasNext = (s.page + 1) * 5 < rows.length;
        list(rows.slice(s.page * 5, s.page * 5 + 5), v => `${v.name} · ${money(v.price)}\nStatus: ${v.ready ? 'Buka' : 'Tutup'}`, 'variant');
        body = rows.length ? '' : (s.archived ? 'Arsip kategori ini kosong.' : 'Belum ada varian.');
        if (!s.archived) {
          choices([{ type: 'addVariant', label: 'Tambah varian' }, { type: 'archives', label: 'Lihat arsip' }]);
        }
      } else {
        const variant = variants.find(v => v.id === s.variantId);
        if (!variant) throw Object.assign(new Error('Varian tidak ditemukan.'), { status: 404 });
        s.categoryId = variant.category_id;
        s.version = variant.version;
        path += ` › ${categories.find(c => c.id === variant.category_id).name} › Detail`;
        body = `${variantDetails(variant)}\n\n${choices(variant.archived ? [{ type: 'variantAction', id: 'restore', label: 'Pulihkan varian (tetap tutup)' }] : [
          { type: 'edit', id: 'price', label: 'Ubah harga' }, { type: 'edit', id: 'name', label: 'Ubah nama' }, { type: 'edit', id: 'terms', label: 'Ubah ketentuan' },
          { type: 'variantAction', id: 'ready', ready: !variant.ready, label: variant.ready ? 'Tutup penjualan' : 'Buka penjualan' },
          { type: 'variantAction', id: 'archive', label: 'Arsipkan varian' },
        ])}`;
      }
    } else if (s.screen === 'input') {
      path += s.orderId ? ' › Pesanan › Alasan' : ' › Katalog › Ubah varian';
      body = s.orderId ? `${actionLabels[s.pending.action]}\nOrder: ${s.orderId}\n\nKetik alasan (1–2000 karakter).` : s.pending.field === 'price' ? 'Ketik harga baru dalam rupiah, angka saja.\nContoh: 90000' : `Ketik ${s.pending.field === 'name' ? 'nama baru (maksimal 120 karakter)' : 'durasi dan ketentuan baru (maksimal 2000 karakter)'}.`;
    } else if (s.screen === 'add') {
      path += ' › Katalog › Tambah varian';
      body = { name: 'Langkah 1/3\nKetik nama varian (maksimal 120 karakter).', price: `Langkah 2/3\nNama: ${s.draft.name}\n\nKetik harga dalam rupiah, angka saja.`, terms: `Langkah 3/3\n${s.draft.name} · ${money(s.draft.price)}\n\nKetik durasi dan ketentuan layanan (maksimal 2000 karakter).` }[s.step];
    } else if (s.screen === 'confirm') {
      path += ' › Konfirmasi';
      if (s.pending.kind === 'order') {
        const o = await this.api.order(s.orderId);
        if (o.version !== s.pending.version) return this.show(ctx, { screen: 'order', orderId: o.id, back: s.back?.back || { screen: 'home' } }, 'Order berubah. Periksa ulang sebelum melanjutkan.');
        body = `${orderDetails(o)}\n*Tindakan: ${actionLabels[s.pending.action]}*${s.pending.reason ? `\nAlasan: ${s.pending.reason}` : ''}${s.pending.action === 'approve' ? '\nPastikan uang sudah masuk di aplikasi merchant.' : ''}`;
      } else if (s.pending.kind === 'add') body = `*Simpan varian baru?*\n${s.pending.draft.name}\nHarga: ${money(s.pending.draft.price)}\n${s.pending.draft.terms}\n\nStatus awal: Tutup.`;
      else if (s.pending.kind === 'retry') body = `*Kirim ulang pesan?*\nTujuan: ${phone(s.pending.jid)}\nDibuat: ${date(new Date(s.pending.created).toISOString())}\n\nPesan sebelumnya mungkin sudah sampai. Periksa chat tujuan sebelum melanjutkan.`;
      else {
        const v = (await this.api.catalog(true)).variants.find(row => row.id === s.variantId);
        if (!v || v.version !== s.pending.version) return this.show(ctx, { screen: 'variant', variantId: s.variantId, categoryId: s.categoryId, back: s.back?.back || { screen: 'home' } }, 'Varian berubah. Periksa detail terbaru.');
        body = `${variantDetails(v)}\n\n*Perubahan:* ${s.pending.label}${s.pending.value !== undefined ? `\n${s.pending.field === 'price' ? money(s.pending.value) : s.pending.value}` : ''}`;
      }
      body += `\n\n${choices([{ type: 'execute', label: 'Ya, lanjutkan' }])}`;
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
      body = page.items.length ? '' : 'Tidak ada pengiriman meragukan.';
    }
    if (body === undefined) return this.show(ctx, { screen: 'home' });
    const input = s.screen === 'input' || s.screen === 'add';
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
    if (option.type === 'order') return this.show(ctx, child(s, { screen: 'order', orderId: option.id }));
    if (option.type === 'category') return this.show(ctx, child(s, { screen: 'variants', categoryId: option.id, page: 0 }));
    if (option.type === 'variant') return this.show(ctx, child(s, { screen: 'variant', categoryId: s.categoryId, variantId: option.id }));
    if (option.type === 'archives') return this.show(ctx, child(s, { screen: 'variants', categoryId: s.categoryId, archived: true, page: 0 }));
    if (option.type === 'orderAction') {
      const order = await this.api.order(s.orderId);
      if (order.version !== s.version) return this.show(ctx, location(s), 'Order berubah. Pilih lagi dari detail terbaru.');
      if (!orderActions(order).some(a => a.id === option.id)) return this.show(ctx, location(s), 'Tindakan tidak lagi tersedia.');
      if (option.id === 'contact') return this.contact(ctx, order.buyer, order.id);
      const pending = { kind: 'order', action: option.id, version: order.version, key: `${event}:order:${option.id}` };
      return this.show(ctx, child(s, { screen: requiresReason(option.id) ? 'input' : 'confirm', orderId: order.id, pending }));
    }
    if (option.type === 'edit' || option.type === 'variantAction') {
      const v = (await this.api.catalog(true)).variants.find(row => row.id === s.variantId);
      if (!v || v.version !== s.version) return this.show(ctx, location(s), 'Varian berubah. Pilih lagi dari detail terbaru.');
      const pending = { kind: 'variant', field: option.id, ready: option.ready, version: v.version, label: option.label };
      return this.show(ctx, child(s, { screen: option.type === 'edit' ? 'input' : 'confirm', categoryId: s.categoryId, variantId: v.id, pending }));
    }
    if (option.type === 'addVariant') return this.show(ctx, child(s, { screen: 'add', step: 'name', categoryId: s.categoryId, draft: { id: `v-${randomUUID().replaceAll('-','').slice(0,16)}`, categoryId: s.categoryId } }));
    if (option.type === 'retry') {
      const job = this.local.uncertainById(option.id);
      if (!job) return this.show(ctx, location(s), 'Pesan tidak lagi berada dalam daftar ini.');
      return this.show(ctx, child(s, { screen: 'confirm', pending: { kind: 'retry', ...job } }));
    }
    if (option.type === 'execute') return this.execute(ctx);
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
    return this.show(ctx, child(s, { screen: 'confirm', orderId: s.orderId, variantId: s.variantId, categoryId: s.categoryId, pending }));
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
    if (s.step === 'terms') return this.show(ctx, child(s, { screen: 'confirm', categoryId: s.categoryId, pending: { kind: 'add', draft } }));
    return this.show(ctx, child(s, { screen: 'add', categoryId: s.categoryId, step: s.step === 'name' ? 'price' : 'terms', draft }));
  }

  async execute(ctx) {
    const s = ctx.state;
    const pending = s.pending;
    if (pending.kind === 'order') {
      const before = await this.api.order(s.orderId);
      if (before.version !== pending.version) return this.show(ctx, { screen: 'order', orderId: before.id, back: { screen: 'orders', filter: 'all', page: 0 } }, 'Order berubah. Pilih ulang tindakan.');
      const updated = await executeOrderAction(this.api, before, pending);
      await notifyOrderAction(updated, pending, ctx.send, this.adminNumber);
      return this.show(ctx, { screen: 'order', orderId: updated.id, back: { screen: 'orders', filter: 'all', page: 0 } }, '✓ Perubahan tersimpan dan pemberitahuan buyer masuk antrean.');
    }
    if (pending.kind === 'add') {
      const v = await this.api.variant({ ...pending.draft, mode: 'add' });
      return this.show(ctx, { screen: 'variant', variantId: v.id, categoryId: v.category_id, back: { screen: 'variants', categoryId: v.category_id, page: 0 } }, '✓ Varian dibuat dalam keadaan tutup. Periksa sebelum membuka penjualan.');
    }
    if (pending.kind === 'variant') {
      const v = await this.api.variant({ id: s.variantId, mode: pending.field, expectedVersion: pending.version, ...(pending.field === 'price' ? { price: pending.value } : ['name','terms'].includes(pending.field) ? { value: pending.value } : pending.field === 'ready' ? { ready: pending.ready } : {}) });
      return this.show(ctx, { screen: 'variant', variantId: v.id, categoryId: v.category_id, back: { screen: 'variants', categoryId: v.category_id, page: 0, archived: Boolean(v.archived) } }, '✓ Perubahan tersimpan.');
    }
    if (pending.kind === 'retry') {
      const job = this.local.uncertainById(pending.id);
      if (!job || job.jid !== pending.jid) return this.show(ctx, { screen: 'uncertain', page: 0, back: { screen: 'system' } }, 'Pesan sudah berubah atau kedaluwarsa.');
      const retried = this.local.retry(job.id);
      return this.show(ctx, { screen: 'uncertain', page: 0, back: { screen: 'system' } }, retried ? '✓ Pesan masuk antrean pengiriman ulang.' : 'Pesan tidak lagi dapat diulang.');
    }
  }
}
