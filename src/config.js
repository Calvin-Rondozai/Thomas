require('dotenv').config();
const path = require('path');
const fs = require('fs');

// Only used to re-materialize profile.md/cv_template.md from their base64 env vars on
// every boot (see index.js) - safe to be ephemeral, since it's rebuilt from env either
// way. Actual persistent state (WhatsApp session, job database) lives in Upstash Redis
// now, not on local disk, because Render's free tier wipes local disk on every restart.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

module.exports = {
  // Comma or newline separated - supports pooling several keys and rotating between
  // them when one hits its quota (see src/ai/gemini.js).
  GEMINI_API_KEYS: (process.env.GEMINI_API_KEYS || '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean),

  // Gmail API (OAuth) - sends as this real Gmail address over HTTPS, so it works even
  // where outbound SMTP ports are blocked (e.g. Render's free tier). See
  // scripts/get-gmail-token.js for how to obtain GMAIL_REFRESH_TOKEN.
  EMAIL_USER: process.env.EMAIL_USER,
  GMAIL_CLIENT_ID: process.env.GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET: process.env.GMAIL_CLIENT_SECRET,
  GMAIL_REFRESH_TOKEN: process.env.GMAIL_REFRESH_TOKEN,

  // Upstash Redis (free, no card) - the only place job/session state is persisted.
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,

  WHATSAPP_OWNER_NUMBER: process.env.WHATSAPP_OWNER_NUMBER,

  SCRAPE_INTERVAL_MINUTES: parseInt(process.env.SCRAPE_INTERVAL_MINUTES || '60', 10),
  MAX_PAGES_PER_SOURCE: parseInt(process.env.MAX_PAGES_PER_SOURCE || '2', 10),
  MATCH_THRESHOLD: parseInt(process.env.MATCH_THRESHOLD || '7', 10),
  USER_AGENT: process.env.SCRAPER_USER_AGENT || 'Mozilla/5.0 (compatible; PersonalJobBot/1.0)',

  // Render's free Web Service plan requires listening on this port for its health
  // check, and it's also what an external keep-alive pinger hits (see README).
  PORT: parseInt(process.env.PORT || '3000', 10),

  DATA_DIR,
  PROFILE_PATH: path.join(DATA_DIR, 'profile.md'),
  CV_TEMPLATE_PATH: path.join(DATA_DIR, 'cv_template.md'),
};
