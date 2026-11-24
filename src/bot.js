import { NavigationPoll } from './poll.js';
import { AdminNavigation } from './admin/navigation.js';
import { BuyerNavigation } from './buyer.js';

export { labels } from './buyer.js';

export class StoreBot {
  constructor(api, transport, config, local, runtime = () => ({ whatsapp: Boolean(transport.socket) }), reportError = () => {}) {
    this.api = api; this.polls=new NavigationPoll(local,transport); this.transport=transport;
    this.config = config;
    this.admin = new AdminNavigation(api, transport, local, runtime, config, reportError);
    this.buyer = new BuyerNavigation(api, transport, config, local);
  }

  async pollChoice(record,index) {
    const c=await this.api.customer(record.owner),m=record.menu;
    const message={jid:record.key.remoteJid,buyer:record.owner,id:'poll-choice-'+record.key.id,text:String(index+1),selfChat:m.selfChat,pollOption:true};
    if(m.route==='order' && record.owner===this.config.adminJid)return this.admin.orderPoll(message,c,m,index);
    if(m.route==='admin') {
      if(record.owner!==this.config.adminJid || !c.session.admin || c.session.admin.token!==m.token)return this.transport.text(message.jid,'Menu sudah berubah. Buka /admin lagi.','poll:'+record.key.id+':stale');
      return this.admin.handle(message,c);
    }
    if(m.route==='command') {
      if(m.orderId && c.order?.id!==m.orderId)return this.transport.text(message.jid,'Pesanan sudah berubah. Buka /pesanan.','poll:'+record.key.id+':stale');
      return this.buyer.handle({...message,text:m.options[index].command,pollAction:true});
    }
    if(JSON.stringify(c.session.options)!==JSON.stringify(m.options) || c.session.stage!==m.stage)return this.transport.text(message.jid,'Menu sudah berubah. Buka /menu lagi.','poll:'+record.key.id+':stale');
    return this.buyer.handle(message);
  }

  async handle(message) {
    if (message.buyer !== this.config.adminJid || message.selfChat) return this.buyer.handle(message);
    let owner;
    try { owner = await this.api.customer(message.buyer); }
    catch (error) { return this.admin.failure(message, error); }
    return this.admin.handle(message, owner);
  }
}
