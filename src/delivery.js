import { generateMessageIDV2 } from 'baileys';
import { encryptStock, decryptStock } from './inventory.js';
import { renderMessage } from './ui.js';
import { Testimonials } from './testimonials.js';

export class AutoDelivery {
  constructor(api, transport, local, config) {
    this.api=api;this.transport=transport;this.local=local;this.config=config;
    this.running=false;this.requested=false;this.testimonials=new Testimonials(local,transport);
  }
  async tick() {
    if(this.running || !this.transport.socket || this.transport.draining)return;
    this.running=true;this.requested=false;
    try {
      const {orders}=await this.api.deliveryOrders();
      for(const order of orders) {
        try {
        let {parts}=await this.api.deliveryParts(order.id);
        if(!parts.length) {
          const {items}=await this.api.orderStock(order.id);
          if(items.length!==order.quantity)throw Error('Alokasi stok tidak lengkap.');
          await this.api.delivery(order.id,{mode:'prepare',parts:items.map((item,index)=>({
            waId:generateMessageIDV2(this.transport.socket.user?.id),
            payload:encryptStock(renderMessage('MAZY STORE · BARANG',[
              `ID Pesanan: ${order.id}\nProduk: ${order.product}\nVarian: ${order.variant}\nBarang ${index+1}/${items.length}`,
            ])+'\n\n'+decryptStock(item.payload,this.config.dataKey)+'\n\nSimpan rincian barang ini dengan aman. /chat untuk bantuan admin.',this.config.dataKey),
          }))});
          ({parts}=await this.api.deliveryParts(order.id));
        }
        for(const part of parts) {
          if(part.state==='pending')this.local.enqueue(`delivery:${order.id}:${part.part}`,order.buyer,{
            kind:'delivery',orderId:order.id,part:part.part,waId:part.wa_id,text:decryptStock(part.payload,this.config.dataKey),
          },'pending',part.wa_id);
          if(['sending','uncertain'].includes(part.state) || this.local.uncertainById(`delivery:${order.id}:${part.part}`))await this.transport.text(this.config.adminJid,
            renderMessage('ADMIN · PENGIRIMAN BARANG',[`ID: ${order.id}\nBuyer: ${order.buyer.split('@')[0]}`,'Pengiriman barang belum dapat dipastikan. Periksa chat buyer sebelum menandai selesai atau memulai refund. Tidak ada kirim ulang otomatis.']),
            `delivery:${order.id}:${part.part}:uncertain`,{buyer:order.buyer,orderId:order.id,role:'admin',kind:'relay',purpose:'transaction'});
        }
        const result=await this.api.delivery(order.id,{mode:'finish'});
        if(result.completed) {
          const outcomes=await Promise.allSettled([
            async()=>{
              const testimonial=await this.testimonials.post(result.order);
              if(testimonial.status!=='disabled')await this.transport.text(this.config.adminJid,renderMessage('ADMIN · AUTOTESTI',[`ID: ${order.id}`,testimonial.message]),`delivery:${order.id}:testimoni`);
            },
            async()=>{
              await this.transport.text(order.buyer,renderMessage('MAZY STORE · PESANAN',[`ID: ${order.id}\nStatus: Selesai`,'Seluruh barang telah dikirim oleh bot. /chat untuk bantuan.']),`delivery:${order.id}:completed`);
            },
            async()=>{
              await this.transport.text(this.config.adminJid,renderMessage('ADMIN · PESANAN',[`ID: ${order.id}\nStatus: Selesai`,'Penyerahan otomatis selesai.']),`delivery:${order.id}:admin-completed`,{buyer:order.buyer,orderId:order.id,role:'admin',kind:'relay',purpose:'transaction'});
            },
          ].map(run=>run()));
          if(outcomes.some(result=>result.status==='rejected'))throw Error('Pemberitahuan penyelesaian belum tersimpan.');

        }
        } catch {
          await this.transport.text(this.config.adminJid,renderMessage('ADMIN · PENGIRIMAN BARANG',[
            `ID: ${order.id}`,'Penyerahan otomatis belum berhasil diperiksa. Periksa status order dan chat buyer; jangan mengirim stok pengganti sebelum hasil kiriman sebelumnya dipastikan.',
          ]),`delivery:${order.id}:failure`,{buyer:order.buyer,orderId:order.id,role:'admin',kind:'relay',purpose:'transaction'});
        }
      }
    } finally {this.running=false;}
  }
}
