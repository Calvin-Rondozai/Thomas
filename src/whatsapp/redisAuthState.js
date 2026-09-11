// A Baileys auth-state provider backed by Upstash Redis instead of local files, so the
// WhatsApp login session survives Render's free-tier restarts (which wipe local disk).
// This mirrors Baileys' own useMultiFileAuthState one-for-one (same read/write/remove
// shape), just swapping the storage backend - see
// node_modules/@whiskeysockets/baileys/lib/Utils/use-multi-file-auth-state.js for the
// original this is based on.
const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const upstash = require('../store/upstash');

const PREFIX = 'zim_job_bot:wa:';

async function writeData(data, key) {
  await upstash.set(PREFIX + key, JSON.stringify(data, BufferJSON.replacer));
}

async function readData(key) {
  try {
    const raw = await upstash.get(PREFIX + key);
    if (!raw) return null;
    return JSON.parse(raw, BufferJSON.reviver);
  } catch {
    return null;
  }
}

async function removeData(key) {
  try {
    await upstash.del(PREFIX + key);
  } catch {
    // ignore
  }
}

async function useRedisAuthState() {
  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds'),
  };
}

module.exports = { useRedisAuthState };
