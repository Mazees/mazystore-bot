import { claimDestination } from './contact.js';

export async function shortenClaim(adminNumber, order) {
  if (order.status !== 'processing' || order.delivery_mode === 'auto') throw new Error('CLAIM hanya tersedia untuk order manual yang sedang diproses.');
  const destination = claimDestination(adminNumber, order);
  try {
    const query = new URLSearchParams({ format: 'json', url: destination, logstats: '0' });
    const response = await fetch('https://is.gd/create.php?' + query, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Shortlink tidak tersedia.');
    const body = await response.json();
    const url = new URL(body.shorturl);
    if (body.errorcode || url.protocol !== 'https:' || url.hostname !== 'is.gd' || url.port || url.username || url.password || !/^\/[A-Za-z0-9_-]+$/.test(url.pathname) || url.search || url.hash) throw new Error('Shortlink tidak valid.');
    return url.href;
  } catch {
    return 'https://wa.me/' + adminNumber;
  }
}
