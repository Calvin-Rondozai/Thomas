const nodemailer = require('nodemailer');
const config = require('../config');

function buildTransport() {
  return nodemailer.createTransport({
    service: config.EMAIL_SERVICE,
    auth: {
      user: config.EMAIL_USER,
      pass: config.EMAIL_APP_PASSWORD,
    },
  });
}

async function sendApplicationEmail({ to, subject, body, attachments }) {
  if (!config.EMAIL_USER || !config.EMAIL_APP_PASSWORD) {
    throw new Error('EMAIL_USER / EMAIL_APP_PASSWORD are not configured.');
  }
  const transporter = buildTransport();
  return transporter.sendMail({
    from: config.EMAIL_USER,
    to,
    subject,
    text: body,
    attachments,
  });
}

module.exports = { sendApplicationEmail };
