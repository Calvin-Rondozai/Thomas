const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const db = require('../db');
const notifier = require('../notifier');

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

// Cheap/fast model for bulk screening, capable model for real judgement + writing.
const FAST_MODEL = 'claude-haiku-4-5-20251001';
const SMART_MODEL = 'claude-sonnet-5';

function textOf(res) {
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error(`No JSON found in model response: ${text.slice(0, 300)}`);
  return JSON.parse(match[0]);
}

// --- rate-limit / quota / auth issue notifications ---------------------------------
// Don't spam WhatsApp if a whole batch of jobs fails in a row - one heads-up per
// cooldown window is enough.
const API_ISSUE_NOTIFY_COOLDOWN_MS = 15 * 60 * 1000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatResetTime(value) {
  if (!value) return null;
  // Anthropic sends either an ISO 8601 timestamp (rate limit headers) or a number of
  // seconds from now (a bare "retry-after" header).
  const d = /^\d+$/.test(String(value)) ? new Date(Date.now() + Number(value) * 1000) : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  // Africa/Harare is a fixed UTC+2 offset year-round (no DST) - compute it directly
  // instead of relying on the Node build having full ICU/timezone data installed.
  const harare = new Date(d.getTime() + 2 * 60 * 60 * 1000);
  const day = harare.getUTCDate();
  const month = MONTHS[harare.getUTCMonth()];
  const year = harare.getUTCFullYear();
  const hh = String(harare.getUTCHours()).padStart(2, '0');
  const mm = String(harare.getUTCMinutes()).padStart(2, '0');
  return `${day} ${month} ${year}, ${hh}:${mm} (Harare time)`;
}

function notifyApiIssue(err) {
  const status = err?.status;
  const headers = err?.headers || {};
  const bodyMessage = err?.error?.error?.message || err?.message || '';

  const isRateLimit = status === 429;
  const isOverloaded = status === 529 || err?.error?.error?.type === 'overloaded_error';
  const isLowCredit = status === 400 && /credit balance/i.test(bodyMessage);
  const isAuth = status === 401;

  if (!isRateLimit && !isOverloaded && !isLowCredit && !isAuth) return;

  const last = db.getSetting('lastApiIssueNotifiedAt');
  if (last && Date.now() - new Date(last).getTime() < API_ISSUE_NOTIFY_COOLDOWN_MS) return;
  db.setSetting('lastApiIssueNotifiedAt', new Date().toISOString());

  if (isAuth) {
    notifier.emit('notify', '⚠️ Claude API rejected the request as unauthenticated - check that ANTHROPIC_API_KEY is set correctly.');
    return;
  }
  if (isLowCredit) {
    notifier.emit(
      'notify',
      '⚠️ Claude API credit balance is too low. Add credit at https://console.anthropic.com/settings/billing to keep the bot running.'
    );
    return;
  }

  const reset =
    formatResetTime(headers['anthropic-ratelimit-tokens-reset']) ||
    formatResetTime(headers['anthropic-ratelimit-input-tokens-reset']) ||
    formatResetTime(headers['anthropic-ratelimit-output-tokens-reset']) ||
    formatResetTime(headers['anthropic-ratelimit-requests-reset']) ||
    formatResetTime(headers['retry-after']);

  const label = isOverloaded ? "Claude's API is temporarily overloaded" : 'Hit the Claude API rate/usage limit';
  notifier.emit(
    'notify',
    `⚠️ ${label}.${reset ? ` It should reset around ${reset}.` : ' No reset time was given - it should clear shortly.'} The bot will keep retrying automatically in the background.`
  );
}

async function createMessage(params) {
  try {
    return await client.messages.create(params);
  } catch (err) {
    notifyApiIssue(err);
    throw err;
  }
}

/**
 * Cheap first pass over a batch of freshly-scraped listing cards (title/location/
 * snippet only - no detail-page fetch yet) to drop obviously irrelevant postings
 * before we spend a detail-page fetch + a bigger model call on each one.
 */
