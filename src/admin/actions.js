import { statusLabels } from './render.js';

export function orderActions(order) {
  const choices = [];
  if (order.cancel_requested && ['awaiting_proof','review','processing'].includes(order.status)) choices.push({ id: 'clear_cancel', label: 'Lanjutkan setelah kesepakatan buyer' });
  if (order.status === 'review') {
    if (!order.cancel_requested) choices.push({ id: 'approve', label: 'Setujui pembayaran' });
    choices.push({ id: 'reject_proof', label: 'Minta bukti ulang' });
  }
  if (order.status === 'processing') choices.push({ id: 'complete', label: 'Tandai seluruh pesanan selesai' }, { id: 'refund', label: 'Mulai refund' });
  if (['awaiting_payment','awaiting_proof','review'].includes(order.status)) choices.push({ id: 'cancel', label: 'Batalkan pesanan' });
  if (order.status === 'refund_pending') choices.push({ id: 'refund_complete', label: 'Konfirmasi uang refund dikembalikan' });
  choices.push({ id: 'contact', label: 'Hubungi buyer' });
  return choices;
}
export const actionLabels = {
  approve: 'Setujui pembayaran', reject_proof: 'Minta bukti ulang', complete: 'Selesaikan pesanan',
  refund: 'Mulai refund', refund_complete: 'Konfirmasi refund selesai', cancel: 'Batalkan pesanan', clear_cancel: 'Lanjutkan setelah kesepakatan buyer',
};
export const requiresReason = action => ['reject_proof','cancel','refund'].includes(action);
export async function executeOrderAction(api, order, pending) {
  return api.action(order.id, { key: pending.key, action: pending.action, actor: 'admin', reason: pending.reason || '', expectedVersion: pending.version });
}
export async function notifyOrderAction(api, updated, pending, send) {
  if (['approve','reject_proof'].includes(pending.action)) {
    const buyer = await api.customer(updated.buyer);
    await api.session(updated.buyer, { ...buyer.session, chat: pending.action === 'approve', chatOrderId: updated.id });
  }
  const suffix = pending.action === 'approve' ? '\nChat admin aktif. Balasanmu akan diteruskan. /menu untuk kembali berbelanja.' : pending.action === 'reject_proof' ? '\nSilakan kirim ulang foto bukti pembayaran.' : '';
  await send(updated.buyer, `*PESANAN ${updated.id}*\nStatus: ${statusLabels[updated.status]}${pending.action === 'clear_cancel' ? '\nPermintaan pembatalan ditutup sesuai kesepakatan.' : ''}${pending.reason ? `\nCatatan admin: ${pending.reason}` : ''}${suffix}`, { buyer: updated.buyer, orderId: updated.id, role: 'admin', kind: 'relay' });
}
