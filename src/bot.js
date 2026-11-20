import { AdminNavigation } from './admin/navigation.js';
import { BuyerNavigation } from './buyer.js';

export { labels } from './buyer.js';

export class StoreBot {
  constructor(api, transport, config, local, runtime = () => ({ whatsapp: Boolean(transport.socket) }), reportError = () => {}) {
    this.api = api;
    this.config = config;
    this.admin = new AdminNavigation(api, transport, local, runtime, config, reportError);
    this.buyer = new BuyerNavigation(api, transport, config);
  }

  async handle(message) {
    if (message.buyer !== this.config.adminJid || message.selfChat) return this.buyer.handle(message);
    let owner;
    try { owner = await this.api.customer(message.buyer); }
    catch (error) { return this.admin.failure(message, error); }
    return this.admin.handle(message, owner);
  }
}
