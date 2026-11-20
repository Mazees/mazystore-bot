import { grid } from './ui.js';

export function waLink(number, message) {
  const phone = String(number).split('@')[0];
  if (!/^[1-9]\d{7,14}$/.test(phone)) throw new Error('Nomor WhatsApp kontak tidak valid.');
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}

export function claimMessage(adminNumber, order) {
  if (order.status !== 'processing') throw new Error('CLAIM hanya tersedia untuk pembayaran yang sudah disetujui dan sedang diproses.');
  return grid('MAZY STORE · CLAIM', [
    `ID Pesanan: ${order.id}\nProduk: ${order.product}\nVarian: ${order.variant}\nJumlah: ${order.quantity}\nStatus: Diproses`,
    'Pembayaran disetujui. Klik link di bawah untuk mengambil barang dan koordinasi OTP langsung dengan admin.',
  ]) + '\n\n' + waLink(adminNumber, `CLAIM\nID Pesanan: ${order.id}`);
}

export function helpMessage(adminNumber, order) {
  if (order?.status === 'processing') return claimMessage(adminNumber, order);
  const text = order ? `Halo admin, saya ingin bertanya tentang pesanan ${order.id}.` : 'Halo admin Mazy Store, saya ingin bertanya tentang produk.';
  return grid('MAZY STORE · HUBUNGI ADMIN', [
    order ? `ID Pesanan: ${order.id}` : 'Bantuan produk & pembayaran',
    'Klik link di bawah untuk chat langsung dengan admin. Pesan dan OTP tidak diteruskan melalui bot.',
  ]) + '\n\n' + waLink(adminNumber, text);
}

export function buyerContact(order) {
  return grid('ADMIN · HUBUNGI BUYER', [`Buyer: ${order.buyer.split('@')[0]}\nID Pesanan: ${order.id}`, 'Klik link di bawah untuk chat langsung. Balasan pada notifikasi bot tidak diteruskan.']) + '\n\n' + waLink(order.buyer, `Halo, saya admin Mazy Store untuk pesanan ${order.id}.`);
}
