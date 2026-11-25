import { randomBytes, createHash } from 'node:crypto';
import { decryptPollVote, generateMessageIDV2, jidNormalizedUser } from 'baileys';

export class NavigationPoll {
  constructor(local,transport) { this.local=local;this.transport=transport; }
  async create(jid,menu,page=0) {
    const socket=this.transport.socket;
    if(!socket)throw Error('WhatsApp belum tersambung.');
    const size=10,start=page*size,shown=menu.options.slice(start,start+size).map((o,i)=>({label:o.label.split('\n')[0],index:start+i}));
    if(page>0)shown.push({label:'Halaman sebelumnya',page:page-1});
    if(start+size<menu.options.length)shown.push({label:'Halaman berikutnya',page:page+1});
    if(!shown.length)return this.transport.text(jid,menu.question,'poll-empty:'+Date.now());
    if(shown.length===1)shown.push({label:'Tutup',dismiss:true});
    const id=generateMessageIDV2(socket.user.id),secret=randomBytes(32),values=shown.map((o,i)=>(i+1)+'. '+Array.from(o.label).slice(0,90).join(''));
    const key={remoteJid:jid,fromMe:true,id};
    const creators=[socket.user?.id,socket.user?.lid].filter(Boolean).map(jidNormalizedUser);
    this.local.authSet('poll:'+id,{key,secret,values,shown,created:Date.now(),used:false,owner:menu.buyer,menu,creators});
    try {
      const sent=await this.transport.send(jid,{poll:{name:menu.question,values,selectableCount:1,messageSecret:secret}},id);
      if(sent?.message)this.local.saveMessage(id,sent.message);
      return sent;
    }catch(error){this.local.authSet('poll:'+id,null);throw error;}
  }
  async vote(message,content,buyer,socket,onChoose=null) {
    const update=content.pollUpdateMessage,id=update?.pollCreationMessageKey?.id;
    if(!id)return;
    const record=this.local.authGet(`poll:${id}`);
    const entry=buyer===this.transport.config?.adminJid ? '/admin → Pesanan & pembayaran' : '/menu atau /pesanan';
    if(!record) {
      await this.transport.text(buyer,`Data polling lama sudah tidak tersedia. Buka ${entry} untuk melanjutkan. Status pesanan tidak diubah.`,`poll:${message.key.id}:missing`);return;
    }
    if(record.owner && record.owner!==buyer)return;
    if(record.used) {
      await this.transport.text(buyer,`Pilihan polling ini sudah diproses. Buka ${entry} untuk melihat status terbaru.`,`poll:${message.key.id}:used`);return;
    }
    if(record.menu?.route!=='order' && Date.now()-record.created>30*60000) {
      await this.transport.text(buyer,`Menu polling sudah kedaluwarsa. Buka ${entry} untuk melanjutkan.`,`poll:${message.key.id}:expired`);return;
    }
    const creators=[...new Set([...(record.creators || []),socket.user?.id,socket.user?.lid].filter(Boolean).map(jidNormalizedUser))];
    const voters=[message.key.remoteJid,message.key.remoteJidAlt,buyer].filter(Boolean).map(jidNormalizedUser);
    let vote;
    for(const pollCreatorJid of creators) {
      for(const voterJid of voters) {
        try {vote=decryptPollVote(update.vote,{pollCreatorJid,voterJid,pollMsgId:id,pollEncKey:record.secret});break;}catch { /* PN/LID may differ from the visible chat address. */ }
      }
      if(vote)break;
    }
    if(!vote){await this.transport.text(buyer,'Pilihan belum dapat dibaca. Buka /menu atau /admin lagi.',`poll:${message.key.id}:error`);return;}
    if(vote.selectedOptions?.length!==1)return;
    const selected=record.values.find(value=>createHash('sha256').update(value).digest().equals(Buffer.from(vote.selectedOptions[0])));
    if(!selected)return;
    const selectedIndex=record.values.indexOf(selected);
    if(record.chosenIndex!==undefined && record.chosenIndex!==selectedIndex) {
      await this.transport.text(record.key.remoteJid,'Pilihan sebelumnya belum selesai. Pilih kembali opsi yang sama atau buka menu baru.','poll:'+id+':different');return;
    }
    this.local.authSet('poll:'+id,{...record,chosenIndex:selectedIndex});
    const choice=record.shown[selectedIndex];
    try {
      if(choice.page!==undefined)await this.create(record.key.remoteJid,record.menu,choice.page);
      else if(!choice.dismiss && onChoose)await onChoose(record,choice.index);
    }catch {
      await this.transport.text(record.key.remoteJid,'Pilihan belum berhasil dipastikan. Periksa status pesanan. Untuk mencoba lagi, hapus centang lalu pilih kembali opsi yang sama; jangan membuat pesanan baru.','poll:'+id+':retry');
      return;
    }
    this.local.authSet('poll:'+id,{used:true,created:Date.now(),owner:record.owner});
    try {await this.transport.send(record.key.remoteJid,{delete:record.key});}
    catch {await this.transport.text(record.key.remoteJid,'Pilihan diproses, tetapi pesan polling belum berhasil dihapus.','poll:'+id+':delete-failed');}

  }
}
