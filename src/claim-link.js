const encoder = new TextEncoder();
const payload = (orderId, adminNumber) => encoder.encode(JSON.stringify([orderId, adminNumber]));
const key = secret => crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign','verify']);
const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/, '');

export async function claimLink(baseUrl, orderId, adminNumber, secret) {
  if (!secret || secret.length < 32 || !/^[A-Za-z0-9-]{1,64}$/.test(orderId) || !/^[1-9]\d{7,14}$/.test(adminNumber)) throw new Error('Konfigurasi link CLAIM tidak valid.');
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), payload(orderId, adminNumber)));
  return new URL(`/c/${orderId}/${adminNumber}/${encode(signature)}`, baseUrl).href;
}

export async function verifyClaimLink(orderId, adminNumber, signature, secret) {
  if (!secret || secret.length < 32 || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  try {
    const bytes = Uint8Array.from(atob(signature.replaceAll('-','+').replaceAll('_','/')), char => char.charCodeAt(0));
    return await crypto.subtle.verify('HMAC', await key(secret), bytes, payload(orderId, adminNumber));
  } catch { return false; }
}
