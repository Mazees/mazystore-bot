import { createHash } from 'node:crypto';
import { proto, encodeNewsletterMessage } from 'baileys';

// rc14 uploads newsletter images through /mms/image and doesn't wait for server acknowledgement.
export async function sendNewsletterImage(socket, jid, content, messageId) {
  const deadline = Date.now() + 15000;
  const signal = AbortSignal.timeout(15000);
  const hash = createHash('sha256').update(content.image).digest();
  let upload;
  try {
    const connection = await socket.refreshMediaConn(false);
    signal.throwIfAborted();
    const hostname = connection.hosts?.[0]?.hostname;
    if (!hostname || !/^[a-z0-9.-]+$/i.test(hostname) || !connection.auth) throw new Error('Koneksi upload tidak valid.');
    const token = hash.toString('base64url');
    const url = new URL(`https://${hostname}/newsletter/newsletter-image/${token}`);
    url.searchParams.set('auth', connection.auth);
    url.searchParams.set('token', token);
    const response = await fetch(url, {
      method: 'POST', body: content.image, signal, redirect: 'error',
      headers: { 'Content-Type': 'application/octet-stream', Origin: 'https://web.whatsapp.com' },
    });
    if (!response.ok) throw new Error('Upload gambar ditolak.');
    upload = await response.json();
    if (!upload || typeof upload.direct_path !== 'string' || !upload.direct_path.startsWith('/') || typeof upload.handle !== 'string' || !upload.handle) throw new Error('Hasil upload gambar tidak lengkap.');
    signal.throwIfAborted();
  } catch {
    throw Object.assign(new Error('Upload gambar saluran gagal; posting belum dikirim. Coba /post kembali setelah koneksi pulih.'), { postNotSent: true });
  }
  const message = proto.Message.fromObject({ imageMessage: {
    directPath: upload.direct_path, ...(typeof upload.url === 'string' ? { url: upload.url } : {}),
    fileSha256: hash, fileLength: content.image.length, mimetype: content.mimetype || 'image/png', caption: content.caption,
  } });
  if (signal.aborted || Date.now() >= deadline) throw Object.assign(new Error('Waktu upload gambar habis; posting belum dikirim. Coba /post kembali.'), { postNotSent: true });
  const ack = await socket.query({
    tag: 'message', attrs: { to: jid, id: messageId, type: 'media', media_id: upload.handle },
    content: [{ tag: 'plaintext', attrs: { mediatype: 'image' }, content: encodeNewsletterMessage(message) }],
  }, Math.max(1, deadline - Date.now()));
  if (ack?.attrs?.error && ack.attrs.error !== '0') {
    const code = /^\d+$/.test(ack.attrs.error) ? ack.attrs.error : 'tidak diketahui';
    throw Object.assign(new Error(`WhatsApp menolak posting saluran (kode ${code}). Periksa akses saluran sebelum mencoba /post kembali.`), { serverRejected: true });
  }
  const serverId = ack?.attrs?.server_id;
  if (ack?.tag !== 'ack' || ack.attrs.class !== 'message' || ack.attrs.id !== messageId || !/^[1-9]\d*$/.test(serverId || '')) throw new Error('Konfirmasi posting dari server belum diterima.');
  return { key: { id: messageId, remoteJid: jid, fromMe: true, server_id: serverId }, message };
}
