export const money = n => `Rp${Number(n).toLocaleString('id-ID')}`;
export const statusLabels = {
  awaiting_payment: 'Menunggu bayar', awaiting_proof: 'Menunggu bukti', review: 'Verifikasi pembayaran',
  processing: 'Sedang diproses', refund_pending: 'Menunggu refund', completed: 'Selesai', cancelled: 'Dibatalkan', refunded: 'Refund selesai',
};
export const phone = buyer => buyer.split('@')[0];
export function date(value) {
  if (!value) return 'Belum ada';
  const parsed = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  return Number.isNaN(parsed.getTime()) ? 'Tidak diketahui' : new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' }).format(parsed);
}
export const optionsText = numbered;
export function screen(path, body, { page, notice = '', options = [], input = false, root = false } = {}) {
  return renderMessage('MAZY STORE · ADMIN', [root ? '' : `*${path}*`, notice, body, page === undefined ? '' : `Halaman ${page + 1}`, options.length ? numbered(options) : '', input ? '/kembali: langkah sebelumnya\n/admin: beranda' : options.length ? 'Balas angka untuk memilih.' : 'Ketik /admin untuk beranda.']);
}
export function orderDetails(o) {
  return `${o.id}\nBuyer: ${phone(o.buyer)}\nProduk: ${o.product}\nVarian: ${o.variant}\nJumlah: ${o.quantity}\nHarga satuan: ${money(o.unit_price)}\nTotal: ${money(o.total)}\nDibuat: ${date(o.created_at)}\nStatus: ${statusLabels[o.status]}\n${o.cancel_requested ? 'Ada permintaan pembatalan.\n' : ''}${o.status === 'review' ? `Bukti: ${o.proof_relay === 'sent' ? 'sudah diteruskan ke WA admin' : 'penerusan belum terkonfirmasi'}.\nCari gambar pada notifikasi nomor order ini.\n` : ''}`;
}
export function variantDetails(v) {
  return `${v.name}\nHarga: ${money(v.price)}\nStatus: ${v.ready ? 'Ready' : 'Kosong'}\n\n*Deskripsi*\n${v.terms}`;
}
import { renderMessage, numbered } from '../ui.js';
