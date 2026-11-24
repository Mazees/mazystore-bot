import { randomBytes, createHash } from 'node:crypto';
import { decryptPollVote, generateMessageIDV2, jidNormalizedUser } from 'baileys';

export class PollTest {
  constructor(local,transport) { this.local=local;this.transport=transport; }
  async create(jid,length=0,menu=null,owner=menu?.buyer || jid) {
    if(!Number.isInteger(length)||length<0||length>1000)throw Error('Gunakan /tespoll atau /tespoll 256 (maksimal 1000 karakter untuk uji).');
    const socket=this.transport.socket;
    if(!socket)throw Error('WhatsApp belum tersambung.');
    const name=length ? 'Uji polling Mazy Store '.padEnd(length,'x').slice(0,length) : menu ? menu.question || 'MAZY STORE | MENU — Pilih satu produk atau layanan' : 'MAZY STORE | Pilih satu opsi';
    const id=generateMessageIDV2(socket.user.id),secret=randomBytes(32),values=menu ? menu.options.map((o,i)=>`${i+1}. ${o.label.split('\n')[0]}`) : ['Pilihan pertama','Pilihan kedua'];
    if(values.length>12)throw Error('Polling mendukung maksimal 12 pilihan. Gunakan /menu untuk seluruh katalog.');
    const key={remoteJid:jid,fromMe:true,id};
    this.local.authSet(`poll-test:${id}`,{key,secret,values,created:Date.now(),used:false,owner,menu});
    try {
      const sent=await this.transport.send(jid,{poll:{name,values,selectableCount:1,messageSecret:secret}},id);
      if(sent?.message)this.local.saveMessage(id,sent.message);
    }catch(error){this.local.authSet(`poll-test:${id}`,null);throw error;}
  }
  async vote(message,content,buyer,socket,onChoose=null) {
    const update=content.pollUpdateMessage,id=update?.pollCreationMessageKey?.id;
    if(!id)return;
    const record=this.local.authGet(`poll-test:${id}`);
    if(!record || record.used || (record.owner ? record.owner!==buyer : record.key.remoteJid!==message.key.remoteJid) || Date.now()-record.created>86400000)return;
    const creators=[socket.user?.id,socket.user?.lid].filter(Boolean).map(jidNormalizedUser);
    const voters=[message.key.remoteJid,message.key.remoteJidAlt,buyer].filter(Boolean).map(jidNormalizedUser);
    let vote;
    for(const pollCreatorJid of creators) {
      for(const voterJid of voters) {
        try {vote=decryptPollVote(update.vote,{pollCreatorJid,voterJid,pollMsgId:id,pollEncKey:record.secret});break;}catch { /* PN/LID may differ from the visible chat address. */ }
      }
      if(vote)break;
    }
    if(!vote){await this.transport.text(buyer,'Vote uji belum bisa didekripsi. Coba /tespoll lagi.',`poll:${message.key.id}:error`);return;}
    if(vote.selectedOptions?.length!==1)return;
    const selected=record.values.find(value=>createHash('sha256').update(value).digest().equals(Buffer.from(vote.selectedOptions[0])));
    if(!selected)return;
    this.local.authSet(`poll-test:${id}`,{used:true,created:record.created});
    let deleted=true;
    try {await this.transport.send(record.key.remoteJid,{delete:record.key});}catch{deleted=false;}
    if(record.menu && onChoose) {
      await onChoose(record,record.values.indexOf(selected));
      if(!deleted)await this.transport.text(record.key.remoteJid,'Pilihan diproses, tetapi pesan polling belum berhasil dihapus.',`poll:${id}:delete-failed`);
      return;
    }
    await this.transport.text(record.key.remoteJid,`Pilihan diterima: ${selected}.\n${deleted?'Permintaan hapus polling sudah dikirim.':'Polling belum berhasil dihapus; kamu bisa menghapus pesannya secara manual.'}\nIni hanya uji; tidak mengubah transaksi.`,`poll:${id}:result`);
  }
}
