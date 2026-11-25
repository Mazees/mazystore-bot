import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const DAY = 86400000;
export class LocalStore {
  constructor(directory, hexKey, codec = JSON) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.key = Buffer.from(hexKey, 'hex');
    this.codec = codec;
    const path = join(directory, 'bot.sqlite');
    this.db = new DatabaseSync(path);
    try { chmodSync(path, 0o600); } catch { /* Permissions are inherited on Windows. */ }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS auth (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, jid TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created INTEGER NOT NULL, wa_id TEXT);
      CREATE TABLE IF NOT EXISTS retry_messages (id TEXT PRIMARY KEY, value TEXT NOT NULL, created INTEGER NOT NULL);
    `);
    this.db.exec("UPDATE outbox SET status='uncertain' WHERE status='sending'");
    this.cleanup();
  }
  encrypt(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const plain = JSON.stringify(value, this.codec.replacer);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  decrypt(value) {
    const packed = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, packed.subarray(0, 12));
    decipher.setAuthTag(packed.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8'), this.codec.reviver);
  }
  authGet(key) {
    const row = this.db.prepare('SELECT value FROM auth WHERE key=?').get(key);
    return row ? this.decrypt(row.value) : null;
  }
  authSet(key, value) {
    if (value == null) this.db.prepare('DELETE FROM auth WHERE key=?').run(key);
    else this.db.prepare('INSERT OR REPLACE INTO auth(key,value) VALUES (?,?)').run(key, this.encrypt(value));
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  hasSeen(id) { return Boolean(this.db.prepare('SELECT 1 FROM seen WHERE id=?').get(id)); }
  markSeen(id) { this.db.prepare('INSERT OR IGNORE INTO seen VALUES (?,?)').run(id, Date.now()); }
  markOutgoing(id) { this.markSeen(`outgoing:${id}`); }
  isOutgoing(id) { return this.hasSeen(`outgoing:${id}`); }
  retireLegacyRelay() {
    if (this.authGet('feature:direct-claim')) return;
    this.transaction(() => {
      const jobs = this.db.prepare("SELECT id,payload FROM outbox WHERE status IN ('pending','mapping','uncertain','sending')").all();
      for (const job of jobs) {
        const context = this.decrypt(job.payload).context;
        if (context && context.kind !== 'menu' && context.purpose !== 'transaction') this.setStatus(job.id, 'retired');
      }
      this.db.prepare('DELETE FROM retry_messages').run();
      this.authSet('feature:direct-claim', true);
    });
  }
  enqueue(id, jid, payload, status = 'pending', waId = null) {
    this.db.prepare('INSERT OR IGNORE INTO outbox(id,jid,payload,status,wa_id,created) VALUES (?,?,?,?,?,?)').run(id, jid, this.encrypt(payload), status, waId, Date.now());
  }
  next(status = 'pending') {
    const row = this.db.prepare('SELECT * FROM outbox WHERE status=? ORDER BY created,rowid LIMIT 1').get(status);
    return row ? { ...row, payload: this.decrypt(row.payload) } : null;
  }
  outboxStatus(id) { return this.db.prepare('SELECT status FROM outbox WHERE id=?').get(id)?.status; }
  setStatus(id, status, waId = null) {
    this.db.prepare('UPDATE outbox SET status=?,wa_id=COALESCE(?,wa_id) WHERE id=?').run(status, waId, id);
  }
  messageReference(jid, waId) {
    const row = this.db.prepare('SELECT payload FROM outbox WHERE jid=? AND wa_id=? LIMIT 1').get(jid, waId);
    const context = row ? this.decrypt(row.payload).context : null;
    return context ? { buyer: context.buyer, order_id: context.orderId, kind: context.kind || 'relay' } : null;
  }
  uncertain() { return this.db.prepare("SELECT id,jid,created,status FROM outbox WHERE status='uncertain' ORDER BY created,id").all(); }
  outboxSummary() {
    return this.db.prepare("SELECT COALESCE(SUM(status IN ('pending','broadcast','mapping','sending')),0) AS pending,COALESCE(SUM(status='uncertain'),0) AS uncertain FROM outbox").get();
  }
  broadcastSummary() {
    return this.db.prepare("SELECT COALESCE(SUM(status='broadcast'),0) AS pending,COALESCE(SUM(status='sent'),0) AS sent,COALESCE(SUM(status='uncertain'),0) AS uncertain FROM outbox WHERE id LIKE 'broadcast:%'").get();
  }
  queueBroadcast(key, recipients, text) {
    this.transaction(() => {
      for (const jid of recipients) this.enqueue(`broadcast:${key}:${jid}`, jid, { kind: 'text', text }, 'broadcast');
    });
  }
  cancelBroadcast() { return this.db.prepare("UPDATE outbox SET status='cancelled' WHERE status='broadcast'").run().changes; }
  uncertainById(id) { return this.db.prepare("SELECT id,jid,created FROM outbox WHERE id=? AND status='uncertain'").get(id); }
  retry(id) {
    const row = this.db.prepare('SELECT payload FROM outbox WHERE id=?').get(id);
    if (row && this.decrypt(row.payload).kind === 'delivery') return 0;
    return this.transaction(()=>{
      const result=this.db.prepare("UPDATE outbox SET status=CASE WHEN id LIKE 'broadcast:%' THEN 'broadcast' ELSE 'pending' END,wa_id=NULL WHERE id=? AND status='uncertain'").run(id).changes;
      if(result && this.decrypt(row.payload).kind==='qris')this.db.prepare("UPDATE outbox SET status='pending',wa_id=NULL WHERE id=? AND status='retired'").run(id+':poll');
      return result;
    });
  }
  saveMessage(id, message) {
    this.db.prepare('INSERT OR REPLACE INTO retry_messages VALUES (?,?,?)').run(id, this.encrypt(message), Date.now());
  }
  getMessage(id) {
    const row = this.db.prepare('SELECT value FROM retry_messages WHERE id=? AND created>?').get(id, Date.now() - DAY);
    return row ? this.decrypt(row.value) : undefined;
  }
  cleanup() {
    const cutoff = Date.now() - DAY;
    for(const row of this.db.prepare("SELECT key,value FROM auth WHERE key LIKE 'poll:%'").all()) {
      const record=this.decrypt(row.value);
      if(record.menu?.route==='order' && !record.used)continue;
      if(record.created<Date.now()-30*60000)this.authSet(row.key,null);
    }
    this.db.prepare("DELETE FROM outbox WHERE created<? AND status!='broadcast'").run(cutoff);
    this.db.prepare('DELETE FROM retry_messages WHERE created<?').run(cutoff);
    this.db.prepare('DELETE FROM seen WHERE created<?').run(Date.now() - 7 * DAY);
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  close() { this.db.close(); }
}
