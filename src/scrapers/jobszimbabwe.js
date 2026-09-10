// Source: https://jobszimbabwe.co.zw/
// robots.txt (checked 2026-09-10) has no Disallow rules at all for general crawlers.
const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../config');

const BASE = 'https://jobszimbabwe.co.zw';

async function fetchListings({ maxPages = 2 } = {}) {
  const results = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1 ? `${BASE}/` : `${BASE}/page/${page}/`;
    let html;
    try {
      const res = await axios.get(url, { headers: { 'User-Agent': config.USER_AGENT }, timeout: 20000 });
      html = res.data;
    } catch (err) {
      console.error(`[jobszimbabwe] failed to fetch ${url}: ${err.message}`);
      break;
    }

    const $ = cheerio.load(html);
    const cards = $('article[class*="noo_job"]');
    if (cards.length === 0) break;

    cards.each((_, el) => {
      const $el = $(el);
      const link = $el.attr('data-url') || $el.find('.loop-item-title a').attr('href');
      const title = $el.find('.loop-item-title a').first().text().trim();
      const location = $el.find('.job-location').first().text().trim().replace(/\s+/g, ' ');
      const deadline = $el.find('.job-date__closing').first().text().trim();
      const employmentType = $el.find('.job-type').first().text().trim();
      const category = $el.find('.job-category').first().text().trim();

      if (title && link) {
        results.push({
          source: 'jobszimbabwe',
          url: link,
          title,
          company: null,
          location: location || null,
          deadline: deadline || null,
          employmentType: employmentType || null,
          category: category || null,
          postedRaw: null,
          snippet: null,
        });
      }
    });
  }
  return results;
}

module.exports = { fetchListings };
