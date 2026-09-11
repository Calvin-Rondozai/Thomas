// One-time local helper: run this once on your own machine (not on Render) to get a
// Gmail OAuth refresh token, so the deployed bot can send email as your real Gmail
// address without needing SMTP access. See README.md for the full Google Cloud setup
// this depends on (creating the project, enabling the Gmail API, configuring the
// OAuth consent screen and client ID).
//
// Usage:
//   1. Put GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in your local .env
//   2. node scripts/get-gmail-token.js
//   3. Follow the printed instructions
require('dotenv').config();
const readline = require('readline');
const { OAuth2Client } = require('google-auth-library');

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in your .env first (from Google Cloud Console > APIs & Services > Credentials).');
  process.exit(1);
}

const oauth2Client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // forces a refresh_token even if you've authorized this app before
  scope: ['https://www.googleapis.com/auth/gmail.send'],
});

console.log('\n1. Open this URL in your browser and sign in with the Gmail account you want the bot to send from:\n');
console.log(authUrl);
console.log('\n2. You will likely see a "Google hasn\'t verified this app" warning - this is expected for a personal');
console.log('   project. Click "Advanced", then "Go to <your app name> (unsafe)", then approve access.');
console.log('3. The browser will then redirect to a localhost address that fails to load - that is expected too.');
console.log('4. Copy the value after "code=" in that browser address bar (everything up to the next "&", if there is one).\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Paste the code here: ', async (code) => {
  rl.close();
  try {
    const { tokens } = await oauth2Client.getToken(code.trim());
    if (!tokens.refresh_token) {
      console.log(
        '\nNo refresh token was returned - this usually happens if you already authorized this app before. Go to https://myaccount.google.com/permissions, remove access for this app, and run this script again.'
      );
      return;
    }
    console.log('\nSuccess! Add this to your .env and Render environment variables:\n');
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log(
      '\nOne more step before this token becomes long-lived: go back to Google Cloud Console > APIs & Services >'
    );
    console.log(
      'OAuth consent screen, and click "Publish App" to move it from Testing to Production. Otherwise Google'
    );
    console.log('expires test-mode refresh tokens after 7 days.');
  } catch (err) {
    console.error('Failed to exchange code:', err.response?.data || err.message);
  }
});
