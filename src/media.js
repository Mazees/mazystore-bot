export async function collectImage(stream, maxBytes) {
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of stream) {
      length += chunk.length;
      if (length > maxBytes) throw new Error('Gambar terlalu besar. Kirim sebagai foto maksimal 5 MB.');
      chunks.push(chunk);
    }
  } finally { stream.destroy?.(); }
  return Buffer.concat(chunks);
}
