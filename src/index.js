import makeWASocket, { BufferJSON, DisconnectReason, downloadContentFromMessage, jidNormalizedUser, normalizeMessageContent } from 'baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { loadConfig } from './config.js';
import { StoreApi } from './api.js';
import { LocalStore } from './local-store.js';
import { sqliteAuth } from './auth.js';
import { Transport } from './transport.js';
import { StoreBot } from './bot.js';
import { createApp } from './server.js';
import { collectImage } from './media.js';

const config = loadConfig();
const logger = pino({ level: config.logLevel, redact: ['*.creds', '*.keys', '*.message', '*.text', '*.caption', '*.authorization'] });
// Baileys diagnostics can include entire messages. Keep its logger silent; log lifecycle events below.
const waLogger = pino({ level: 'silent' });
const local = new LocalStore(config.dataDir, config.dataKey, BufferJSON);
const api = new StoreApi(config.workerUrl, config.apiSecret);
const auth = sqliteAuth(local);
const transport = new Transport(local, api, config);
const bot = new StoreBot(api, transport, config, local);
const status = { whatsapp: false, database: false, stopping: false };
let socket;
let reconnect;
let attempts = 0;
let queue = Promise.resolve();
let queued = 0;
let closing = false;
const port = Number(process.env.PORT || process.env.SERVER_PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT tidak valid.');
const server = createApp(status).listen(port, process.env.HOST || '0.0.0.0', () => logger.info({ port }, 'Express aktif'));
server.on('error', () => { logger.fatal('Express gagal bind port. Periksa PORT pada panel.'); shutdown(1); });

async function processMessage(m, sock) {
  const jid = jidNormalizedUser(m.key.remoteJid || '');
  if (!m.key.id || m.key.fromMe || !/^\d+@(s\.whatsapp\.net|lid)$/.test(jid)) return;
  const seenId = `${jid}:${m.key.id}`;
  if (local.hasSeen(seenId)) return;
  // Expired events must never become a new checkout after the dedup window.
  if (m.messageTimestamp && Number(m.messageTimestamp) * 1000 < Date.now() - 7 * 86400000) return;
  const content = normalizeMessageContent(m.message);
  if (!content || content.protocolMessage || content.reactionMessage) return;
  const alt = jidNormalizedUser(m.key.remoteJidAlt || '');
  const pn = jid.endsWith('@lid') ? (await sock.signalRepository.lidMapping.getPNForLID(jid) || (/^\d+@s\.whatsapp\.net$/.test(alt) ? alt : null)) : jid;
  if (!pn) {
    local.markSeen(seenId);
    await transport.text(jid, 'Identitas WhatsApp belum tersinkron. Coba kirim pesan lagi setelah beberapa saat.', `${seenId}:identity`);
    return;
  }
  const buyer = jidNormalizedUser(pn);
  let image;
  if (content.imageMessage) {
    image = async () => {
      if (Number(content.imageMessage.fileLength || 0) > config.maxImageBytes) throw new Error('Gambar terlalu besar. Maksimal 5 MB.');
      const stream = await downloadContentFromMessage(content.imageMessage, 'image', { options: { signal: AbortSignal.timeout(30000) } });
      return collectImage(stream, config.maxImageBytes);
    };
  }
  const text = content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || '';
  if (text.length > 6000) {
    local.markSeen(seenId);
    await transport.text(jid, 'Pesan terlalu panjang. Maksimal 6000 karakter.', `${seenId}:length`);
    return;
  }
  const quotedId = content.extendedTextMessage?.contextInfo?.stanzaId || content.imageMessage?.contextInfo?.stanzaId;
  try {
    await bot.handle({ jid, buyer, id: m.key.id, text, image, quotedId });
    status.database = true;
  } catch (error) {
    const known = error.status && error.status < 500;
    const mediaError = error.message?.startsWith('Gambar terlalu besar');
    if (!known && !mediaError) { status.database = false; logger.warn('Permintaan gagal. Periksa koneksi WA/API; konten pesan tidak dicatat.'); }
    await transport.text(jid, known || mediaError ? error.message : 'Permintaan belum berhasil dipastikan. Periksa /pesanan sebelum mengulang. Jika gambar belum sampai ke admin, kirim ulang atau gunakan /chat.', `${seenId}:error`);
  } finally {
    local.markSeen(seenId);
  }
}

function connect() {
  if (status.stopping) return;
  const sock = makeWASocket({
    auth: auth.state, logger: waLogger, markOnlineOnConnect: false,
    syncFullHistory: false, shouldSyncHistoryMessage: () => false,
    shouldIgnoreJid: jid => jid.endsWith('@g.us') || jid.endsWith('@newsletter') || jid === 'status@broadcast',
    getMessage: async key => local.getMessage(key.id),
    connectTimeoutMs: 30000, defaultQueryTimeoutMs: 30000,
  });
  socket = sock;
  let pairingRequested = false;
  sock.ev.on('creds.update', auth.saveCreds);
  sock.ev.on('connection.update', async update => {
    try {
      if (update.qr && !auth.state.creds.registered) {
        if (config.pairingNumber) {
          if (!pairingRequested) {
            pairingRequested = true;
            const code = await sock.requestPairingCode(config.pairingNumber);
            console.log(`Kode pairing (rahasia): ${code}`);
          }
        } else console.log(await QRCode.toString(update.qr, { type: 'terminal', small: true }));
      }
      if (update.connection === 'open') {
        if (jidNormalizedUser(sock.user.id) === config.adminJid) {
          logger.fatal('Nomor bot dan ADMIN_NUMBER harus berbeda.');
          return shutdown(1);
        }
        status.whatsapp = true;
        attempts = 0;
        transport.attach(sock);
        logger.info('WhatsApp tersambung');
        await transport.text(config.adminJid, `Bot Mazy Store aktif. Ketik /produk untuk mengatur katalog.\n${local.uncertain().length ? 'Ada pesan yang perlu diperiksa melalui /gagalkirim.' : ''}`, `startup:${Date.now()}`);
        void transport.drain().catch(() => logger.warn('Antrean pengiriman belum selesai.'));
      }
      if (update.connection === 'close' && socket === sock) {
        status.whatsapp = false;
        transport.detach(sock);
        const code = update.lastDisconnect?.error?.output?.statusCode;
        if (status.stopping) return;
        if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession || code === DisconnectReason.connectionReplaced) {
          logger.error('Sesi WA memerlukan pemeriksaan/pairing ulang. Bot tidak mencoba reconnect otomatis.');
          return;
        }
        const delay = code === DisconnectReason.restartRequired ? 1000 : Math.min(60000, 2000 * 2 ** Math.min(attempts++, 5));
        reconnect = setTimeout(connect, delay);
      }
    } catch { logger.error('Koneksi/pairing gagal. Periksa konfigurasi dan koneksi jaringan.'); }
  });
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify' || status.stopping) return;
    for (const message of messages) {
      // Do not let a media burst consume all hosting RAM. Overflow stays unprocessed; buyer can resend.
      if (queued >= 100) { logger.warn('Antrean masuk penuh.'); break; }
      queued++;
      queue = queue.then(() => processMessage(message, sock)).catch(() => logger.error('Gagal memproses event WA.')).finally(() => { queued--; });
    }
  });
}

async function probe() {
  try { await api.catalog(); status.database = true; } catch { status.database = false; }
}
const drainTimer = setInterval(() => { void transport.drain().catch(() => logger.warn('Antrean pengiriman bermasalah.')); }, 2000);
const probeTimer = setInterval(() => { void probe(); }, 30000);
const cleanTimer = setInterval(() => local.cleanup(), 60000);
async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  status.stopping = true;
  clearTimeout(reconnect);
  clearInterval(drainTimer); clearInterval(probeTimer); clearInterval(cleanTimer);
  server.close();
  const force = setTimeout(() => process.exit(code), 10000);
  force.unref();
  await queue;
  socket?.end(undefined);
  while (transport.draining) await new Promise(resolve => setTimeout(resolve, 50));
  auth.saveCreds();
  local.close();
  process.exit(code);
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
await probe();
connect();
