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
export const optionsText = options => options.map((o, i) => `${i + 1}. ${o.label}`).join('\n');
export function screen(path, body, { page, hasNext = false, root = false, notice = '' } = {}) {
  const navigation = [page > 0 ? '8. Halaman sebelumnya' : '', hasNext ? '9. Halaman berikutnya' : '', root ? '' : '0. Kembali\n00. Beranda'].filter(Boolean).join('\n');
  return `┏━━━━━━━━━━━━━━━━━━━┓\n┃  *MAZY STORE | ADMIN*\n┗━━━━━━━━━━━━━━━━━━━┛\n\n*${path}*${notice ? `\n${notice}` : ''}\n\n${body}${page !== undefined ? `\n\nHalaman ${page + 1}` : ''}\n\n${navigation ? `${navigation}\n\n` : ''}Balas angka untuk memilih.`;
}
export function orderDetails(o) {
  return `*${o.id}*\nBuyer: ${phone(o.buyer)}\nProduk: ${o.product}\nVarian: ${o.variant}\nJumlah: ${o.quantity}\nHarga satuan: ${money(o.unit_price)}\nTotal: *${money(o.total)}*\nDibuat: ${date(o.created_at)}\nStatus: ${statusLabels[o.status]}\n${o.cancel_requested ? '⚠ Ada permintaan pembatalan.\n' : ''}${o.status === 'review' ? `Bukti: ${o.proof_relay === 'sent' ? 'sudah diteruskan ke WA admin' : 'penerusan belum terkonfirmasi'}.\nCari gambar pada notifikasi nomor order ini.\n` : ''}`;
}
export function variantDetails(v) {
  return `*${v.name}*\nHarga: *${money(v.price)}*\nStatus: ${v.archived ? '📁 Diarsipkan' : v.ready ? '🟢 Buka' : '⚪ Tutup'}\n\n*Durasi & ketentuan*\n${v.terms}`;
}