async function preFilterJobs(jobs, profileSummary) {
  if (jobs.length === 0) return [];
  const listing = jobs
    .map((j, i) => `${i}. [${j.source}] ${j.title} - ${j.location || 'location n/a'}${j.snippet ? ` - ${j.snippet.slice(0, 160)}` : ''}`)
    .join('\n');

  const prompt = `You are screening a list of Zimbabwean job/opportunity postings for ONE candidate.

Candidate profile summary:
${profileSummary}

Postings (index, source, title, location, snippet):
${listing}

Return ONLY a JSON array of the integer indexes of postings that are plausibly relevant to this candidate's background, skills, and career level. Be moderately inclusive - when in doubt, include it, since a more careful check happens later. Example: [0,2,5]. If none are relevant, return [].`;

  const res = await createMessage({
    model: FAST_MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  try {
    const indexes = extractJson(textOf(res));
    return indexes.map((i) => jobs[i]).filter(Boolean);
  } catch (err) {
    console.error('[claude] preFilterJobs: failed to parse response, keeping all jobs to fail open:', err.message);
    return jobs;
  }
}

/** Careful score + reasoning against the candidate's full profile and the job's full description. */
async function matchJobDetailed(job, profileText) {
  const prompt = `You are helping a job seeker in Zimbabwe decide whether a posting is worth applying to. Here is their full profile/background:

${profileText}

Here is the job posting:
Title: ${job.title}
Company: ${job.company || 'unknown'}
Location: ${job.location || 'unknown'}
Deadline: ${job.deadline || 'unknown'}
Source: ${job.source} (${job.url})

Full description:
${job.fullDescription || job.snippet || '(no description available)'}

Score how well this candidate matches this specific posting from 0 to 10 (10 = excellent match) considering their actual skills, experience level, and stated preferences. Respond ONLY with JSON: {"score": <number>, "reasoning": "<2-3 sentence explanation>"}`;

  const res = await createMessage({
    model: SMART_MODEL,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  return extractJson(textOf(res));
}

/** Generates a tailored CV (structured JSON), cover letter, and application email for one job. */
async function generateApplication(job, profileText, cvTemplateText) {
  const prompt = `You are an expert career writer helping a Zimbabwean job seeker apply for a specific job. Never invent facts, employers, dates, qualifications, or skills that are not present in the candidate profile below - only reorganize, emphasize, and phrase what is actually there. If something relevant isn't in the profile, leave it out rather than making it up. Never use an em dash (—) or en dash (–) anywhere in the CV or cover letter text - use a comma, a period, a regular hyphen (-), or "at"/"to" instead.

CANDIDATE PROFILE (ground truth - do not contradict or embellish beyond this):
${profileText}

CV STYLE/TEMPLATE TO FOLLOW (structure, section order, and tone reference only - not factual content):
${cvTemplateText}

JOB POSTING:
Title: ${job.title}
Company: ${job.company || 'unknown'}
Location: ${job.location || 'unknown'}
Source: ${job.source} (${job.url})
Description:
${job.fullDescription || job.snippet || '(no description available)'}

Produce a tailored application, re-ordering and re-emphasizing the candidate's real experience/skills to best fit this specific posting. Respond ONLY with JSON in this exact shape:
{
  "cv": {
    "name": "...",
    "title": "...",
    "contact": "...",
    "summary": "...",
    "experience": [{"role":"...","employer":"...","dates":"...","bullets":["...","..."]}],
    "education": [{"qualification":"...","institution":"...","dates":"..."}],
    "skills": ["...","..."]
  },
  "coverLetter": "full cover letter text, addressed generically if no hiring manager name is known",
  "emailSubject": "...",
  "emailBody": "short professional email body to accompany the attached CV and cover letter"
}`;

  const res = await createMessage({
    model: SMART_MODEL,
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });

  return extractJson(textOf(res));
}

module.exports = {
  client,
  createMessage,
  FAST_MODEL,
  SMART_MODEL,
  preFilterJobs,
  matchJobDetailed,
  generateApplication,
};
