import { PollTest } from '../poll.js';
import { parseStock, encryptStock, decryptStock, availability } from '../inventory.js';
import { randomUUID } from 'node:crypto';
import { screen, orderDetails, variantDetails, money, phone, date, statusLabels, orderStatus } from './render.js';
import { orderActions, actionLabels, requiresReason, executeOrderAction, notifyOrderAction } from './actions.js';
import { buyerContact, waLink } from '../contact.js';
import { renderMessage } from '../ui.js';
import { Testimonials } from '../testimonials.js';

const TTL = 30 * 60000;
const UI_VERSION = 10;
const shortcuts = { '/setujui': 'approve', '/selesaikan': 'complete', '/selesai': 'complete', '/tolakbukti': 'reject_proof', '/batal': 'cancel', '/batalkan': 'cancel', '/refund': 'refund', '/refundselesai': 'refund_complete', '/lanjutkan': 'clear_cancel' };
const legacy = new Set(['/produk','/tambahvarian','/ubahvarian','/harga','/ready','/order','/setujui','/tolakbukti','/selesai','/batalkan','/refund','/refundselesai','/lanjutkan','/balas','/gagalkirim','/ulang','/batalsetup']);
const groupLabels = { all: 'Semua pesanan', review: 'Menunggu verifikasi', processing: 'Sedang diproses', cancellation: 'Permintaan pembatalan', refund: 'Refund', ...statusLabels };
const locationKeys = ['screen','filter','categoryId','variantId','stockId','batch','orderId','draft','step','pending','version','back'];
const location = state => Object.fromEntries(locationKeys.filter(key => state[key] !== undefined).map(key => [key, key === 'back' ? location(state.back) : state[key]]));
const child = (state, next) => ({ ...next, back: location(state) });

