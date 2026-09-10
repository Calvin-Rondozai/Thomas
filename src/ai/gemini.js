const { GoogleGenAI } = require('@google/genai');
const config = require('../config');
const db = require('../db');
const notifier = require('../notifier');

// Both roles currently point at the same model. Confirmed live during setup:
// - gemini-pro-latest has zero free-tier quota on this project (429s immediately,
//   "limit: 0").
// - gemini-flash-latest (currently aliasing gemini-3.8-flash) is usable, but its
//   free-tier daily quota is only ~20 requests/day *per Google Cloud project* - and
//   note that quota is per-project, not per-key, so pooling several API keys in
//   GEMINI_API_KEYS only helps if they belong to *different* Google accounts/
//   projects; keys from the same project share one 20/day bucket and will all
//   exhaust together.
// - gemini-flash-lite-latest has a much higher free-tier daily quota, so it is used
//   for both the cheap pre-filter and the real matching/drafting work. If you add
//   billing to your Google Cloud project (or have separate-project keys with real
//   headroom), bump SMART_MODEL to 'gemini-flash-latest' or 'gemini-pro-latest' for
//   better writing quality.
const FAST_MODEL = 'gemini-flash-lite-latest';
const SMART_MODEL = 'gemini-flash-lite-latest';

if (config.GEMINI_API_KEYS.length === 0) {
  throw new Error('No GEMINI_API_KEYS configured - set at least one key in .env.');
}

// One client per key, so a quota hit on one key can transparently roll over to the
// next (useful when pooling several free-tier keys, as this project does).
const clients = config.GEMINI_API_KEYS.map((key) => new GoogleGenAI({ apiKey: key }));
let currentKeyIndex = 0;

function textOf(res) {
  return res.text || '';
}

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error(`No JSON found in model response: ${text.slice(0, 300)}`);
  return JSON.parse(match[0]);
}

// --- error inspection ----------------------------------------------------------------
// @google/genai's ApiError only exposes `.status` and `.message` (the message IS the
// raw JSON error body, as a string) - so it is parsed back out here.
function parseErrorBody(err) {
  try {
    return JSON.parse(err.message);
  } catch {
    return null;
  }
}

function isQuotaError(err) {
  if (err?.status === 429) return true;
  return parseErrorBody(err)?.error?.status === 'RESOURCE_EXHAUSTED';
}

function isAuthError(err) {
  return err?.status === 401 || err?.status === 403;
}

function extractRetryDelaySeconds(err) {
  const details = parseErrorBody(err)?.error?.details;
  if (!Array.isArray(details)) return null;
  const retryInfo = details.find((d) => typeof d['@type'] === 'string' && d['@type'].includes('RetryInfo'));
  const raw = retryInfo?.retryDelay; // e.g. "34s"
  const match = raw ? String(raw).match(/([\d.]+)s/) : null;
  return match ? Math.ceil(parseFloat(match[1])) : null;
}

