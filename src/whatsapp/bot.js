const { default: makeWASocket, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const config = require('../config');
const { handleIncomingMessage } = require('./handler');
const { useRedisAuthState } = require('./redisAuthState');

let sock = null;
let latestQr = null;
let isConnected = false;

function ownerJid() {
  if (!config.WHATSAPP_OWNER_NUMBER) throw new Error('WHATSAPP_OWNER_NUMBER is not set.');
  return config.WHATSAPP_OWNER_NUMBER.includes('@')
    ? config.WHATSAPP_OWNER_NUMBER
    : `${config.WHATSAPP_OWNER_NUMBER}@s.whatsapp.net`;
}

async function startWhatsApp() {
  const { state, saveCreds } = await useRedisAuthState();

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      latestQr = qr;
      console.log('\n[whatsapp] QR code ready - open /qr on this service\'s URL in a browser to scan it.');
      console.log('[whatsapp] (ASCII fallback below, but a web log viewer usually mangles this - the /qr page is reliable):\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      isConnected = false;
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('[whatsapp] connection closed, code:', statusCode, '- reconnecting:', shouldReconnect);
      if (shouldReconnect) startWhatsApp().catch((err) => console.error('[whatsapp] reconnect failed', err));
      else console.error('[whatsapp] logged out - clear the zim_job_bot:wa:* keys in Upstash and re-scan the QR code.');
    } else if (connection === 'open') {
      isConnected = true;
      latestQr = null;
      console.log('[whatsapp] connected');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const from = msg.key.remoteJid;
      if (config.WHATSAPP_OWNER_NUMBER && !from?.startsWith(config.WHATSAPP_OWNER_NUMBER)) {
        continue; // only take instructions from the owner's number
      }
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '';
      if (!text.trim()) continue;

      try {
        await handleIncomingMessage(text.trim(), { sendMessage: sendToOwner, sendFile: sendFileToOwner });
      } catch (err) {
        console.error('[whatsapp] handler error', err);
        await sendToOwner(`⚠️ Something went wrong handling that: ${err.message}`).catch(() => {});
      }
    }
  });

  return sock;
}

async function sendToOwner(text) {
  if (!sock) throw new Error('WhatsApp socket not ready yet.');
  await sock.sendMessage(ownerJid(), { text });
}

async function sendFileToOwner(buffer, filename, mimetype, caption) {
  if (!sock) throw new Error('WhatsApp socket not ready yet.');
  await sock.sendMessage(ownerJid(), { document: buffer, fileName: filename, mimetype, caption });
}

function getStatus() {
  return { qr: latestQr, connected: isConnected };
}

module.exports = { startWhatsApp, sendToOwner, sendFileToOwner, getStatus };
