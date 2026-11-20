import { createHash } from 'node:crypto';

const money = n => `Rp${n.toLocaleString('id-ID')}`;
export const labels = {
  awaiting_payment: 'Menunggu pembayaran', awaiting_proof: 'Menunggu bukti', review: 'Menunggu verifikasi admin',
  processing: 'Diproses admin', refund_pending: 'Menunggu refund', completed: 'Selesai', cancelled: 'Dibatalkan', refunded: 'Refund selesai',
};
const orderText = o => `*${o.id}*\n${o.product} — ${o.variant}\nJumlah: ${o.quantity}\nHarga satuan: ${money(o.unit_price)}\nTotal: ${money(o.total)}\nStatus: ${labels[o.status]}${o.cancel_requested ? '\nAda permintaan pembatalan.' : ''}`;

export class StoreBot {
  constructor(api, transport, config, local) { this.api = api; this.transport = transport; this.config = config; this.local = local; }
  async handle(message) {
    let counter = 0;
    const event = `${message.jid}:${message.id}`;
    const say = (text, jid = message.jid, context = null) => this.transport.text(jid, text, `${event}:${counter++}`, context);
    const api = this.api;
    const text = message.text.trim();
    const [rawCommand, ...args] = text.split(/\s+/);
    const command = rawCommand.toLowerCase();
    const isAdmin = message.buyer === this.config.adminJid;
    const c = await api.customer(message.buyer);
    const context = { buyer: c.buyer, orderId: c.session.chat ? (c.session.chatOrderId ?? c.order?.id ?? null) : (c.order?.id || null), role: 'buyer' };
    const action = (order, name, extra = {}) => api.action(order.id, { action: name, key: `${event}:${name}`, actor: isAdmin ? 'admin' : c.buyer, ...extra });
    const session = state => api.session(c.buyer, state);
    const adminNotice = value => say(value, this.config.adminJid, context);
    const relay = async (target, prefix, ctx) => {
      if (message.image) {
        const buffer = await message.image();
        await this.transport.image(target, buffer, `${prefix}${text ? `\n\n${text.slice(0, 2000)}` : ''}`, ctx);
      } else if (text) await say(`${prefix}\n\n${text}`, target, ctx);
      else await say('Pesan yang didukung: teks dan gambar.');
    };

    if (isAdmin) {
      if (message.quotedId && !command.startsWith('/')) {
        const ref = await api.message(message.buyer, message.quotedId);
        const target = await api.customer(ref.buyer);
        await api.session(ref.buyer, { ...target.session, chat: true, chatOrderId: ref.order_id || null });
        await relay(ref.buyer, '*Admin Mazy Store*', { buyer: ref.buyer, orderId: ref.order_id, role: 'admin' });
        return;
      }
      if (command === '/balas') {
        const target = await api.conversation(args[0]);
        const content = args.slice(1).join(' ');
        if (!content) return say('Format: /balas <C-id> <pesan>\nUntuk gambar, balas langsung pesan buyer.');
        await api.session(target.buyer, { ...target.session, chat: true, chatOrderId: target.order?.id || null });
        await say(`*Admin Mazy Store*\n\n${content}`, target.buyer, { buyer: target.buyer, orderId: target.order?.id || null, role: 'admin' });
        return say('Balasan masuk antrean pengiriman.');
      }
      if (command === '/batalsetup') { await session({}); return say('Pengisian varian dibatalkan.'); }
      if (command === '/tambahvarian' || command === '/ubahvarian') {
        if (command === '/ubahvarian' && !args[0]) return say('Format: /ubahvarian <kode-varian>');
        let draft = {};
        if (args[0]) {
          draft = (await api.catalog()).variants.find(v => v.id === args[0]);
          if (!draft) return say('Kode varian tidak ditemukan.');
        }
        await session({ wizard: { mode: command === '/tambahvarian' ? 'add' : 'edit', step: command === '/tambahvarian' ? 'id' : 'categoryId', draft } });
        return say(command === '/tambahvarian' ? 'Ketik kode varian (huruf kecil/angka/tanda -), misalnya gpt-api-5usd.\n/batalsetup untuk berhenti.' : 'Ketik nomor kategori 1–7.');
      }
      if (c.session.wizard && !command.startsWith('/')) return this.wizard(c, text, say);
      if (command === '/produk') {
        const { categories, variants } = await api.catalog();
        return say(categories.map(cat => `${cat.id}. *${cat.name}*\n${variants.filter(v => v.category_id === cat.id).map(v => `${v.id}\n${v.name} — ${money(v.price)} — ${v.ready ? 'READY' : 'TUTUP'}\n${v.terms}`).join('\n') || 'Belum ada varian.'}`).join('\n\n'));
      }
      if (command === '/harga' || command === '/ready') {
        const value = args[1];
        if (!args[0] || (command === '/ready' ? !['on', 'off'].includes(value) : !/^\d+$/.test(value || ''))) return say(`Format: ${command} <kode-varian> ${command === '/ready' ? 'on|off' : '<harga-rupiah>'}`);
        const result = await api.variant(command === '/harga' ? { id: args[0], mode: 'price', price: Number(value) } : { id: args[0], mode: 'ready', ready: value === 'on' });
        return say(`${result.id}: ${money(result.price)}, ${result.ready ? 'READY' : 'TUTUP'}.`);
      }
      if (command === '/order') {
        if (args[0]) return say(orderText(await api.order(args[0])));
        const { orders } = await api.orders();
        return say(orders.length ? orders.map(orderText).join('\n\n') : 'Tidak ada order aktif.');
      }
      const actions = { '/setujui': 'approve', '/tolakbukti': 'reject_proof', '/selesai': 'complete', '/batalkan': 'cancel', '/refund': 'refund', '/refundselesai': 'refund_complete' };
      if (actions[command]) {
        if (!args[0]) return say(`Format: ${command} <nomor-order> [alasan]`);
        const before = await api.order(args[0]);
        if (actions[command] === 'approve' && before.cancel_requested) return say('Buyer meminta pembatalan. Selesaikan permintaan melalui chat, lalu gunakan /lanjutkan <order> untuk menghapus permintaan sebelum menyetujui.');
        const updated = await action(before, actions[command], { reason: args.slice(1).join(' ') });
        if (['approve', 'reject_proof'].includes(actions[command])) {
          const target = await api.customer(updated.buyer);
          await api.session(updated.buyer, { ...target.session, chat: actions[command] === 'approve', chatOrderId: updated.id });
        }
        await say(`${orderText(updated)}${actions[command] === 'approve' ? '\n\nPembayaran disetujui. Chat admin aktif; balasanmu akan diteruskan. /menu untuk kembali berbelanja.' : actions[command] === 'reject_proof' ? '\n\nSilakan kirim ulang foto bukti pembayaran.' : ''}${args.length > 1 ? `\nCatatan admin: ${args.slice(1).join(' ')}` : ''}`, updated.buyer, { buyer: updated.buyer, orderId: updated.id, role: 'admin' });
        return say(orderText(updated));
      }
      if (command === '/lanjutkan') {
        if (!args[0]) return say('Format: /lanjutkan <nomor-order>');
        const updated = await action(await api.order(args[0]), 'clear_cancel');
        return say(orderText(updated));
      }
      if (command === '/gagalkirim') {
        const rows = this.local.uncertain();
        return say(rows.length ? rows.map(r => `${r.id}\nTujuan: ${r.jid}`).join('\n\n') + '\n\nCek chat tujuan sebelum /ulang <id>; pengiriman sebelumnya mungkin sudah masuk.' : 'Tidak ada pengiriman meragukan.');
      }
      if (command === '/ulang') return say(this.local.retry(args.join(' ')) ? 'Pesan dimasukkan ulang ke antrean.' : 'ID tidak ditemukan atau bukan pesan meragukan.');
      return say('*ADMIN MAZY STORE*\n/produk\n/tambahvarian\n/ubahvarian <kode>\n/harga <kode> <nominal>\n/ready <kode> on|off\n/order [nomor]\n/setujui <nomor>\n/tolakbukti <nomor> <alasan>\n/selesai <nomor>\n/batalkan <nomor> <alasan>\n/refund <nomor> <alasan>\n/refundselesai <nomor>\n/lanjutkan <nomor>\n/balas <C-id> <pesan>\n/gagalkirim\n/ulang <id>\n\nBalas pesan buyer untuk meneruskan teks/gambar kepadanya.');
    }

    if (command === '/menu' || command === '/start') {
      await session({ stage: 'menu' });
      return this.menu(say);
    }
    if (command === '/pesanan') {
      if (!c.order) return say('Tidak ada pesanan aktif. Ketik /menu untuk belanja atau /chat untuk bantuan.');
      await say(orderText(c.order));
      if (c.order.status === 'awaiting_payment') await this.transport.payment(c.buyer, c.order, `${event}:payment`);
      return;
    }
    if (command === '/chat') {
      await session({ ...c.session, chat: true, chatOrderId: c.order?.id || null });
      await adminNotice(`*PERMINTAAN CHAT ${c.conversation_id}*\nBuyer: ${c.buyer.split('@')[0]}\n${c.order ? orderText(c.order) : 'Belum ada order aktif.'}\n\nBalas pesan ini untuk menjawab buyer.`);
      return say('Chat admin aktif. Kirim pesan teks atau gambar; pesanmu akan diteruskan.\n/menu — Belanja\n/akhirichat — Akhiri chat');
    }
    if (command === '/akhirichat') { await session({ stage: 'menu' }); return say('Chat diakhiri. Ketik /menu untuk melihat katalog.'); }
    if (command === '/batal') {
      if (!c.order) return say('Tidak ada order aktif.');
      if (c.order.status === 'awaiting_payment') {
        const updated = await action(c.order, 'cancel');
        await session({ stage: 'menu' });
        await adminNotice(`*ORDER DIBATALKAN BUYER*\n${orderText(updated)}`);
        return say('Pesanan dibatalkan. Jika sudah terlanjur membayar, kirim bukti melalui /chat untuk pemeriksaan admin.');
      }
      if (c.order.status === 'refund_pending') return say('Refund sedang ditangani admin. Gunakan /chat untuk bantuan.');
      const updated = await action(c.order, 'request_cancel');
      await adminNotice(`*PERMINTAAN PEMBATALAN*\n${orderText(updated)}\nPeriksa pembayaran dan koordinasikan dengan buyer sebelum menutup order.`);
      return say('Permintaan pembatalan diteruskan ke admin. Order belum dibatalkan; admin akan memeriksa pembayaran terlebih dahulu.');
    }
    if (command === '/done') {
      if (!c.order) return say('Belum ada order aktif. Ketik /menu.');
      if (c.order.status === 'awaiting_payment') await action(c.order, 'done');
      else if (c.order.status !== 'awaiting_proof') return say(`Status order: ${labels[c.order.status]}. Gunakan /chat untuk bantuan.`);
      return say(`Kirim *foto bukti pembayaran* untuk ${c.order.id}.\nPembayaran baru dianggap lunas setelah diperiksa admin.`);
    }
    if (message.image && c.order && ['awaiting_payment','awaiting_proof','review'].includes(c.order.status) && (!c.session.chat || c.order.status === 'awaiting_proof')) {
      if (c.order.status === 'awaiting_payment') return say('Ketik /done terlebih dahulu, kemudian kirim ulang foto bukti pembayaran.');
      if (c.order.status === 'review' && c.order.proof_relay === 'sent') return say('Bukti sudah diteruskan dan menunggu verifikasi. Gunakan /chat untuk menambahkan keterangan.');
      const buffer = await message.image();
      if (c.order.status === 'awaiting_proof') await action(c.order, 'submit_proof');
      await this.transport.image(this.config.adminJid, buffer, `*BUKTI PEMBAYARAN ${c.order.id}*\nPercakapan: ${c.conversation_id}\nBuyer: ${c.buyer.split('@')[0]}\n${orderText({ ...c.order, status: 'review' })}\n\nCek uang masuk, lalu:\n/setujui ${c.order.id}\n/tolakbukti ${c.order.id} <alasan>`, context);
      await action({ ...c.order, status: 'review' }, 'proof_sent');
      return say('Bukti berhasil diteruskan ke admin. Menunggu verifikasi pembayaran.');
    }
    if (c.session.chat) return relay(this.config.adminJid, `*CHAT ${c.conversation_id}*\n${context.orderId || 'Bantuan umum'}\nBuyer: ${c.buyer.split('@')[0]}\nBalas pesan ini untuk menjawab.`, context);
    if (message.image) return say('Untuk mengirim gambar ke admin, ketik /chat.');
    if (command.startsWith('/')) return say('Perintah tersedia: /menu, /pesanan, /done, /batal, /chat.');
    if (c.order) return say(`${orderText(c.order)}\n\n${c.order.status === 'awaiting_payment' ? 'Setelah membayar, ketik /done.' : c.order.status === 'awaiting_proof' ? 'Kirim foto bukti pembayaran.' : 'Gunakan /chat untuk berkomunikasi dengan admin.'}`);
    const state = c.session;
    if (text === '0') {
      await session({ stage: 'menu' });
      return this.menu(say);
    }
    if (state.stage === 'quantity') {
      const quantity = Number(text);
      if (!/^\d+$/.test(text) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > this.config.maxQuantity) return say(`Masukkan jumlah bulat 1–${this.config.maxQuantity}.\n0 — Kembali`);
      const { variants, categories } = await api.catalog();
      const variant = variants.find(v => v.id === state.variantId);
      if (!variant?.ready) { await session({ stage: 'menu' }); return say('Varian sedang ditutup. Ketik /menu.'); }
      const product = categories.find(cat => cat.id === variant.category_id);
      await session({ stage: 'confirm', variantId: variant.id, quantity, price: variant.price, terms: variant.terms });
      return say(`*RINGKASAN PESANAN*\n${product.name}\nVarian: ${variant.name}\nHarga satuan: ${money(variant.price)}\nJumlah: ${quantity}\nTotal: ${money(variant.price * quantity)}\n\n${variant.terms}\n\n1 — Konfirmasi dan bayar\n0 — Kembali`);
    }
    if (state.stage === 'confirm') {
      if (text !== '1') return say('1 — Konfirmasi dan bayar\n0 — Kembali');
      const { variants } = await api.catalog();
      const variant = variants.find(v => v.id === state.variantId);
      if (!variant?.ready) { await session({ stage: 'menu' }); return say('Varian sedang ditutup. Ketik /menu.'); }
      if (variant.price !== state.price || variant.terms !== state.terms) {
        await session({ stage: 'quantity', variantId: variant.id });
        return say('Harga atau ketentuan berubah. Masukkan ulang jumlah untuk melihat ringkasan terbaru.');
      }
      const order = await api.createOrder({ key: event, buyer: c.buyer, variantId: variant.id, quantity: state.quantity, expectedPrice: state.price, expectedTerms: state.terms, qrisVersion: createHash('sha256').update(this.config.qris).digest('hex') });
      await say(orderText(order));
      await this.transport.payment(c.buyer, order, `${event}:payment`);
      await adminNotice(`*ORDER BARU*\nPercakapan: ${c.conversation_id}\n${orderText(order)}\nBuyer belum diverifikasi membayar.`);
      await session({ stage: 'ordered' });
      return;
    }
    if (state.stage === 'variant') {
      if (!/^\d+$/.test(text)) return say('Balas nomor varian atau 0 untuk kembali.');
      const variantId = state.options?.[Number(text) - 1];
      const { variants } = await api.catalog();
      const variant = variants.find(v => v.id === variantId);
      if (!variant) return say('Nomor varian tidak tersedia.');
      if (!variant.ready) return say('Varian sedang ditutup. Pilih varian lain atau ketik /menu.');
      await session({ stage: 'quantity', variantId: variant.id });
      return say(`*${variant.name}*\n${money(variant.price)} per unit\n${variant.terms}\n\nMasukkan jumlah pembelian (1–${this.config.maxQuantity}).\n0 — Kembali`);
    }
    if (/^[1-7]$/.test(text)) {
      const { categories, variants } = await api.catalog();
      const category = categories.find(cat => cat.id === Number(text));
      const options = variants.filter(v => v.category_id === category.id);
      await session({ stage: 'variant', options: options.map(v => v.id) });
      return say(`*${category.name}*\n\n${options.map((v, i) => `${i + 1}. ${v.name}\n${money(v.price)} — ${v.ready ? 'Tersedia' : 'Tidak tersedia'}\n${v.terms}`).join('\n\n') || 'Paket belum tersedia. Hubungi admin melalui /chat.'}\n\nBalas nomor varian.\n0 — Kembali\n/menu — Menu utama`);
    }
    await session({ stage: 'menu' });
    return this.menu(say);
  }

