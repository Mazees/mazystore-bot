import { initAuthCreds, proto } from 'baileys';

export function sqliteAuth(store) {
  const creds = store.authGet('creds') || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        async get(type, ids) {
          const result = {};
          for (const id of ids) {
            let value = store.authGet(`${type}:${id}`);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            result[id] = value;
          }
          return result;
        },
        async set(data) {
          store.transaction(() => {
            for (const [type, entries] of Object.entries(data)) for (const [id, value] of Object.entries(entries)) store.authSet(`${type}:${id}`, value);
          });
        },
      },
    },
    saveCreds: () => store.authSet('creds', creds),
  };
}
