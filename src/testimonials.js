import { renderMessage } from './ui.js';
import { date, money } from './admin/render.js';

const SETTINGS_KEY = 'settings:autotesti';

async function bounded(operation) {
  let timer;
  try {
    return await Promise.race([operation(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Waktu tunggu saluran habis.')), 15000);
    })]);
  } finally { clearTimeout(timer); }
}

export class Testimonials {
  constructor(store, transport) { this.store = store; this.transport = transport; }
  settings() { return this.store.authGet(SETTINGS_KEY) || { enabled: false }; }

  async access(type, key) {
    const socket = this.transport.socket;
    if (!socket) throw new Error('WhatsApp belum terhubung. Coba lagi setelah tersambung.');
    let metadata;
    try { metadata = await bounded(() => socket.newsletterMetadata(type, key)); }
    catch { throw new Error('Metadata saluran belum dapat diperiksa. Periksa koneksi dan link saluran.'); }
    if (!metadata || !/^\d+@newsletter$/.test(metadata.id)) throw new Error('Saluran tidak ditemukan atau metadata saluran tidak valid.');
    if (type === 'jid' && metadata.id !== key) throw new Error('Metadata tidak cocok dengan saluran yang dipilih.');
    // Invite metadata may omit the current account's role; verify it through the resolved JID.
    if (type === 'invite') return { ...metadata, ...await this.access('jid', metadata.id) };
    const rawRole = metadata.viewer_metadata?.role;
    const role = typeof rawRole === 'string' ? rawRole.trim().toUpperCase() : '';
    if (role === 'SUBSCRIBER' || role === 'GUEST') {
      throw Object.assign(new Error('Nomor bot bukan admin saluran. Jadikan bot ADMIN atau OWNER terlebih dahulu.'), { accessDenied: true });
    }
    if (!['ADMIN','OWNER'].includes(role)) throw new Error('Hak admin bot tidak dapat dipastikan. Pengaturan tidak diubah.');
    return metadata;
  }

  async setChannel(input) {
    let url;
    try { url = new URL(input); } catch { throw new Error('Masukkan link https://whatsapp.com/channel/... yang valid.'); }
    const invite = url.pathname.match(/^\/channel\/([A-Za-z0-9_-]+)\/?$/)?.[1];
    if (url.protocol !== 'https:' || !['whatsapp.com','www.whatsapp.com'].includes(url.hostname) || url.username || url.password || url.port || !invite) {
      throw new Error('Gunakan link saluran https://whatsapp.com/channel/... yang valid.');
    }
    const metadata = await this.access('invite', invite);
    const name = metadata.name || metadata.thread_metadata?.name;
    const settings = { enabled: this.settings().enabled, jid: metadata.id, name: typeof name === 'string' ? name : name?.text || 'Saluran WhatsApp', link: `https://whatsapp.com/channel/${invite}` };
    this.store.authSet(SETTINGS_KEY, settings);
    return settings;
  }

  async setEnabled(enabled) {
    const settings = this.settings();
    if (enabled) {
      if (!settings.jid) throw new Error('Atur saluran terlebih dahulu.');
      await this.access('jid', settings.jid);
    }
    this.store.authSet(SETTINGS_KEY, { ...settings, enabled });
  }

  async post(order) {
    let settings;
    let sending = false;
    try {
      if (order.status !== 'completed') return { status: 'failed', message: 'Testimoni hanya dapat diposting untuk order Selesai.' };
      settings = this.settings();
      if (!settings.enabled) return { status: 'disabled', message: 'Autotesti Nonaktif. Aktifkan melalui /admin → Autotesti saluran.' };
      if (!settings.jid) return { status: 'failed', message: 'Saluran belum diatur.' };
      await this.access('jid', settings.jid);
      const buyer = String(order.buyer || '').split('@')[0];
      const visible = buyer.length > 10 ? [5,3] : [2,2];
      const maskedBuyer = /^\d{8,15}$/.test(buyer) ? buyer.slice(0, visible[0]) + '•'.repeat(buyer.length - visible[0] - visible[1]) + buyer.slice(-visible[1]) : 'Disamarkan';
      const text = renderMessage('MAZY STORE | TESTIMONI', [
        `ID: ${order.id}\nBuyer: ${maskedBuyer}\nProduk: ${order.product}\nVarian: ${order.variant}\nJumlah: ${order.quantity}\nTotal: ${money(order.total)}\nStatus: Selesai\nWaktu selesai: ${date(order.updated_at)} WIB`,
      ]);
      sending = true;
      const sent = await bounded(() => this.transport.send(settings.jid, { text }));
      if (!sent?.key?.id) throw new Error('Pengiriman belum terkonfirmasi.');
      return { status: 'sent', message: `✓ Testimoni dikirim ke ${settings.name}.` };
    } catch (error) {
      if (error.accessDenied && settings) {
        this.store.authSet(SETTINGS_KEY, { ...settings, enabled: false });
        return { status: 'failed', message: 'Bot bukan lagi admin saluran. Autotesti dinonaktifkan; jadikan bot admin lalu aktifkan kembali.' };
      }
      return sending
        ? { status: 'uncertain', message: 'Pengiriman testimoni belum dapat dipastikan; posting mungkin sudah masuk. Periksa saluran sebelum mengulang /post. Tidak ada pengiriman ulang otomatis.' }
        : { status: 'failed', message: 'Testimoni gagal diperiksa/dikirim. Periksa koneksi dan akses admin saluran, lalu coba /post dari detail order Selesai.' };
    }
  }
}
