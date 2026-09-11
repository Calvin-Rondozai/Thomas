// Sends via the Gmail API (HTTPS) using OAuth2, rather than SMTP - this is what lets
// email actually send as your real Gmail address on hosts (like Render's free tier)
// that block outbound SMTP ports 25/465/587. See scripts/get-gmail-token.js for how to
// obtain GMAIL_REFRESH_TOKEN one time.
//
// nodemailer's MailComposer is used ONLY to build a correctly-formatted raw MIME
// message (headers + body + PDF attachments) - it never actually connects to an SMTP
// server; the finished message is handed to the Gmail API instead.
const axios = require('axios');
const { OAuth2Client } = require('google-auth-library');
const MailComposer = require('nodemailer/lib/mail-composer');
const config = require('../config');

function buildOAuthClient() {
  if (!config.GMAIL_CLIENT_ID || !config.GMAIL_CLIENT_SECRET || !config.GMAIL_REFRESH_TOKEN) {
    throw new Error('GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN are not configured.');
  }
  const client = new OAuth2Client(config.GMAIL_CLIENT_ID, config.GMAIL_CLIENT_SECRET);
  client.setCredentials({ refresh_token: config.GMAIL_REFRESH_TOKEN });
  return client;
}

function buildRawMessage({ to, subject, text, attachments }) {
  return new Promise((resolve, reject) => {
    const mail = new MailComposer({
      from: config.EMAIL_USER,
      to,
      subject,
      text,
      attachments,
    });
    mail.compile().build((err, message) => {
      if (err) return reject(err);
      // Gmail API wants URL-safe base64, no padding.
      const raw = message.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      resolve(raw);
    });
  });
}

async function sendApplicationEmail({ to, subject, body, attachments }) {
  if (!config.EMAIL_USER) throw new Error('EMAIL_USER is not configured.');
  const oauth2Client = buildOAuthClient();
  const { token } = await oauth2Client.getAccessToken();
  if (!token) throw new Error('Failed to obtain a Gmail access token - check the OAuth credentials/refresh token.');

  const raw = await buildRawMessage({ to, subject, text: body, attachments });

  return axios.post(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    { raw },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
}

module.exports = { sendApplicationEmail };