  async menu(say) {
    const { categories, variants } = await this.api.catalog();
    return say(`┏━━━━━━━━━━━━━━━━━━━┓\n┃  *MAZY STORE | MENU*\n┗━━━━━━━━━━━━━━━━━━━┛\n\n*KATALOG PRODUK DIGITAL & AI*\n────────────────────\n${categories.map(cat => {
      const ready = variants.filter(v => v.category_id === cat.id && v.ready);
      return `┌  *${String(cat.id).padStart(2, '0')} | ${cat.name}*\n└  ${ready.length ? `Mulai ${money(Math.min(...ready.map(v => v.price)))}` : 'Belum tersedia'}`;
    }).join('\n\n')}\n\n━━━━━━━━━━━━━━━━━━━━\n*CARA PILIH PRODUK*\nBalas angka *1 sampai 7* untuk detail produk.\n/pesanan — Cek pesanan\n/chat — Hubungi admin`);
  }

  async wizard(c, value, say) {
    const wizard = structuredClone(c.session.wizard);
    const { step, draft } = wizard;
    const prompts = { categoryId: 'Ketik nomor kategori 1–7.', name: 'Ketik nama varian (maksimal 120 karakter).', price: 'Ketik harga dalam rupiah, angka saja.', terms: 'Ketik durasi dan ketentuan layanan (maksimal 2000 karakter).', confirm: 'Ketik SIMPAN untuk menyimpan, atau /batalsetup.' };
    const steps = ['id', 'categoryId', 'name', 'price', 'terms', 'confirm'];
    if (step === 'confirm') {
      if (value.toUpperCase() !== 'SIMPAN') return say(prompts.confirm);
      const result = await this.api.variant({ ...draft, categoryId: Number(draft.categoryId), mode: wizard.mode });
      await this.api.session(c.buyer, {});
      return say(`Varian ${result.id} disimpan. Status: ${result.ready ? 'READY' : 'TUTUP'}.\nGunakan /ready ${result.id} on setelah memeriksa detailnya.`);
    }
    if (step === 'id') {
      if (!/^[a-z0-9-]{1,64}$/.test(value)) return say('Kode hanya huruf kecil, angka, dan tanda -, maksimal 64 karakter.');
      if ((await this.api.catalog()).variants.some(v => v.id === value)) return say('Kode sudah ada. Gunakan kode lain atau /ubahvarian.');
      draft.id = value;
    } else if (step === 'categoryId') {
      if (!/^[1-7]$/.test(value)) return say(prompts.categoryId);
      draft.categoryId = Number(value);
    } else if (step === 'price') {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 9999999999) return say('Harga harus bilangan bulat 1–9999999999.');
      draft.price = Number(value);
    } else {
      if (!value || value.length > (step === 'name' ? 120 : 2000)) return say(prompts[step]);
      draft[step] = value;
    }
    wizard.step = steps[steps.indexOf(step) + 1];
    await this.api.session(c.buyer, { wizard });
    return say(wizard.step === 'confirm' ? `${draft.id}\nKategori: ${draft.categoryId}\n${draft.name}\n${money(draft.price)}\n${draft.terms}\n\n${prompts.confirm}` : prompts[wizard.step]);
  }
}
