import { jidNormalizedUser } from 'baileys';

export async function resolveIncoming(message, socket, local) {
  const { key } = message;
  const jid = jidNormalizedUser(key?.remoteJid || '');
  if (!key?.id || !/^\d+@(s\.whatsapp\.net|lid)$/.test(jid) || local.isOutgoing(key.id)) return null;
  const ownNumber = jidNormalizedUser(socket.user?.id || '');
  const ownLid = jidNormalizedUser(socket.user?.lid || '');
  const alt = jidNormalizedUser(key.remoteJidAlt || '');
  const pn = jid.endsWith('@lid')
    ? (await socket.signalRepository.lidMapping.getPNForLID(jid) || (/^\d+@s\.whatsapp\.net$/.test(alt) ? alt : null) || (jid === ownLid ? ownNumber : null))
    : jid;
  const selfChat = Boolean(key.fromMe && ((pn && pn === ownNumber) || jid === ownLid));
  if (key.fromMe && !selfChat) return null;
  return { jid, buyer: pn ? jidNormalizedUser(pn) : null, selfChat };
}
