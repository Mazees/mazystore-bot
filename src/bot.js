import { createHash } from "node:crypto";
import { AdminNavigation } from "./admin/navigation.js";

const money = (n) => `Rp${n.toLocaleString("id-ID")}`;
export const labels = {
  awaiting_payment: "Menunggu pembayaran",
  awaiting_proof: "Menunggu bukti",
  review: "Menunggu verifikasi admin",
  processing: "Diproses admin",
  refund_pending: "Menunggu refund",
  completed: "Selesai",
  cancelled: "Dibatalkan",
  refunded: "Refund selesai",
};
const orderText = (o) =>
  `*${o.id}*\n${o.product} — ${o.variant}\nJumlah: ${o.quantity}\nHarga satuan: ${money(o.unit_price)}\nTotal: ${money(o.total)}\nStatus: ${labels[o.status]}${o.cancel_requested ? "\nAda permintaan pembatalan." : ""}`;

export class StoreBot {
  constructor(
    api,
    transport,
    config,
    local,
    runtime = () => ({ whatsapp: Boolean(transport.socket) }),
  ) {
    this.api = api;
    this.transport = transport;
    this.config = config;
    this.local = local;
    this.admin = new AdminNavigation(api, transport, local, runtime);
  }
  async handle(message) {
    let counter = 0;
    const event = `${message.jid}:${message.id}`;
    const say = (text, jid = message.jid, context = null) =>
      this.transport.text(jid, text, `${event}:${counter++}`, context);
    const api = this.api;
    const text = message.text.trim();
    const [rawCommand] = text.split(/\s+/);
    const command = rawCommand.toLowerCase();
    const isAdmin = message.buyer === this.config.adminJid && !message.selfChat;
    if (isAdmin) {
      let owner;
      try { owner = await api.customer(message.buyer); }
      catch { return this.admin.unavailable(message); }
      return this.admin.handle(message, owner);
    }
    const c = await api.customer(message.buyer);
    const context = {
      buyer: c.buyer,
      orderId: c.session.chat
        ? (c.session.chatOrderId ?? c.order?.id ?? null)
        : c.order?.id || null,
      role: "buyer",
    };
    const action = (order, name, extra = {}) =>
      api.action(order.id, {
        action: name,
        key: `${event}:${name}`,
        actor: isAdmin ? "admin" : c.buyer,
        ...extra,
      });
    const session = (state) => api.session(c.buyer, state);
    const adminNotice = (value) => say(value, this.config.adminJid, context);
    const relay = async (target, prefix, ctx) => {
      if (message.image) {
        const buffer = await message.image();
        await this.transport.image(
          target,
          buffer,
          `${prefix}${text ? `\n\n${text.slice(0, 2000)}` : ""}`,
          ctx,
        );
      } else if (text) await say(`${prefix}\n\n${text}`, target, ctx);
      else await say("Pesan yang didukung: teks dan gambar.");
    };

    if (command === "/menu" || command === "/start") {
      await session({ stage: "menu" });
      return this.menu(say);
    }
    if (command === "/pesanan") {
      if (!c.order)
        return say(
          "Tidak ada pesanan aktif. Ketik /menu untuk belanja atau /chat untuk bantuan.",
        );
      await say(orderText(c.order));
      if (c.order.status === "awaiting_payment")
        await this.transport.payment(c.buyer, c.order, `${event}:payment`);
      return;
    }
    if (command === "/chat") {
      await session({
        ...c.session,
        chat: true,
        chatOrderId: c.order?.id || null,
      });
      await adminNotice(
        `*PERMINTAAN CHAT ${c.conversation_id}*\nBuyer: ${c.buyer.split("@")[0]}\n${c.order ? orderText(c.order) : "Belum ada order aktif."}\n\nBalas pesan ini untuk menjawab buyer.`,
      );
      return say(
        "Chat admin aktif. Kirim pesan teks atau gambar; pesanmu akan diteruskan.\n/menu — Belanja\n/akhirichat — Akhiri chat",
      );
    }
    if (command === "/akhirichat") {
      await session({ stage: "menu" });
      return say("Chat diakhiri. Ketik /menu untuk melihat katalog.");
    }
    if (command === "/batal") {
      if (!c.order) return say("Tidak ada order aktif.");
      if (c.order.status === "awaiting_payment") {
        const updated = await action(c.order, "cancel");
        await session({ stage: "menu" });
        await adminNotice(`*ORDER DIBATALKAN BUYER*\n${orderText(updated)}`);
        return say(
          "Pesanan dibatalkan. Jika sudah terlanjur membayar, kirim bukti melalui /chat untuk pemeriksaan admin.",
        );
      }
      if (c.order.status === "refund_pending")
        return say(
          "Refund sedang ditangani admin. Gunakan /chat untuk bantuan.",
        );
      const updated = await action(c.order, "request_cancel");
      await adminNotice(
        `*PERMINTAAN PEMBATALAN*\n${orderText(updated)}\nPeriksa pembayaran dan koordinasikan dengan buyer sebelum menutup order.`,
      );
      return say(
        "Permintaan pembatalan diteruskan ke admin. Order belum dibatalkan; admin akan memeriksa pembayaran terlebih dahulu.",
      );
    }
    if (command === "/done") {
      if (!c.order) return say("Belum ada order aktif. Ketik /menu.");
      if (c.order.status === "awaiting_payment") await action(c.order, "done");
      else if (c.order.status !== "awaiting_proof")
        return say(
          `Status order: ${labels[c.order.status]}. Gunakan /chat untuk bantuan.`,
        );
      return say(
        `Kirim *foto bukti pembayaran* untuk ${c.order.id}.\nPembayaran baru dianggap lunas setelah diperiksa admin.`,
      );
    }
    if (
      message.image &&
      c.order &&
      ["awaiting_payment", "awaiting_proof", "review"].includes(
        c.order.status,
      ) &&
      (!c.session.chat || c.order.status === "awaiting_proof")
    ) {
      if (c.order.status === "awaiting_payment")
        return say(
          "Ketik /done terlebih dahulu, kemudian kirim ulang foto bukti pembayaran.",
        );
      if (c.order.status === "review" && c.order.proof_relay === "sent")
        return say(
          "Bukti sudah diteruskan dan menunggu verifikasi. Gunakan /chat untuk menambahkan keterangan.",
        );
      const buffer = await message.image();
      if (c.order.status === "awaiting_proof")
        await action(c.order, "submit_proof");
      await this.transport.image(
        this.config.adminJid,
        buffer,
        `*BUKTI PEMBAYARAN ${c.order.id}*\nPercakapan: ${c.conversation_id}\nBuyer: ${c.buyer.split("@")[0]}\n${orderText({ ...c.order, status: "review" })}\n\nCek uang masuk, lalu buka /admin → Pesanan & pembayaran → Menunggu verifikasi.\nBalas gambar ini untuk chat buyer.`,
        context,
      );
      await action({ ...c.order, status: "review" }, "proof_sent");
      return say(
        "Bukti berhasil diteruskan ke admin. Menunggu verifikasi pembayaran.",
      );
    }
    if (c.session.chat)
      return relay(
        this.config.adminJid,
        `*CHAT ${c.conversation_id}*\n${context.orderId || "Bantuan umum"}\nBuyer: ${c.buyer.split("@")[0]}\nBalas pesan ini untuk menjawab.`,
        context,
      );
    if (message.image)
      return say("Untuk mengirim gambar ke admin, ketik /chat.");
    if (command.startsWith("/"))
      return say("Perintah tersedia: /menu, /pesanan, /done, /batal, /chat.");
    if (c.order)
      return say(
        `${orderText(c.order)}\n\n${c.order.status === "awaiting_payment" ? "Setelah membayar, ketik /done." : c.order.status === "awaiting_proof" ? "Kirim foto bukti pembayaran." : "Gunakan /chat untuk berkomunikasi dengan admin."}`,
      );
    const state = c.session;
    if (text === "0") {
      await session({ stage: "menu" });
      return this.menu(say);
    }
    if (state.stage === "quantity") {
      const quantity = Number(text);
      if (
        !/^\d+$/.test(text) ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        quantity > this.config.maxQuantity
      )
        return say(
          `Masukkan jumlah bulat 1–${this.config.maxQuantity}.\n0 — Kembali`,
        );
      const { variants, categories } = await api.catalog();
      const variant = variants.find((v) => v.id === state.variantId);
      if (!variant?.ready) {
        await session({ stage: "menu" });
        return say("Varian sedang ditutup. Ketik /menu.");
      }
      const product = categories.find((cat) => cat.id === variant.category_id);
      await session({
        stage: "confirm",
        variantId: variant.id,
        quantity,
        price: variant.price,
        terms: variant.terms,
      });
      return say(
        `*RINGKASAN PESANAN*\n${product.name}\nVarian: ${variant.name}\nHarga satuan: ${money(variant.price)}\nJumlah: ${quantity}\nTotal: ${money(variant.price * quantity)}\n\n${variant.terms}\n\n1 — Konfirmasi dan bayar\n0 — Kembali`,
      );
    }
    if (state.stage === "confirm") {
      if (text !== "1") return say("1 — Konfirmasi dan bayar\n0 — Kembali");
      const { variants } = await api.catalog();
      const variant = variants.find((v) => v.id === state.variantId);
      if (!variant?.ready) {
        await session({ stage: "menu" });
        return say("Varian sedang ditutup. Ketik /menu.");
      }
      if (variant.price !== state.price || variant.terms !== state.terms) {
        await session({ stage: "quantity", variantId: variant.id });
        return say(
          "Harga atau ketentuan berubah. Masukkan ulang jumlah untuk melihat ringkasan terbaru.",
        );
      }
      const order = await api.createOrder({
        key: event,
        buyer: c.buyer,
        variantId: variant.id,
        quantity: state.quantity,
        expectedPrice: state.price,
        expectedTerms: state.terms,
        qrisVersion: createHash("sha256")
          .update(this.config.qris)
          .digest("hex"),
      });
      await say(orderText(order));
      await this.transport.payment(c.buyer, order, `${event}:payment`);
      await adminNotice(
        `*ORDER BARU*\nPercakapan: ${c.conversation_id}\n${orderText(order)}\nBuyer belum diverifikasi membayar.`,
      );
      await session({ stage: "ordered" });
      return;
    }
    if (state.stage === "variant") {
      if (!/^\d+$/.test(text))
        return say("Balas nomor varian atau 0 untuk kembali.");
      const variantId = state.options?.[Number(text) - 1];
      const { variants } = await api.catalog();
      const variant = variants.find((v) => v.id === variantId);
      if (!variant) return say("Nomor varian tidak tersedia.");
      if (!variant.ready)
        return say(
          "Varian sedang ditutup. Pilih varian lain atau ketik /menu.",
        );
      await session({ stage: "quantity", variantId: variant.id });
      return say(
        `*${variant.name}*\n${money(variant.price)} per unit\n${variant.terms}\n\nMasukkan jumlah pembelian (1–${this.config.maxQuantity}).\n0 — Kembali`,
      );
    }
    if (/^[1-7]$/.test(text)) {
      const { categories, variants } = await api.catalog();
      const category = categories.find((cat) => cat.id === Number(text));
      const options = variants.filter((v) => v.category_id === category.id);
      await session({ stage: "variant", options: options.map((v) => v.id) });
      return say(
        `*${category.name}*\n\n${options.map((v, i) => `${i + 1}. ${v.name}\n${money(v.price)} — ${v.ready ? "Tersedia" : "Tidak tersedia"}\n${v.terms}`).join("\n\n") || "Paket belum tersedia. Hubungi admin melalui /chat."}\n\nBalas nomor varian.\n0 — Kembali\n/menu — Menu utama`,
      );
    }
    await session({ stage: "menu" });
    return this.menu(say);
  }

  async menu(say) {
    const { categories, variants } = await this.api.catalog();
    return say(
      `┏━━━━━━━━━━━━━━━━━━━┓\n┃  *MAZY STORE | MENU*\n┗━━━━━━━━━━━━━━━━━━━┛\n\n*KATALOG PRODUK DIGITAL & AI*\n────────────────────\n${categories
        .map((cat) => {
          const ready = variants.filter(
            (v) => v.category_id === cat.id && v.ready,
          );
          return `┌  *${String(cat.id).padStart(2, "0")} | ${cat.name}*\n└  ${ready.length ? `Mulai ${money(Math.min(...ready.map((v) => v.price)))}` : "Belum tersedia"}`;
        })
        .join(
          "\n\n",
        )}\n\n━━━━━━━━━━━━━━━━━━━━\n*CARA PILIH PRODUK*\nBalas angka *1 sampai 7* untuk detail produk.\n/pesanan — Cek pesanan\n/chat — Hubungi admin`,
    );
  }
}
