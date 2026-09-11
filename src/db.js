// Job/settings store. State is kept in memory for instant synchronous reads (matching
// every existing call site), loaded once from Upstash Redis at startup via init(), and
// written back to Redis (fire-and-forget) on every mutation. This is what actually
// persists across Render's free-tier restarts, since local disk does not.
const upstash = require('./store/upstash');

const REDIS_KEY = 'zim_job_bot:db';

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

module.exports = { init, getJob, upsertJob, listJobs, getSetting, setSetting };
