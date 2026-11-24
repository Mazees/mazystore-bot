import { PollTest } from './poll.js';
import { AdminNavigation } from './admin/navigation.js';
import { BuyerNavigation } from './buyer.js';

export { labels } from './buyer.js';

export class StoreBot {
  constructor(api, transport, config, local, runtime = () => ({ whatsapp: Boolean(transport.socket) }), reportError = () => {}) {
    this.api = api; this.polls=new PollTest(local,transport); this.transport=transport;
    this.config = config;
    this.admin = new AdminNavigation(api, transport, local, runtime, config, reportError);
    this.buyer = new BuyerNavigation(api, transport, config);
  }

  async pollChoice(record,index) {
    const c=await this.api.customer(record.owner);
    if(JSON.stringify(c.session.options)!==JSON.stringify(record.menu.options) || c.session.stage!=='menu') {
      await this.transport.text(record.key.remoteJid,'Menu sudah berubah. Ketik /tespoll lagi.', 'poll:'+record.key.id+':stale');return;
    }
    return this.buyer.handle({jid:record.key.remoteJid,buyer:record.owner,id:'poll-choice-'+record.key.id,text:String(index+1),selfChat:record.menu.selfChat});
  }

  async handle(message) {
    if(message.text.trim().split(/\s+/)[0].toLowerCase()==='/tespoll' && message.text.trim()==='/tespoll') {
      await this.buyer.handle({...message,text:'/menu'});
      const c=await this.api.customer(message.buyer);
      return this.polls.create(message.jid,0,{buyer:message.buyer,options:c.session.options,selfChat:message.selfChat});
    }
    if (message.buyer !== this.config.adminJid || message.selfChat) return this.buyer.handle(message);
    let owner;
    try { owner = await this.api.customer(message.buyer); }
    catch (error) { return this.admin.failure(message, error); }
    return this.admin.handle(message, owner);
  }
}
