require('dotenv').config();
const path = require('path');
const fs = require('fs');

function pickDataDir() {
  // On Render we mount a persistent disk at /data (see render.yaml). Use it when present
  // and writable so the WhatsApp session + job database survive restarts/redeploys.
  const renderDisk = '/data';
  if (fs.existsSync(renderDisk)) {
    try {
      fs.accessSync(renderDisk, fs.constants.W_OK);
      return renderDisk;
    } catch {
      // not writable, fall through
    }
  }
  return path.join(__dirname, '..', 'data');
}

const DATA_DIR = process.env.DATA_DIR || pickDataDir();
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

module.exports = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,

  EMAIL_SERVICE: process.env.EMAIL_SERVICE || 'gmail',
  EMAIL_USER: process.env.EMAIL_USER,
  EMAIL_APP_PASSWORD: process.env.EMAIL_APP_PASSWORD,

  WHATSAPP_OWNER_NUMBER: process.env.WHATSAPP_OWNER_NUMBER,

  SCRAPE_INTERVAL_MINUTES: parseInt(process.env.SCRAPE_INTERVAL_MINUTES || '60', 10),
  MAX_PAGES_PER_SOURCE: parseInt(process.env.MAX_PAGES_PER_SOURCE || '2', 10),
  MATCH_THRESHOLD: parseInt(process.env.MATCH_THRESHOLD || '7', 10),
  USER_AGENT: process.env.SCRAPER_USER_AGENT || 'Mozilla/5.0 (compatible; PersonalJobBot/1.0)',

  DATA_DIR,
  DB_PATH: path.join(DATA_DIR, 'db.json'),
  WHATSAPP_AUTH_DIR: path.join(DATA_DIR, 'wa_auth'),
  PROFILE_PATH: path.join(DATA_DIR, 'profile.md'),
  CV_TEMPLATE_PATH: path.join(DATA_DIR, 'cv_template.md'),
};
