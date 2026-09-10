// Generic job-detail-page fetcher shared by every source: pulls the full
// description text and looks for a direct application email address (mailto:
// links first, then a regex scan of the body text - many Zimbabwean listings
// simply say "send your CV to hr@company.co.zw").
const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../config');

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|svg|webp)$/i;

async function fetchDetail(url) {
  const res = await axios.get(url, { headers: { 'User-Agent': config.USER_AGENT }, timeout: 20000 });
  const $ = cheerio.load(res.data);
  $('script, style, nav, footer, header, form').remove();

  const mailtoEmails = $('a[href^="mailto:"]')
    .map((_, a) => ($(a).attr('href') || '').replace(/^mailto:/i, '').split('?')[0])
    .get()
    .filter((e) => EMAIL_RE.test(e));
  EMAIL_RE.lastIndex = 0; // .test() with a /g regex is stateful - reset before reuse below

  const container = $('article').first().length
    ? $('article').first()
    : $('main').first().length
      ? $('main').first()
      : $('body');

  const text = container.text().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  const bodyEmails = text.match(EMAIL_RE) || [];
  const allEmails = [...new Set([...mailtoEmails, ...bodyEmails])].filter((e) => !IMAGE_EXT_RE.test(e));

  return {
    text: text.slice(0, 6000),
    email: allEmails[0] || null,
    allEmails,
  };
}

module.exports = { fetchDetail };
