// Source: https://applynow.co.zw/
// robots.txt (checked 2026-09-10) only disallows /wp-admin/. This site mixes jobs
// with scholarships/grants/fellowships/contests - we keep everything and let the
// AI matching step decide what's actually relevant to the candidate.
const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../config');

const BASE = 'https://applynow.co.zw';

async function fetchListings({ maxPages = 1 } = {}) {
  const results = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1 ? `${BASE}/` : `${BASE}/page/${page}/`;
    let html;
    try {
      const res = await axios.get(url, { headers: { 'User-Agent': config.USER_AGENT }, timeout: 20000 });
      html = res.data;
    } catch (err) {
      console.error(`[applynow] failed to fetch ${url}: ${err.message}`);
      break;
    }

    const $ = cheerio.load(html);
    const cards = $('h2.entry-title a.p-url');
    if (cards.length === 0) break;

    cards.each((_, el) => {
      const $el = $(el);
      const title = $el.text().trim();
      const link = $el.attr('href');
      const tags = $el.closest('.p-content').find('.meta-tax a').map((__, a) => $(a).text().trim()).get();

      if (title && link) {
        results.push({
          source: 'applynow',
          url: link,
          title,
          company: null,
          location: tags.find((t) => !/remote|onsite/i.test(t)) || null,
          tags,
          deadline: null,
          postedRaw: null,
          snippet: null,
        });
      }
    });
  }
  return results;
}

module.exports = { fetchListings };
