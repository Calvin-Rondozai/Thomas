// Thin wrapper around Upstash Redis's HTTP REST API (https://upstash.com/docs/redis/features/restapi).
// Used instead of the local filesystem so state survives Render's free-tier restarts
// (which wipe local disk) - both the job database (db.js) and the WhatsApp login
// session (whatsapp/redisAuthState.js) are stored here.
const axios = require('axios');
const config = require('../config');

function client() {
  if (!config.UPSTASH_REDIS_REST_URL || !config.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not configured.');
  }
  return axios.create({
    baseURL: config.UPSTASH_REDIS_REST_URL,
    headers: { Authorization: `Bearer ${config.UPSTASH_REDIS_REST_TOKEN}` },
    timeout: 15000,
  });
}

/** Returns the stored string value, or null if the key doesn't exist. */
async function get(key) {
  const res = await client().get(`/get/${encodeURIComponent(key)}`);
  return res.data.result ?? null;
}

/** Stores a string value under key. */
async function set(key, value) {
  await client().post(`/set/${encodeURIComponent(key)}`, value, {
    headers: { 'Content-Type': 'text/plain' },
  });
}

/** Deletes a key (no error if it didn't exist). */
async function del(key) {
  await client().post(`/del/${encodeURIComponent(key)}`);
}

module.exports = { get, set, del };