export class AdminNavigation {
  constructor(api, transport, local, runtime = () => ({}), config = {}, reportError = () => {}) {
    this.api = api; this.transport = transport; this.local = local; this.runtime = runtime;
    this.adminNumber = config.adminNumber || config.adminJid?.split('@')[0];
    this.reportError = reportError; this.dataKey = config.dataKey;
    this.testimonials = new Testimonials(local, transport);
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
      if(command==='/tespoll') {
        const value=text.slice(command.length).trim();
        if(value && !/^\d+$/.test(value))return ctx.send(message.jid,'Gunakan /tespoll atau /tespoll 256.',null);
        const length=value ? Number(value) : 0;
        if(length>1000)return ctx.send(message.jid,'Batas percobaan 1000 karakter.',null);
        return await new PollTest(this.local,this.transport).create(message.jid,length);
      }
      if (shortcuts[command] && (command !== '/batal' || message.quotedId)) return await this.shortcut(ctx, command, text.slice(command.length).trim(), event);
      if (command === '/post') {
        if (text !== command || !ctx.state || ctx.state.uiVersion !== UI_VERSION || Date.now() - ctx.state.at > TTL || ctx.state.screen !== 'order') {
          return await ctx.send(message.jid, renderMessage('ADMIN · AUTOTESTI', ['Buka detail order Selesai dari riwayat, lalu ketik /post tanpa parameter.']), null);
        }
        if (message.quotedId) {
          let ref;
          try { ref = await this.api.message(owner.buyer, message.quotedId); }
          catch (error) { if (error.status !== 404) throw error; }
          if (ref?.kind !== 'menu' || ref.menu_token !== ctx.state.token) {
            return await ctx.send(message.jid, renderMessage('ADMIN · AUTOTESTI', ['Pesan yang dibalas bukan detail order terbaru. Ketik /post dari detail order yang sedang dibuka.']), null);
          }
        }
        return await this.postTestimonial(ctx, await this.api.order(ctx.state.orderId), true);
      }
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
      if (ctx.state.screen === 'testimonialLink') {
        try {
          await this.testimonials.setChannel(text);
        } catch (error) { return await this.show(ctx, ctx.state, error.message); }
        return await this.show(ctx, { screen: 'testimonials', back: { screen: 'home' } }, '✓ Saluran tersimpan.');
      }
      if (ctx.state.screen === 'broadcastInput') {
        if (!text || text.length > 2000) return await this.show(ctx, ctx.state, 'Pesan broadcast wajib 1–2000 karakter.');
        return await this.apply(ctx, child(ctx.state, { pending: { kind: 'broadcast', key: ctx.state.draft.key, text } }));
      }
      if (['stockAdd','stockEdit'].includes(ctx.state.screen)) return await this.stockInput(ctx,text,event);
      if (message.document) return await this.show(ctx,ctx.state,'File .txt hanya diterima pada Tambah stok batch.');
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
        if (s?.pending?.kind === 'category') return this.show(ctx, s.back || { screen: 'categories' }, error.message);
        if (s?.pending?.kind === 'categoryEdit') return this.show(ctx, { screen: 'variants', categoryId: s.categoryId, back: { screen: 'categories' } }, error.message);
        const target = s?.orderId ? { screen: 'order', orderId: s.orderId, back: { screen: 'orders', filter: 'all' } } : s?.variantId ? { screen: 'variant', variantId: s.variantId, categoryId: s.categoryId, back: { screen: 'variants', categoryId: s.categoryId } } : { screen: 'home' };
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
    const action = command === '/selesai' && order.status === 'refund_pending' ? 'refund_complete' : shortcuts[command];
    if (!orderActions(order).some(option => option.id === action)) return reply(`ID: ${order.id}\nStatus: ${orderStatus(order)}\nTindakan ${command} tidak tersedia untuk status ini. Tidak ada perubahan.`);
    if (requiresReason(action) && (!reason || reason.length > 2000)) return reply(`Reply pesan yang sama dengan ${command} alasan (1–2000 karakter).`);
    const pending = { action, reason: requiresReason(action) ? reason : '', key: `${event}:order:${action}`, version: order.version };
    const updated = await executeOrderAction(this.api, order, pending);
    await notifyOrderAction(this.api, updated, pending, ctx.send, this.adminNumber);
    if (action === 'complete') await this.postTestimonial(ctx, updated);
    return ctx.send(ctx.message.jid, renderMessage('ADMIN · PESANAN', [`ID: ${updated.id}\nBuyer: ${phone(updated.buyer)}\nStatus: ${orderStatus(updated)}`, updated.status === 'processing' && updated.delivery_mode === 'auto' ? 'Barang dikirim otomatis. Status akan menjadi Selesai setelah seluruh kiriman berhasil, tanpa perlu perintah penyelesaian manual.' : updated.status === 'processing' ? '/selesaikan jika pesanan sudah selesai di proses\n/refund alasan - Tawarkan refund ke buyer' : updated.status === 'refund_pending' ? updated.refund_accepted ? 'Buyer sudah menyetujui refund. Kembalikan uang, lalu reply /selesai.' : 'Tunggu buyer mengetik /setujui sebelum mengembalikan uang.' : ['awaiting_payment','awaiting_proof','review'].includes(updated.status) ? 'Reply /batal untuk membatalkan pesanan.' : '']), { buyer: updated.buyer, orderId: updated.id, role: 'admin', kind: 'relay', purpose: 'transaction' });
  }

  async apply(ctx, state) {
    ctx.state = state;
    return this.execute(ctx);
  }

  async postTestimonial(ctx, order, manual = false) {
    const result = await this.testimonials.post(order);
    if (manual || result.status !== 'disabled') {
      await ctx.send(ctx.message.jid, renderMessage('ADMIN · AUTOTESTI', [`ID: ${order.id}`, result.message, order.status === 'completed' ? 'Status order tetap Selesai.' : '']), null);
    }
  }

