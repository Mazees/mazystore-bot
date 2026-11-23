import { orderStatus, money } from './render.js';
import { claimMessage } from '../contact.js';
import { renderMessage } from '../ui.js';

export function orderActions(order) {
  const choices = [];
  if (order.cancel_requested && ['awaiting_proof','review','processing'].includes(order.status)) choices.push({ id: 'clear_cancel', label: 'Lanjutkan setelah kesepakatan buyer' });
  if (order.status === 'review') {
    if (!order.cancel_requested) choices.push({ id: 'approve', label: 'Setujui pembayaran' });
    choices.push({ id: 'reject_proof', label: 'Minta bukti ulang' });
  }
  if (order.status === 'processing') choices.push({ id: 'complete', label: 'Tandai pesanan selesai' }, { id: 'refund', label: 'Tawarkan refund ke buyer' });
  if (['awaiting_payment','awaiting_proof','review'].includes(order.status)) choices.push({ id: 'cancel', label: 'Batalkan pesanan' });
  if (order.status === 'refund_pending' && order.refund_accepted) choices.push({ id: 'refund_complete', label: 'Tandai uang refund dikembalikan' });
  choices.push({ id: 'contact', label: 'Hubungi buyer' });
  return choices;
}
export const actionLabels = {
  approve: 'Setujui pembayaran', reject_proof: 'Minta bukti ulang', complete: 'Selesaikan pesanan',
  refund: 'Tawarkan refund ke buyer', refund_complete: 'Konfirmasi refund selesai', cancel: 'Batalkan pesanan', clear_cancel: 'Lanjutkan setelah kesepakatan buyer',
};
export const requiresReason = action => ['reject_proof','cancel','refund'].includes(action);
export async function executeOrderAction(api, order, pending) {
  return api.action(order.id, { key: pending.key, action: pending.action, actor: 'admin', reason: pending.reason || '', expectedVersion: pending.version });
}
export async function notifyOrderAction(api, updated, pending, send, adminNumber) {
  const content = pending.action === 'approve' && updated.delivery_mode !== 'auto'
    ? await claimMessage(api, adminNumber, updated)
    : renderMessage('MAZY STORE · PESANAN', [`ID Pesanan: ${updated.id}\nStatus: ${orderStatus(updated)}`, pending.reason ? `Catatan admin: ${pending.reason}` : '', pending.action === 'approve' && updated.delivery_mode === 'auto' ? 'Pembayaran disetujui. Barang dari stok sedang disiapkan untuk dikirim otomatis. Status menjadi Selesai setelah seluruh barang berhasil dikirim bot.' : pending.action === 'refund' ? `Admin menawarkan refund sebesar ${money(updated.total)}. Uang belum dikembalikan.\n/setujui - Setujui refund agar admin dapat mengembalikan uang\n/chat - Hubungi admin jika belum sepakat` : pending.action === 'reject_proof' ? 'Silakan kirim ulang foto bukti pembayaran.\n/batal - Batalkan pesanan langsung' : pending.action === 'clear_cancel' ? 'Permintaan pembatalan ditutup sesuai kesepakatan.' : '/pesanan untuk melihat status.']);
  await send(updated.buyer, content, { buyer: updated.buyer, orderId: updated.id, role: 'admin', kind: 'relay', purpose: 'transaction' });
}
