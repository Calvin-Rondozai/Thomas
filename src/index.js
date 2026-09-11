require('dotenv').config();
const fs = require('fs');
const http = require('http');
const config = require('./config');

function bootstrapFromEnv(envVar, targetPath) {
  if (fs.existsSync(targetPath)) return;
  const b64 = process.env[envVar];
  if (!b64) return;
  fs.writeFileSync(targetPath, Buffer.from(b64, 'base64').toString('utf-8'));
  console.log(`[bootstrap] wrote ${targetPath} from ${envVar}`);
}

// Local disk is ephemeral here (Render's free tier wipes it on every restart), so
// profile.md/cv_template.md get rewritten from their base64 env vars on every boot.
bootstrapFromEnv('PROFILE_MD_BASE64', config.PROFILE_PATH);
bootstrapFromEnv('CV_TEMPLATE_MD_BASE64', config.CV_TEMPLATE_PATH);

const db = require('./db');
const { startWhatsApp, sendToOwner, sendFileToOwner } = require('./whatsapp/bot');
const { startScheduler } = require('./scheduler');
const notifier = require('./notifier');

function requireEnv(checks) {
  const missing = checks.filter(([ok]) => !ok).map(([, name]) => name);
  if (missing.length) {
    console.error(`Missing required configuration: ${missing.join(', ')}. See .env.example.`);
    process.exit(1);
  }
}

// Render's free Web Service plan requires listening on $PORT for its own health check,
// and this is also the endpoint an external keep-alive pinger hits (see README) to stop
// the free instance from sleeping after 15 minutes of no HTTP traffic.
function startKeepAliveServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Zim Job Bot is running.\n');
  });
  server.listen(config.PORT, () => console.log(`[http] keep-alive server listening on port ${config.PORT}`));
}

async function main() {
  requireEnv([
    [config.GEMINI_API_KEYS.length > 0, 'GEMINI_API_KEYS'],
    [!!config.WHATSAPP_OWNER_NUMBER, 'WHATSAPP_OWNER_NUMBER'],
    [!!config.EMAIL_USER, 'EMAIL_USER'],
    [!!config.GMAIL_CLIENT_ID, 'GMAIL_CLIENT_ID'],
    [!!config.GMAIL_CLIENT_SECRET, 'GMAIL_CLIENT_SECRET'],
    [!!config.GMAIL_REFRESH_TOKEN, 'GMAIL_REFRESH_TOKEN'],
    [!!config.UPSTASH_REDIS_REST_URL, 'UPSTASH_REDIS_REST_URL'],
    [!!config.UPSTASH_REDIS_REST_TOKEN, 'UPSTASH_REDIS_REST_TOKEN'],
  ]);

  if (!fs.existsSync(config.PROFILE_PATH)) {
    console.error(
      `No profile found at ${config.PROFILE_PATH}. Create data/profile.md (see data/profile.example.md), or set PROFILE_MD_BASE64.`
    );
    process.exit(1);
  }

  await db.init();

  notifier.on('notify', (text) => sendToOwner(text).catch((err) => console.error('[notify] failed to send', err.message)));
  notifier.on('notifyFile', ({ buffer, filename, mimetype, caption }) =>
    sendFileToOwner(buffer, filename, mimetype, caption).catch((err) => console.error('[notifyFile] failed to send', err.message))
  );

  startKeepAliveServer();
  await startWhatsApp();
  startScheduler();
  console.log('Job bot started.');
}

main().catch((err) => {
  console.error('Fatal error on startup:', err);
  process.exit(1);
});
