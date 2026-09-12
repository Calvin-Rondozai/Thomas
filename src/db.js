// Job/settings store. State is kept in memory for instant synchronous reads (matching
// every existing call site), loaded once from Upstash Redis at startup via init(), and
// written back to Redis (fire-and-forget) on every mutation. This is what actually
// persists across Render's free-tier restarts, since local disk does not.
const upstash = require('./store/upstash');

const REDIS_KEY = 'zim_job_bot:db';
// Stored under its own key, not inside the main state blob above - that blob gets
// rewritten in full on every single job/setting mutation, and a multi-MB certificates
// file riding along on every tiny write would be wasteful and risk hitting request
// size limits. Fetched directly from Redis only when actually needed (uploading it,
// or attaching it to an application).
const CERTIFICATES_KEY = 'zim_job_bot:certificates_pdf';

let state = { jobs: {}, settings: {} };
let initialized = false;

async function init() {
  if (initialized) return;
  try {
    const raw = await upstash.get(REDIS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state = { jobs: parsed.jobs || {}, settings: parsed.settings || {} };
    }
  } catch (err) {
    console.error('[db] failed to load state from Upstash, starting fresh:', err.message);
  }
  initialized = true;
}

function persist() {
  upstash.set(REDIS_KEY, JSON.stringify(state)).catch((err) => console.error('[db] failed to persist to Upstash:', err.message));
}

function getJob(id) {
  return state.jobs[id] || null;
}

function upsertJob(job) {
  const now = new Date().toISOString();
  job.updatedAt = now;
  if (!state.jobs[job.id]) job.createdAt = now;
  state.jobs[job.id] = job;
  persist();
  return job;
}

function listJobs() {
  return Object.values(state.jobs);
}

function getSetting(key) {
  return state.settings[key];
}

function setSetting(key, value) {
  state.settings[key] = value;
  persist();
}

async function getCertificatesPdf() {
  const b64 = await upstash.get(CERTIFICATES_KEY);
  return b64 ? Buffer.from(b64, 'base64') : null;
}

async function setCertificatesPdf(buffer) {
  await upstash.set(CERTIFICATES_KEY, buffer.toString('base64'));
}

module.exports = {
  init,
  getJob,
  upsertJob,
  listJobs,
  getSetting,
  setSetting,
  getCertificatesPdf,
  setCertificatesPdf,
};