  async show(ctx, view, notice = '') {
    const s = { ...view, uiVersion: UI_VERSION, at: Date.now(), token: randomUUID(), options: {} };
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
        { type: 'go', screen: 'categories', label: 'Kelola katalog' },
        { type: 'go', screen: 'system', label: 'Status bot & pengiriman' },
        { type: 'go', screen: 'broadcast', label: 'Broadcast pelanggan' },
        { type: 'go', screen: 'testimonials', label: 'Autotesti saluran' },
      ])}`;
    } else if (s.screen === 'testimonials') {
      path += ' › Autotesti saluran';
      const settings = this.testimonials.settings();
      body = `Status: ${settings.enabled ? 'Aktif' : 'Nonaktif'}\nSaluran: ${settings.name || 'Belum diatur'}${settings.link ? `\n${settings.link}` : ''}\n\nPosting gambar dan caption langsung saat order Selesai. Tidak memakai antrean. Posting manual juga memerlukan fitur Aktif.`;
      choices([{ type: 'go', screen: 'testimonialLink', label: settings.jid ? 'Ubah saluran' : 'Atur saluran' }, { type: 'toggleTestimonial', label: settings.enabled ? 'Nonaktifkan' : 'Aktifkan' }]);
    } else if (s.screen === 'testimonialLink') {
      path += ' › Autotesti › Atur saluran';
      body = 'Kirim link https://whatsapp.com/channel/...\nNomor bot wajib ADMIN atau OWNER saluran. Saluran hanya disimpan setelah izin berhasil diperiksa.';
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
        ...[['review','Menunggu verifikasi'],['processing','Sedang diproses'],['cancellation','Permintaan pembatalan'],['refund','Refund']].map(([filter,label]) => ({ type: 'go', screen: 'orders', filter, label })),
        { type: 'go', screen: 'filters', label: 'Semua pesanan & riwayat' },
      ]);
    } else if (s.screen === 'filters') {
      path += ' › Pesanan › Filter';
      const filters = [['completed','Selesai'],['all','Semua status'],['awaiting_payment','Belum membayar'],['awaiting_proof','Menunggu bukti'],['review','Menunggu verifikasi'],['processing','Sedang diproses'],['refund','Menunggu refund'],['cancelled','Dibatalkan'],['refunded','Refund selesai']];
      body = choices(filters.map(([filter,label]) => ({ type: 'go', screen: 'orders', filter, label })));
    } else if (s.screen === 'orders') {
      path += ` › Pesanan › ${groupLabels[s.filter]}`;
      const result = await this.api.adminOrders(s.filter);
      list(result.items, o => o.id, 'order');
      body = result.items.length ? '' : 'Belum ada pesanan pada daftar ini.';
    } else if (s.screen === 'order') {
      const order = await this.api.order(s.orderId);
      s.version = order.version;
      path += ' › Pesanan › Detail';
      body = `${orderDetails(order)}${order.status === 'review' ? '\nPeriksa uang masuk sebelum menyetujui.\n' : ''}\n${choices(orderActions(order).map(a => ({ ...a, type: 'orderAction' })))}`;
      if (order.delivery_mode === 'auto') choices([{type:'orderStock',label:'Lihat barang yang dialokasikan'}]);
      if (order.status === 'completed') body += '\n/post - Posting ke saluran';
    } else if (s.screen === 'stockList') {
      path += ' › Gudang › Stok tersedia';
      const {items}=await this.api.stock(s.variantId);
      body=items.length ? '' : 'Belum ada stok tersedia.';
      choices(items.map((item,index)=>({type:'stockItem',id:item.id,label:'Stok '+(index+1)})));
    } else if (s.screen === 'stockItem') {
      const item=await this.api.stockItem(s.stockId);
      s.version=item.version;s.variantId=item.variant_id;
      path += ' › Gudang › Detail stok';
      body='Status: '+({available:'Tersedia',reserved:'Dipesan',sold:'Terjual'}[item.state])+'\n\n'+decryptStock(item.payload,this.dataKey);
      if(item.state==='available')choices([{type:'editStock',label:'Edit isi stok'},{type:'deleteStock',label:'Hapus stok permanen'}]);
    } else if (s.screen === 'orderStock') {
      path += ' › Pesanan › Barang';
      const {items}=await this.api.orderStock(s.orderId);
      body=items.map((item,i)=>'Barang '+(i+1)+'\n'+decryptStock(item.payload,this.dataKey)).join('\n\n────────────────────\n\n') || 'Tidak ada stok yang terikat pada order ini.';
    } else if (s.screen === 'stockAdd' || s.screen === 'stockEdit') {
      path += ' › Gudang › '+(s.screen==='stockEdit'?'Edit stok':s.batch?'Tambah batch':'Tambah satuan');
      body=s.screen==='stockEdit' ? 'Isi saat ini:\n'+decryptStock((await this.api.stockItem(s.stockId)).payload,this.dataKey)+'\n\nKirim seluruh isi pengganti (1–2000 karakter).' : s.batch ? 'Kirim batch sebagai teks atau file .txt UTF-8 maksimal 256 KiB.\nPisahkan unit dengan baris ---\nMaksimal 100 unit; masing-masing 1–2000 karakter. Seluruh batch diperiksa sebelum disimpan.' : 'Kirim isi satu paket barang (1–2000 karakter).';
    } else if (s.screen === 'categories' || s.screen === 'variants' || s.screen === 'variant') {
      const { categories, variants } = await this.api.catalog();
      const category = categories.find(c => c.id === s.categoryId);
      path += ' › Katalog';
      if (s.screen === 'categories') {
        const rows = categories;
        body = list(rows, c => `${c.name} (${variants.filter(v => v.category_id === c.id && !v.archived).length})`, 'category');
        choices([{ type: 'addCategory', label: 'Tambah katalog' }]);
      } else if (s.screen === 'variants') {
        if (!category) return this.show(ctx, { screen: 'categories', back: { screen: 'home' } }, 'Katalog sudah dihapus atau tidak tersedia.');
        s.categoryVersion = category.version;
        path = `${category.name} (${variants.filter(v => v.category_id === s.categoryId && !v.archived).length})`;
        const rows = variants.filter(v => v.category_id === s.categoryId && !v.archived);
        list(rows, v => `${v.name} · ${money(v.price)}\nStatus: ${availability(v)}`, 'variant');
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
          ...(variant.delivery_mode === 'auto' ? [
            {type:'addStock',label:'Tambah stok satuan'},
            {type:'addStock',batch:true,label:'Tambah stok batch'},
            {type:'stockList',label:'Lihat stok tersedia'},
          ] : [{ type: 'variantAction', id: 'ready', ready: !variant.ready, label: variant.ready ? 'Tandai Kosong' : 'Tandai Ready' }]),
          {type:'variantAction',id:'delivery',deliveryMode:variant.delivery_mode==='auto'?'manual':'auto',label:variant.delivery_mode==='auto'?'Ubah ke Manual':'Ubah ke Otomatis'},
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
      body = `WhatsApp: ${runtime.whatsapp ? '🟢 Terhubung' : '⚪ Belum terhubung'}\nD1: 🟢 Terjangkau\nAntrean keluar: ${counts.pending}\nHasil kirim meragukan: ${counts.uncertain}\n\n${choices([{ type: 'go', screen: 'uncertain', label: 'Periksa pengiriman meragukan' }, { type: 'refresh', label: 'Perbarui status' }])}`;
    } else if (s.screen === 'uncertain') {
      path += ' › Pengiriman › Perlu diperiksa';
      const jobs = this.local.uncertain();
      list(jobs, job => `${phone(job.jid)}\n${date(new Date(job.created).toISOString())}`, 'retry');
      body = jobs.length ? 'Memilih pesan langsung mengirim ulang. Pesan sebelumnya mungkin sudah sampai; periksa chat tujuan dulu.' : 'Tidak ada pengiriman meragukan.';
    }
    if (body === undefined) return this.show(ctx, { screen: 'home' });
    const input = ['stockAdd','stockEdit'].includes(s.screen) || s.screen === 'input' || s.screen === 'add' || s.screen === 'addCategory' || s.screen === 'renameCategory' || s.screen === 'broadcastInput' || s.screen === 'testimonialLink';
    if (!input) {
      if (s.screen !== 'home') menu.push({ type: 'back', label: 'Kembali' }, { type: 'home', label: 'Beranda' });
    }
    s.options = Object.fromEntries(menu.map((option, index) => [String(index + 1), option]));
    await ctx.save(s);
    await ctx.send(ctx.message.jid, screen(path, body.trim(), { root: s.screen === 'home', notice, input, options: menu }), { buyer: ctx.owner.buyer, role: 'admin', kind: 'menu', menuToken: s.token });
  }

  async select(ctx, option, event) {
    const s = ctx.state;
    if (option.type === 'back') return this.show(ctx, s.back || { screen: 'home' });
    if (option.type === 'home') return this.show(ctx, { screen: 'home' });
    if (option.type === 'go') {
      const { type, label, ...next } = option;
      return this.show(ctx, child(s, next));
    }
    if(option.type==='stockList')return this.show(ctx,child(s,{screen:'stockList',variantId:s.variantId}));
    if(option.type==='stockItem')return this.show(ctx,child(s,{screen:'stockItem',stockId:option.id,variantId:s.variantId}));
    if(option.type==='orderStock')return this.show(ctx,child(s,{screen:'orderStock',orderId:s.orderId}));
    if(option.type==='addStock')return this.show(ctx,child(s,{screen:'stockAdd',variantId:s.variantId,batch:Boolean(option.batch)}));
    if(option.type==='editStock' || option.type==='deleteStock') {
      const item=await this.api.stockItem(s.stockId);
      if(item.state!=='available' || item.version!==s.version)return this.show(ctx,location(s),'Stok berubah atau sudah dialokasikan.');
      if(option.type==='editStock')return this.show(ctx,child(s,{screen:'stockEdit',stockId:item.id,variantId:item.variant_id,version:item.version}));
      await this.api.changeStock(item.id,{mode:'delete',expectedVersion:item.version});
      return this.show(ctx,{screen:'stockList',variantId:item.variant_id,back:{screen:'variant',variantId:item.variant_id}},'✓ Stok dihapus permanen.');
    }
    if (option.type === 'refresh') return this.show(ctx, location(s));
    if (option.type === 'toggleTestimonial') {
      try { await this.testimonials.setEnabled(!this.testimonials.settings().enabled); }
      catch (error) { return this.show(ctx, location(s), error.message); }
      return this.show(ctx, location(s));
    }
    if (option.type === 'newBroadcast') return this.show(ctx, child(s, { screen: 'broadcastInput', draft: { key: randomUUID() } }));
    if (option.type === 'cancelBroadcast') return this.apply(ctx, child(s, { pending: { kind: 'cancelBroadcast' } }));
    if (option.type === 'order') return this.show(ctx, child(s, { screen: 'order', orderId: option.id }));
    if (option.type === 'category') return this.show(ctx, child(s, { screen: 'variants', categoryId: option.id }));
    if (option.type === 'addCategory') return this.show(ctx, child(s, { screen: 'addCategory', draft: { key: `${event}:category` } }));
    if (option.type === 'renameCategory' || option.type === 'deleteCategory') {
      const category = (await this.api.catalog()).categories.find(c => c.id === s.categoryId);
      if (!category) return this.show(ctx, { screen: 'categories' }, 'Katalog sudah dihapus.');
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
      const pending = { kind: 'variant', field: option.id, ready: option.ready, deliveryMode: option.deliveryMode, version: v.version, label: option.label };
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

  async stockInput(ctx,text,event) {
    const s=ctx.state;
    try {
      if(ctx.message.document) {
        if(s.screen!=='stockAdd' || !s.batch)return this.show(ctx,s,'File hanya diterima pada Tambah stok batch.');
        text=await ctx.message.document();
      }
      const values=parseStock(text,s.screen==='stockAdd' && s.batch);
      if(s.screen==='stockEdit') {
        await this.api.changeStock(s.stockId,{mode:'edit',expectedVersion:s.version,payload:encryptStock(values[0],this.dataKey)});
        return this.show(ctx,{screen:'stockItem',stockId:s.stockId,variantId:s.variantId,back:{screen:'stockList',variantId:s.variantId}},'✓ Stok diperbarui.');
      }
      const result=await this.api.addStock({key:event,variantId:s.variantId,items:values.map(value=>encryptStock(value,this.dataKey))});
      const variant=(await this.api.catalog()).variants.find(v=>v.id===s.variantId);
      return this.show(ctx,{screen:'variant',variantId:s.variantId,categoryId:variant.category_id,back:{screen:'variants',categoryId:variant.category_id}},'✓ '+result.added+' stok ditambahkan. Stok tersedia: '+variant.stock_available+'.');
    } catch(error) {
      if(error.status && error.status!==400 && error.status!==409)throw error;
      if(error.status===409)return this.show(ctx,{screen:'stockList',variantId:s.variantId,back:{screen:'variant',variantId:s.variantId}},error.message);
      return this.show(ctx,s,error.status===400 || !error.code ? error.message : 'Stok belum berhasil disimpan.');
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
      if (pending.mode === 'delete') return this.show(ctx, { screen: 'categories', back: { screen: 'home' } }, '✓ Katalog dihapus. Pesanan lama tetap tersimpan.');
      return this.show(ctx, { screen: 'variants', categoryId: category.id, back: { screen: 'categories' } }, '✓ Nama katalog diperbarui.');
    }
    if (pending.kind === 'category') {
      const category = await this.api.category({ name: pending.name, key: pending.key });
      return this.show(ctx, { screen: 'variants', categoryId: category.id, back: s.back?.back || { screen: 'categories' } }, '✓ Katalog ditambahkan. Pilih Tambah varian untuk mengisi produk.');
    }
    if (pending.kind === 'order') {
      const before = await this.api.order(s.orderId);
      if (before.version !== pending.version) return this.show(ctx, { screen: 'order', orderId: before.id, back: { screen: 'orders', filter: 'all' } }, 'Order berubah. Pilih ulang tindakan.');
      const updated = await executeOrderAction(this.api, before, pending);
      await notifyOrderAction(this.api, updated, pending, ctx.send, this.adminNumber);
      if (pending.action === 'complete') await this.postTestimonial(ctx, updated);
      return this.show(ctx, { screen: 'order', orderId: updated.id, back: { screen: 'orders', filter: 'all' } }, '✓ Perubahan tersimpan dan pemberitahuan buyer masuk antrean.');
    }
    if (pending.kind === 'add') {
      const v = await this.api.variant({ ...pending.draft, mode: 'add' });
      return this.show(ctx, { screen: 'variant', variantId: v.id, categoryId: v.category_id, back: { screen: 'variants', categoryId: v.category_id } }, '✓ Varian dibuat dengan status Kosong. Periksa sebelum menandainya Ready.');
    }
    if (pending.kind === 'variant') {
      const v = await this.api.variant({ id: s.variantId, mode: pending.field, expectedVersion: pending.version, ...(pending.field === 'price' ? { price: pending.value } : ['name','terms'].includes(pending.field) ? { value: pending.value } : pending.field === 'ready' ? { ready: pending.ready } : pending.field === 'delivery' ? {deliveryMode:pending.deliveryMode} : {}) });
      if (v.deleted) return this.show(ctx, { screen: 'variants', categoryId: v.category_id, back: { screen: 'categories' } }, '✓ Varian dihapus permanen. Pesanan lama tetap tersimpan.');
      return this.show(ctx, { screen: 'variant', variantId: v.id, categoryId: v.category_id, back: { screen: 'variants', categoryId: v.category_id } }, '✓ Perubahan tersimpan.');
    }
    if (pending.kind === 'retry') {
      const job = this.local.uncertainById(pending.id);
      if (!job || job.jid !== pending.jid) return this.show(ctx, { screen: 'uncertain', back: { screen: 'system' } }, 'Pesan sudah berubah atau kedaluwarsa.');
      const retried = this.local.retry(job.id);
      return this.show(ctx, { screen: 'uncertain', back: { screen: 'system' } }, retried ? '✓ Pesan masuk antrean pengiriman ulang.' : 'Pesan tidak lagi dapat diulang.');
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
