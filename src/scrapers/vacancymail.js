// Source: https://vacancymail.co.zw/jobs/
// robots.txt (checked 2026-09-10) disallows /login/ /static/ /register/ /candidate/
// /employer_admin/ /admin/ /vacancy/apply/ - it does NOT disallow /jobs/, so listing
// pages are fair game. We never touch /vacancy/apply/ (their own application form).
const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../config');

const BASE = 'https://vacancymail.co.zw';

async function fetchListings({ maxPages = 2 } = {}) {
  const results = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1 ? `${BASE}/jobs/` : `${BASE}/jobs/?page=${page}`;
    let html;
    try {
      const res = await axios.get(url, { headers: { 'User-Agent': config.USER_AGENT }, timeout: 20000 });
      html = res.data;
    } catch (err) {
      console.error(`[vacancymail] failed to fetch ${url}: ${err.message}`);
      break;
    }

    const $ = cheerio.load(html);
    const cards = $('a.job-listing');
    if (cards.length === 0) break;

    cards.each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href');
      const link = href ? new URL(href, BASE).toString() : null;
      const title = $el.find('.job-listing-title').first().text().trim();
      const snippet = $el.find('.job-listing-text').first().text().trim();
      const footerItems = $el.find('.job-listing-footer li').map((__, li) => $(li).text().trim()).get();

      const deadlineItem = footerItems.find((t) => /expires/i.test(t));
      const typeItem = footerItems.find((t) => /full time|part time|contract|internship|temporary/i.test(t));
      const postedItem = footerItems.find((t) => /posted/i.test(t));
      const locationItem = footerItems.find((t) => t !== deadlineItem && t !== typeItem && t !== postedItem);

      if (title && link) {
        results.push({
          source: 'vacancymail',
          url: link,
          title,
          company: null,
          location: locationItem || null,
          deadline: deadlineItem ? deadlineItem.replace(/expires/i, '').trim() : null,
          employmentType: typeItem || null,
          postedRaw: postedItem || null,
          snippet: snippet || null,
        });
      }
    });
  }
  return results;
}

module.exports = { fetchListings };