// Hours remaining until the next midnight in Pacific time, where Google resets
// free-tier per-day quotas. Computed via Intl (DST-safe - it only ever formats a known
// instant into that zone, never the reverse, so no manual UTC-offset math is needed).
function hoursUntilPacificMidnight(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .formatToParts(now)
    .reduce((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
  const h = parseInt(parts.hour, 10) % 24;
  const m = parseInt(parts.minute, 10);
  const minutesUntilMidnight = 24 * 60 - (h * 60 + m);
  return minutesUntilMidnight / 60;
}

const API_ISSUE_NOTIFY_COOLDOWN_MS = 15 * 60 * 1000;

function notifyApiIssue(err) {
  const last = db.getSetting('lastApiIssueNotifiedAt');
  if (last && Date.now() - new Date(last).getTime() < API_ISSUE_NOTIFY_COOLDOWN_MS) return;
  db.setSetting('lastApiIssueNotifiedAt', new Date().toISOString());

  if (isAuthError(err)) {
    notifier.emit('notify', '⚠️ Gemini API rejected a request as unauthenticated/forbidden - check GEMINI_API_KEYS are valid.');
    return;
  }

  if (isQuotaError(err)) {
    const retrySeconds = extractRetryDelaySeconds(err);
    if (retrySeconds) {
      notifier.emit(
        'notify',
        `⚠️ Hit the Gemini API rate limit on all ${clients.length} key(s) in rotation. It gave a short retry delay of about ${retrySeconds}s - the bot will keep retrying automatically.`
      );
      return;
    }
    const hours = hoursUntilPacificMidnight().toFixed(1);
    notifier.emit(
      'notify',
      `⚠️ Hit the Gemini API's daily quota on all ${clients.length} key(s) in rotation. Google resets free-tier daily quotas at midnight Pacific time - that is roughly ${hours} hours from now. The bot will keep trying and catch up once it resets.`
    );
    return;
  }

  // A repeated server-side overload (503/500) or a raw network failure (no structured
  // status at all) that outlasted the backoff retries.
  notifier.emit(
    'notify',
    `⚠️ The Gemini API (or the network) has been failing for a bit: "${String(err.message).slice(0, 200)}". The bot will keep retrying on its own.`
  );
}

function isTransientServerError(err) {
  // 503/500 are Gemini reporting its own overload; a missing status usually means the
  // SDK never got a structured API response at all (a raw network hiccup, e.g. "fetch
  // failed") - both are worth a short backoff-retry rather than giving up immediately.
  return err?.status === 503 || err?.status === 500 || err?.status === undefined;
}

/** One pass across every configured key; throws the last error if all of them fail. */
async function attemptAcrossKeys(params) {
  let lastErr;
  for (let attempt = 0; attempt < clients.length; attempt++) {
    const idx = (currentKeyIndex + attempt) % clients.length;
    try {
      const res = await clients[idx].models.generateContent(params);
      currentKeyIndex = idx; // stick with whichever key just worked
      return res;
    } catch (err) {
      lastErr = err;
      if (isTransientServerError(err)) break; // a server-side overload, not a key problem - stop rotating, just back off
      if (!isQuotaError(err)) throw err; // a real error - do not hide it by rotating, surface it immediately
      console.warn(`[gemini] key #${idx + 1}/${clients.length} is quota-exhausted, trying the next one...`);
    }
  }
  throw lastErr;
}

const SERVER_ERROR_RETRIES = 3;

/**
 * Calls generateContent, rotating across all configured keys if one is quota-exhausted,
 * and backing off/retrying a few times on a transient server-side overload (503/500).
 * Only notifies WhatsApp (with a cooldown) once retries/rotation are fully exhausted.
 */
async function generateContent(params) {
  for (let serverAttempt = 0; ; serverAttempt++) {
    try {
      return await attemptAcrossKeys(params);
    } catch (err) {
      const canRetry = isTransientServerError(err) && serverAttempt < SERVER_ERROR_RETRIES;
      if (!canRetry) {
        notifyApiIssue(err);
        throw err;
      }
      const delayMs = 1000 * 2 ** serverAttempt;
      console.warn(`[gemini] model overloaded (${err.status}), retrying in ${delayMs}ms...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  notifyApiIssue(lastErr);
  throw lastErr;
}

/**
 * Cheap first pass over a batch of freshly-scraped listing cards (title/location/
 * snippet only - no detail-page fetch yet) to drop obviously irrelevant postings
 * before spending a detail-page fetch plus a bigger model call on each one.
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

  const res = await generateContent({ model: FAST_MODEL, contents: prompt });

  try {
    const indexes = extractJson(textOf(res));
    return indexes.map((i) => jobs[i]).filter(Boolean);
  } catch (err) {
    console.error('[gemini] preFilterJobs: failed to parse response, keeping all jobs to fail open:', err.message);
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

  const res = await generateContent({ model: SMART_MODEL, contents: prompt });
  return extractJson(textOf(res));
}

/** Generates a tailored CV (structured JSON), cover letter, and application email for one job. */
async function generateApplication(job, profileText, cvTemplateText) {
  const prompt = `You are an expert career writer helping a Zimbabwean job seeker apply for a specific job. Never invent facts, employers, dates, qualifications, or skills that are not present in the candidate profile below - only reorganize, emphasize, and phrase what is actually there. If something relevant is not in the profile, leave it out rather than making it up. Never use an em dash (—) or en dash (–) anywhere in the CV or cover letter text - use a comma, a period, a regular hyphen (-), or "at"/"to" instead.

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

  const res = await generateContent({
    model: SMART_MODEL,
    contents: prompt,
    config: { maxOutputTokens: 4000 },
  });

  return extractJson(textOf(res));
}

module.exports = {
  generateContent,
  FAST_MODEL,
  SMART_MODEL,
  preFilterJobs,
  matchJobDetailed,
  generateApplication,
};
