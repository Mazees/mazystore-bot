import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { validateQris } from './qris.js';

export function loadConfig(env = process.env) {
  const required = ['ADMIN_NUMBER', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_DATABASE_ID', 'CLOUDFLARE_API_TOKEN', 'DATA_KEY'];
  for (const key of required) if (!env[key] || env[key].startsWith('replace-')) throw new Error(`Isi ${key} di .env terlebih dahulu.`);
  if (!/^[1-9]\d{7,14}$/.test(env.ADMIN_NUMBER)) throw new Error('ADMIN_NUMBER harus format 628..., tanpa + atau spasi.');
  if (!/^[a-f\d]{64}$/i.test(env.DATA_KEY)) throw new Error('DATA_KEY harus 64 karakter hex.');
  if (env.PAIRING_NUMBER && !/^[1-9]\d{7,14}$/.test(env.PAIRING_NUMBER)) throw new Error('PAIRING_NUMBER harus format internasional tanpa + atau spasi.');
  if (!/^[a-f\d]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID)) throw new Error('CLOUDFLARE_ACCOUNT_ID harus 32 karakter hex.');
  if (!/^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(env.CLOUDFLARE_DATABASE_ID)) throw new Error('CLOUDFLARE_DATABASE_ID harus UUID D1.');
  if (/\s/.test(env.CLOUDFLARE_API_TOKEN)) throw new Error('CLOUDFLARE_API_TOKEN tidak boleh berisi spasi.');
  const maxQuantity = Number(env.MAX_QUANTITY || 100);
  const maxImageBytes = Number(env.MAX_IMAGE_BYTES || 5242880);
  if (!Number.isSafeInteger(maxQuantity) || maxQuantity < 1 || maxQuantity > 100) throw new Error('MAX_QUANTITY harus 1–100.');
  if (!Number.isSafeInteger(maxImageBytes) || maxImageBytes < 1 || maxImageBytes > 5242880) throw new Error('MAX_IMAGE_BYTES maksimal 5242880.');
  const qris = (env.QRIS_PAYLOAD || (env.QRIS_PAYLOAD_FILE ? readFileSync(resolve(env.QRIS_PAYLOAD_FILE), 'utf8') : '')).trim();
  if (!qris) throw new Error('Isi QRIS_PAYLOAD atau QRIS_PAYLOAD_FILE di .env.');
  const { merchant } = validateQris(qris, env.EXPECTED_MERCHANT || 'MZ STORE');
  return { adminNumber: env.ADMIN_NUMBER, adminJid: `${env.ADMIN_NUMBER}@s.whatsapp.net`, accountId: env.CLOUDFLARE_ACCOUNT_ID, databaseId: env.CLOUDFLARE_DATABASE_ID, apiToken: env.CLOUDFLARE_API_TOKEN, dataKey: env.DATA_KEY, dataDir: resolve(env.DATA_DIR || 'data'), qris, merchant, maxQuantity, maxImageBytes, pairingNumber: env.PAIRING_NUMBER || '', logLevel: env.LOG_LEVEL || 'info' };
}
