import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { validateQris } from './qris.js';

export function loadConfig(env = process.env) {
  const required = ['ADMIN_NUMBER', 'WORKER_URL', 'API_SECRET', 'DATA_KEY'];
  for (const key of required) if (!env[key] || env[key].startsWith('replace-')) throw new Error(`Isi ${key} di .env terlebih dahulu.`);
  if (!/^[1-9]\d{7,14}$/.test(env.ADMIN_NUMBER)) throw new Error('ADMIN_NUMBER harus format 628..., tanpa + atau spasi.');
  if (!/^[a-f\d]{64}$/i.test(env.DATA_KEY)) throw new Error('DATA_KEY harus 64 karakter hex.');
  if (env.API_SECRET.length < 32) throw new Error('API_SECRET minimal 32 karakter.');
  if (env.PAIRING_NUMBER && !/^[1-9]\d{7,14}$/.test(env.PAIRING_NUMBER)) throw new Error('PAIRING_NUMBER harus format internasional tanpa + atau spasi.');
  if (env.WORKER_URL.includes('YOUR-SUBDOMAIN')) throw new Error('Isi WORKER_URL dengan URL Worker hasil deployment.');
  const url = new URL(env.WORKER_URL);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('WORKER_URL harus HTTPS.');
  const maxQuantity = Number(env.MAX_QUANTITY || 100);
  const maxImageBytes = Number(env.MAX_IMAGE_BYTES || 5242880);
  if (!Number.isSafeInteger(maxQuantity) || maxQuantity < 1 || maxQuantity > 100) throw new Error('MAX_QUANTITY harus 1–100.');
  if (!Number.isSafeInteger(maxImageBytes) || maxImageBytes < 1 || maxImageBytes > 5242880) throw new Error('MAX_IMAGE_BYTES maksimal 5242880.');
  const qris = (env.QRIS_PAYLOAD || (env.QRIS_PAYLOAD_FILE ? readFileSync(resolve(env.QRIS_PAYLOAD_FILE), 'utf8') : '')).trim();
  if (!qris) throw new Error('Isi QRIS_PAYLOAD atau QRIS_PAYLOAD_FILE di .env.');
  const { merchant } = validateQris(qris, env.EXPECTED_MERCHANT || 'MZ STORE');
  return { adminNumber: env.ADMIN_NUMBER, adminJid: `${env.ADMIN_NUMBER}@s.whatsapp.net`, workerUrl: url.href.replace(/\/$/, ''), apiSecret: env.API_SECRET, dataKey: env.DATA_KEY, dataDir: resolve(env.DATA_DIR || 'data'), qris, merchant, maxQuantity, maxImageBytes, pairingNumber: env.PAIRING_NUMBER || '', logLevel: env.LOG_LEVEL || 'info' };
}
