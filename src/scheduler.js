const cron = require('node-cron');
const config = require('./config');
const db = require('./db');
const notifier = require('./notifier');
const { scrapeAll } = require('./scrapers');
const { fetchDetail } = require('./scrapers/detail');
const { preFilterJobs, matchJobDetailed, generateApplication } = require('./ai/claude');
const { loadProfileText, loadProfileSummary, loadCvTemplateText } = require('./profile/loadProfile');
const { makeJobId } = require('./utils');

let running = false;

function formatSummary(summary) {
  return Object.entries(summary)
    .map(([s, v]) => `• ${s}: ${v.count} listing(s)${v.error ? ` (error: ${v.error})` : ''}`)
    .join('\n');
}

async function runScrapeCycle() {
  if (running) {
    notifier.emit('notify', '⏳ A scrape cycle is already running, skipping this trigger.');
    return;
  }
  if (db.getSetting('paused')) {
    notifier.emit('notify', '⏸️ Scraping is paused - say "resume" first.');
    return;
  }

  running = true;
  const startedAt = Date.now();

  try {
    const { jobs, summary } = await scrapeAll({ maxPages: config.MAX_PAGES_PER_SOURCE });

    const newJobs = jobs.map((j) => ({ ...j, id: makeJobId(j.url) })).filter((j) => !db.getJob(j.id));

    for (const job of newJobs) {
      db.upsertJob({ ...job, status: 'seen' });
    }

    if (newJobs.length === 0) {
      notifier.emit('notify', `🔎 Scrape complete. No new postings since last run.\n${formatSummary(summary)}`);
      db.setSetting('lastRunAt', new Date().toISOString());
      return;
    }

    const profileSummary = await loadProfileSummary();
    const shortlisted = await preFilterJobs(newJobs, profileSummary);

    const profileText = loadProfileText();
    const cvTemplateText = loadCvTemplateText();
    let matchedCount = 0;

    for (const job of shortlisted) {
      try {
        const detail = await fetchDetail(job.url);
        job.fullDescription = detail.text;
        job.applyEmail = detail.email || null;
        job.applyMethod = detail.email ? 'email' : 'manual';

        const { score, reasoning } = await matchJobDetailed(job, profileText);
        job.matchScore = score;
        job.matchReason = reasoning;

        if (score >= config.MATCH_THRESHOLD) {
          const draft = await generateApplication(job, profileText, cvTemplateText);
          job.draft = draft;
          job.status = 'pending_review';
          matchedCount++;

          const applyNote =
            job.applyMethod === 'email'
              ? `Reply "apply ${job.id}" to send it, or "show cv ${job.id}" to see the draft first.`
              : `This one needs a manual application on their site: ${job.url}`;

          notifier.emit(
            'notify',
            `✅ Match found (${score}/10): *${job.title}* at ${job.company || job.source}\n📍 ${job.location || 'n/a'} | ⏰ ${job.deadline || 'n/a'}\n${reasoning}\n\n${applyNote}\n(id: ${job.id})`
          );

          if (db.getSetting('autoApply') && job.applyMethod === 'email') {
            try {
              await require('./whatsapp/tools').execute('apply_to_job', { jobId: job.id }, {});
              notifier.emit('notify', `📤 Auto-applied to *${job.title}* at ${job.company || job.source}.`);
            } catch (err) {
              notifier.emit('notify', `⚠️ Auto-apply failed for *${job.title}*: ${err.message}`);
            }
          }
        } else {
          job.status = 'below_threshold';
        }
        db.upsertJob(job);
      } catch (err) {
        console.error(`[scheduler] failed processing job ${job.url}:`, err.message);
      }
    }

    notifier.emit(
      'notify',
      `🔎 Scrape complete in ${Math.round((Date.now() - startedAt) / 1000)}s.\n${formatSummary(summary)}\nNew postings seen: ${newJobs.length} | Shortlisted for review: ${shortlisted.length} | Good matches: ${matchedCount}`
    );
    db.setSetting('lastRunAt', new Date().toISOString());
  } catch (err) {
    console.error('[scheduler] cycle failed:', err);
    notifier.emit('notify', `⚠️ Scrape cycle failed: ${err.message}`);
  } finally {
    running = false;
  }
}

function startScheduler() {
  const interval = config.SCRAPE_INTERVAL_MINUTES;
  const cronExpr = `*/${interval} * * * *`;
  console.log(`[scheduler] running every ${interval} minute(s): ${cronExpr}`);
  cron.schedule(cronExpr, () => {
    runScrapeCycle().catch((err) => console.error('[scheduler] unhandled error', err));
  });
}

module.exports = { startScheduler, runScrapeCycle };
