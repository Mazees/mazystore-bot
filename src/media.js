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

export async function readStockFile(file, download) {
  if(!/\.txt$/i.test(file.fileName || '') || Number(file.fileLength || 0)>262144) throw Object.assign(new Error('Gunakan file .txt UTF-8 maksimal 256 KiB.'),{status:400});
  let buffer;
  try { buffer=await collectImage(await download(),262144); }
  catch(error) {
    if(error.message?.startsWith('Gambar terlalu besar'))throw Object.assign(new Error('File stok melebihi 256 KiB.'),{status:400});
    throw error;
  }
  try {return new TextDecoder('utf-8',{fatal:true}).decode(buffer);}
  catch {throw Object.assign(new Error('File harus teks UTF-8 yang valid.'),{status:400});}
}
