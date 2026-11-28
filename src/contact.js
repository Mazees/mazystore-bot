import { renderMessage } from './ui.js';

export function waLink(number, message) {
  const phone = String(number).split('@')[0];
  if (!/^[1-9]\d{7,14}$/.test(phone)) throw new Error('Nomor WhatsApp kontak tidak valid.');
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}

export function claimDestination(adminNumber, order) {
  if (order.status !== 'processing' || order.delivery_mode === 'auto') throw new Error('CLAIM hanya tersedia untuk pembayaran yang sudah disetujui dan sedang diproses.');
  const claim = renderMessage('CLAIM PEMBELIAN', [
    `ID: ${order.id}\nBuyer: ${order.buyer.split('@')[0]}\nProduk: ${order.product}\nVarian: ${order.variant}\nJumlah: ${order.quantity}\nTotal: Rp${Number(order.total).toLocaleString('id-ID')}`,
  ]) + '\n\n────────────────────';
  return waLink(adminNumber, claim);
}

export async function claimMessage(api, adminNumber, order) {
  if (order.status !== 'processing') throw new Error('CLAIM hanya tersedia untuk pembayaran yang sudah disetujui dan sedang diproses.');
  const { url } = await api.claimLink(order.id, adminNumber);
  const fallback = url === `https://wa.me/${adminNumber}`;
  return renderMessage('MAZY STORE · CLAIM', [
    `Klik link untuk CLAIM ke admin:\n${url}`,
    `ID Pesanan: ${order.id}\nProduk: ${order.product}\nVarian: ${order.variant}\nJumlah: ${order.quantity}\nTotal: Rp${Number(order.total).toLocaleString('id-ID')}\nStatus: Diproses`,
    fallback ? 'Pembayaran disetujui. Shortlink belum tersedia. Buka chat admin melalui link di atas, lalu kirim ID pesanan ini untuk CLAIM.' : 'Pembayaran disetujui. Link membuka WA admin dengan rincian CLAIM lengkap untuk penyerahan barang dan koordinasi OTP.',
  ]);
}

export function helpMessage(adminNumber) {
  const text = 'Halo admin Mazy Store, saya ingin bertanya tentang produk.';
  return renderMessage('MAZY STORE · HUBUNGI ADMIN', [
    'Bantuan produk & pembayaran',
    'Klik link di bawah untuk chat langsung dengan admin:',
  ]) + '\n\n' + waLink(adminNumber, text);
}

export function buyerContact(order) {
  return renderMessage('ADMIN · HUBUNGI BUYER', [`Buyer: ${order.buyer.split('@')[0]}\nID Pesanan: ${order.id}`, 'Klik link di bawah untuk chat langsung. Balasan pada notifikasi bot tidak diteruskan.']) + '\n\n' + waLink(order.buyer, `Halo, saya admin Mazy Store untuk pesanan ${order.id}.`);
}
