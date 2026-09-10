require('dotenv').config();
const fs = require('fs');
const config = require('./config');

function bootstrapFromEnv(envVar, targetPath) {
  if (fs.existsSync(targetPath)) return;
  const b64 = process.env[envVar];
  if (!b64) return;
  fs.writeFileSync(targetPath, Buffer.from(b64, 'base64').toString('utf-8'));
  console.log(`[bootstrap] wrote ${targetPath} from ${envVar}`);
}

// On a fresh Render deploy the persistent disk is empty - if profile.md/cv_template.md
// aren't there yet but were provided as base64 env vars, write them out now.
bootstrapFromEnv('PROFILE_MD_BASE64', config.PROFILE_PATH);
bootstrapFromEnv('CV_TEMPLATE_MD_BASE64', config.CV_TEMPLATE_PATH);

const { startWhatsApp, sendToOwner, sendFileToOwner } = require('./whatsapp/bot');
const { startScheduler } = require('./scheduler');
const notifier = require('./notifier');

async function main() {
  if (!config.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set. Set it in .env (local) or the Render environment variables.');
    process.exit(1);
  }
  if (!config.WHATSAPP_OWNER_NUMBER) {
    console.error('WHATSAPP_OWNER_NUMBER is not set. See .env.example.');
    process.exit(1);
  }
  if (!fs.existsSync(config.PROFILE_PATH)) {
    console.error(
      `No profile found at ${config.PROFILE_PATH}. Create data/profile.md (see data/profile.example.md), or set PROFILE_MD_BASE64.`
    );
    process.exit(1);
  }

  notifier.on('notify', (text) => sendToOwner(text).catch((err) => console.error('[notify] failed to send', err.message)));
  notifier.on('notifyFile', ({ buffer, filename, mimetype, caption }) =>
    sendFileToOwner(buffer, filename, mimetype, caption).catch((err) => console.error('[notifyFile] failed to send', err.message))
  );

  await startWhatsApp();
  startScheduler();
  console.log('Job bot started.');
}

main().catch((err) => {
  console.error('Fatal error on startup:', err);
  process.exit(1);
});
