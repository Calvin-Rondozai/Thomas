// Source: https://ihararejobs.com/
// robots.txt (checked 2026-09-10) disallows /login/ /static/ /register/ /candidate/
// /employer_admin/ /admin/ /vacancy/apply/ - the homepage listing itself is allowed.
const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../config');

const BASE = 'https://ihararejobs.com';

async function fetchListings() {
  const results = [];
  let html;
  try {
    const res = await axios.get(`${BASE}/`, { headers: { 'User-Agent': config.USER_AGENT }, timeout: 20000 });
    html = res.data;
  } catch (err) {
    console.error(`[ihararejobs] failed to fetch homepage: ${err.message}`);
    return results;
  }

  const $ = cheerio.load(html);
  $('.top-company-list').each((_, el) => {
    const $el = $(el);
    const titleEl = $el.find('.company-list-details h3 a').first();
    const title = titleEl.text().trim();
    const href = titleEl.attr('href');
    const link = href ? new URL(href, BASE).toString() : null;

    let company = null;
    let location = null;
    let deadline = null;
    let salary = null;

    $el.find('.company-list-details p').each((__, p) => {
      const $p = $(p);
      const text = $p.text().trim();
      if (/expires/i.test(text)) deadline = text.replace(/expires:?/i, '').trim();
      else if (/salary/i.test(text)) salary = text;
      else if ($p.hasClass('company-state')) location = text;
      else if (!company) company = text;
    });

    if (title && link) {
      results.push({
        source: 'ihararejobs',
        url: link,
        title,
        company,
        location,
        deadline,
        salary,
        postedRaw: null,
        snippet: null,
      });
    }
  });

  return results;
}

module.exports = { fetchListings };
