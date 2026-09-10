// Small hand-rolled JSON file store. Deliberately not a real database - this bot
// tracks at most a few thousand job records, so a flat file that's rewritten on
// every change is simple, dependency-free, and easy to inspect/back up by hand.
const fs = require('fs');
const path = require('path');
const config = require('./config');

const DB_PATH = config.DB_PATH;

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  ensureDir(DB_PATH);
  if (!fs.existsSync(DB_PATH)) return { jobs: {}, settings: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    return { jobs: parsed.jobs || {}, settings: parsed.settings || {} };
  } catch (err) {
    console.error('[db] failed to parse db file, starting fresh:', err.message);
    return { jobs: {}, settings: {} };
  }
}

const state = load();

function persist() {
  ensureDir(DB_PATH);
  fs.writeFileSync(DB_PATH, JSON.stringify(state, null, 2));
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

module.exports = { getJob, upsertJob, listJobs, getSetting, setSetting };
