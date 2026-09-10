const vacancymail = require('./vacancymail');
const jobszimbabwe = require('./jobszimbabwe');
const ihararejobs = require('./ihararejobs');
const applynow = require('./applynow');

// NOTE: zimbajob.com is deliberately excluded - its robots.txt explicitly sets
// "Disallow: /" for ClaudeBot and several other AI crawlers, so we respect that
// and don't scrape it.
const SOURCES = { vacancymail, jobszimbabwe, ihararejobs, applynow };

async function scrapeAll({ maxPages } = {}) {
  const all = [];
  const summary = {};

  for (const [name, mod] of Object.entries(SOURCES)) {
    try {
      const jobs = await mod.fetchListings({ maxPages });
      summary[name] = { count: jobs.length, error: null };
      all.push(...jobs);
    } catch (err) {
      summary[name] = { count: 0, error: err.message };
      console.error(`[scrapeAll] ${name} failed:`, err.message);
    }
    // small polite delay between hitting different sites
    await new Promise((r) => setTimeout(r, 1000));
  }

  return { jobs: all, summary };
}

module.exports = { scrapeAll, SOURCES };
