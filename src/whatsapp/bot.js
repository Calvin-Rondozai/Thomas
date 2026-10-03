const { default: makeWASocket, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const config = require('../config');
const db = require('../db');
const { handleIncomingMessage } = require('./handler');
const { useRedisAuthState, clearRedisAuthState } = require('./redisAuthState');

const BOT_NAME = 'HELLO C';
const MAX_CERTIFICATES_PDF_BYTES = 8 * 1024 * 1024; // Upstash free tier caps a request at 10MB; base64 inflates size ~33%

let sock = null;
let latestQr = null;
let isConnected = false;

// WhatsApp has been rolling out privacy-preserving LID (linked ID) addressing, where a
// chat's JID can be an opaque id rather than the phone-number-based
// "<number>@s.whatsapp.net" JID - so matching by reconstructing that from
// WHATSAPP_OWNER_NUMBER is not reliable. Instead, whichever real JID first messages the
// bot is captured and persisted as the true owner JID, and used exactly as-is from then
// on for both filtering incoming messages and addressing outgoing ones.
function fallbackOwnerJid() {
  if (!config.WHATSAPP_OWNER_NUMBER) return null;
  return config.WHATSAPP_OWNER_NUMBER.includes('@')
    ? config.WHATSAPP_OWNER_NUMBER
    : `${config.WHATSAPP_OWNER_NUMBER}@s.whatsapp.net`;
}

function ownerJid() {
  return db.getSetting('ownerJid') || fallbackOwnerJid();
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
      if (shouldReconnect) {
        startWhatsApp().catch((err) => console.error('[whatsapp] reconnect failed', err));
      } else {
        // The session was unlinked (from the phone, or by WhatsApp after a long time
        // offline). The stored creds are now useless and would just get rejected again
        // on every restart, so wipe them and start over to get a fresh QR code on /qr.
        console.error('[whatsapp] logged out - clearing the stored session and generating a new QR code.');
        clearRedisAuthState()
          .then((n) => console.log(`[whatsapp] cleared ${n} session keys.`))
          .then(() => startWhatsApp())
          .catch((err) => console.error('[whatsapp] failed to reset session after logout', err));
      }
    } else if (connection === 'open') {
      isConnected = true;
      latestQr = null;
      console.log('[whatsapp] connected');
      sock.updateProfileName(BOT_NAME).catch((err) => console.error('[whatsapp] failed to set profile name:', err.message));
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) {
        // Usually a message that couldn't be decrypted (e.g. stale Signal sessions after
        // a long time offline) - log it instead of dropping it silently.
        console.warn(`[whatsapp] received an empty/undecryptable message from ${msg.key.remoteJid} (stub: ${msg.messageStubType ?? 'none'}, params: ${JSON.stringify(msg.messageStubParameters || [])})`);
        continue;
      }
      const from = msg.key.remoteJid;
      console.log(`[whatsapp] incoming message from JID: ${from}`);

      const registeredOwnerJid = db.getSetting('ownerJid');
      if (!registeredOwnerJid) {
        db.setSetting('ownerJid', from);
        console.log(`[whatsapp] registered ${from} as the owner JID (first message received).`);
      } else if (from !== registeredOwnerJid) {
        console.log(`[whatsapp] ignoring message from unrecognized JID ${from} (owner is ${registeredOwnerJid}).`);
        continue;
      }

      const docMessage = msg.message.documentMessage;
      if (docMessage) {
        if (docMessage.mimetype !== 'application/pdf') {
          await sendToOwner("That's not a PDF - please send your certificates as a single PDF file.").catch(() => {});
          continue;
        }
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          if (buffer.length > MAX_CERTIFICATES_PDF_BYTES) {
            await sendToOwner(
              `That PDF is ${(buffer.length / 1024 / 1024).toFixed(1)}MB - please compress it under 8MB and resend (e.g. a lower-resolution scan).`
            );
            continue;
          }
          await db.setCertificatesPdf(buffer);
          await sendToOwner(`✅ Saved your certificates (${(buffer.length / 1024).toFixed(0)}KB) - I'll attach this alongside your CV and cover letter from now on.`);
        } catch (err) {
          console.error('[whatsapp] failed to save certificates PDF', err);
          await sendToOwner(`⚠️ Couldn't save that file: ${err.message}`).catch(() => {});
        }
        continue;
      }

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '';
      if (!text.trim()) continue;

      // Show WhatsApp's native "typing..." indicator immediately so there is visible
      // feedback while a reply is being worked out, instead of silence.
      sock.sendPresenceUpdate('composing', from).catch(() => {});

      try {
        await handleIncomingMessage(text.trim(), { sendMessage: sendToOwner, sendFile: sendFileToOwner });
      } catch (err) {
        console.error('[whatsapp] handler error', err);
        await sendToOwner(`⚠️ Something went wrong handling that: ${err.message}`).catch(() => {});
      } finally {
        sock.sendPresenceUpdate('paused', from).catch(() => {});
      }
    }
  });

  return sock;
}

async function sendToOwner(text) {
  if (!sock) throw new Error('WhatsApp socket not ready yet.');
  const jid = ownerJid();
  if (!jid) throw new Error('No owner JID known yet - message the bot once first so it can register your chat.');
  await sock.sendMessage(jid, { text });
}

async function sendFileToOwner(buffer, filename, mimetype, caption) {
  if (!sock) throw new Error('WhatsApp socket not ready yet.');
  const jid = ownerJid();
  if (!jid) throw new Error('No owner JID known yet - message the bot once first so it can register your chat.');
  await sock.sendMessage(jid, { document: buffer, fileName: filename, mimetype, caption });
}

function getStatus() {
  return { qr: latestQr, connected: isConnected };
}

module.exports = { startWhatsApp, sendToOwner, sendFileToOwner, getStatus };
