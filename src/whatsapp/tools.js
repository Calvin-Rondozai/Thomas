const db = require('../db');
const { sendApplicationEmail } = require('../email/mailer');
const { generateApplicationPdf } = require('../documents/pdf');
const { runScrapeCycle } = require('../scheduler');
const { fetchDetail } = require('../scrapers/detail');
const { matchJobDetailed, generateApplication } = require('../ai/gemini');
const { loadProfileText, loadCvTemplateText } = require('../profile/loadProfile');
const { makeJobId } = require('../utils');

/** The combined CV+cover-letter PDF, plus the user's uploaded certificates PDF if they've sent one. */
async function buildApplicationAttachments(draft) {
  const combinedPdf = await generateApplicationPdf({ coverLetterText: draft.coverLetter, cv: draft.cv });
  const fileName = `${draft.cv.name || 'Application'} CV and Cover Letter.pdf`;
  const attachments = [{ filename: fileName, content: combinedPdf }];

  const certificatesPdf = await db.getCertificatesPdf().catch(() => null);
  if (certificatesPdf) {
    attachments.push({ filename: `${draft.cv.name || 'Candidate'} Certificates.pdf`, content: certificatesPdf });
  }
  return { attachments, combinedPdf, fileName };
}

const TOOL_DEFS = [
  {
    name: 'get_status',
    description: 'Get the current status of the job bot: whether scraping is paused, whether auto-apply is on, when it last ran, and counts of pending/applied jobs.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_matches',
    description: "List job matches currently awaiting the user's review/approval, best score first.",
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'max number to return, default 10' } },
    },
  },
  {
    name: 'get_job_draft',
    description: 'Get the full details and drafted CV summary/cover letter/email text for one specific job match by its id.',
    input_schema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
  },
  {
    name: 'send_job_documents',
    description: 'Send the drafted CV and cover letter as PDF files directly in this chat for a specific job id, so the user can preview them before deciding.',
    input_schema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
  },
  {
    name: 'apply_to_job',
    description: 'Send the drafted application email for a specific job id to the employer. Only works if the job has a known direct application email address on file.',
    input_schema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
  },
  {
    name: 'reject_job',
    description: 'Mark a job match as rejected/not interested so the bot stops surfacing it.',
    input_schema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
  },
  {
    name: 'set_paused',
    description: 'Pause or resume the periodic scrape-and-match loop.',
    input_schema: { type: 'object', properties: { paused: { type: 'boolean' } }, required: ['paused'] },
  },
  {
    name: 'set_auto_apply',
    description: 'Turn automatic sending on or off. When on, the bot emails applications for high-scoring email-applicable matches immediately, without waiting for approval.',
    input_schema: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] },
  },
  {
    name: 'scrape_now',
    description: 'Trigger an immediate scrape-and-match cycle instead of waiting for the next scheduled run. Runs in the background; results follow as separate messages.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'submit_job',
    description: 'Evaluate one specific job the user has sent, and draft a full tailored CV, cover letter, and application email for it, sending the draft PDFs directly in this chat for review. Use this whenever the user shares a job posting URL or pastes job description text and wants it looked at, drafted, or applied to - unlike the automatic scraper, this always drafts something for the user to review, since they explicitly asked for this one.',
    input_schema: {
      type: 'object',
      properties: {
        urlOrText: { type: 'string', description: 'The job posting URL if one was given, otherwise the full pasted job description text.' },
        title: { type: 'string', description: "A short job title, inferred from the content if the user didn't state one explicitly." },
        company: { type: 'string', description: 'The company name, if known or inferable; omit if unknown.' },
      },
      required: ['urlOrText', 'title'],
    },
  },
  {
    name: 'get_summary',
    description: 'Get a recap of recent activity (last 24 hours by default): how many postings were seen, how many were good matches with their scores, how many were applied to, and when the last scrape ran. Use this whenever the user asks for a "summary" of what the bot has been doing.',
    input_schema: {
      type: 'object',
      properties: { hours: { type: 'integer', description: 'how many hours back to summarise, default 24' } },
    },
  },
];

async function execute(name, input, ctx) {
  switch (name) {
    case 'get_status': {
      const jobs = db.listJobs();
      const certificatesPdf = await db.getCertificatesPdf().catch(() => null);
      return {
        paused: !!db.getSetting('paused'),
        autoApply: !!db.getSetting('autoApply'),
        lastRunAt: db.getSetting('lastRunAt') || null,
        pendingCount: jobs.filter((j) => j.status === 'pending_review').length,
        appliedCount: jobs.filter((j) => j.status === 'applied').length,
        totalTracked: jobs.length,
        certificatesOnFile: !!certificatesPdf,
      };
    }

    case 'list_matches': {
      const limit = input.limit || 10;
      const matches = db
        .listJobs()
        .filter((j) => j.status === 'pending_review')
        .sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0))
        .slice(0, limit)
        .map((j) => ({
          id: j.id,
          title: j.title,
          company: j.company,
          location: j.location,
          score: j.matchScore,
          deadline: j.deadline,
          applyMethod: j.applyMethod,
          url: j.url,
        }));
      return { matches };
    }

    case 'get_job_draft': {
      const job = db.getJob(input.jobId);
      if (!job) return { error: 'no such job id' };
      return {
        title: job.title,
        company: job.company,
        url: job.url,
        applyMethod: job.applyMethod,
        matchScore: job.matchScore,
        matchReason: job.matchReason,
        cvSummary: job.draft?.cv?.summary || null,
        coverLetter: job.draft?.coverLetter || null,
        emailSubject: job.draft?.emailSubject || null,
        emailBody: job.draft?.emailBody || null,
      };
    }

    case 'send_job_documents': {
      const job = db.getJob(input.jobId);
      if (!job || !job.draft) return { error: 'no draft available for that job id' };
      const { attachments } = await buildApplicationAttachments(job.draft);
      for (const att of attachments) {
        await ctx.sendFile(att.content, att.filename, 'application/pdf', `Draft for ${job.title} at ${job.company || job.source} (match ${job.matchScore ?? '?'}/10)`);
      }
      return { success: true };
    }

    case 'apply_to_job': {
      const job = db.getJob(input.jobId);
      if (!job) return { error: 'no such job id' };
      if (!job.draft) return { error: 'no draft has been generated for this job yet' };
      if (job.applyMethod !== 'email' || !job.applyEmail) {
        return {
          error: 'This posting has no direct application email on file - it needs a manual application on the site.',
          url: job.url,
        };
      }
      const { attachments } = await buildApplicationAttachments(job.draft);
      await sendApplicationEmail({
        to: job.applyEmail,
        subject: job.draft.emailSubject,
        body: job.draft.emailBody,
        attachments,
      });
      job.status = 'applied';
      job.appliedAt = new Date().toISOString();
      db.upsertJob(job);
      return { success: true, sentTo: job.applyEmail };
    }

    case 'reject_job': {
      const job = db.getJob(input.jobId);
      if (!job) return { error: 'no such job id' };
      job.status = 'rejected';
      db.upsertJob(job);
      return { success: true };
    }

    case 'set_paused': {
      db.setSetting('paused', input.paused);
      return { paused: input.paused };
    }

    case 'set_auto_apply': {
      db.setSetting('autoApply', input.enabled);
      return { autoApply: input.enabled };
    }

    case 'scrape_now': {
      runScrapeCycle().catch((err) => console.error('[scrape_now] error', err));
      return { started: true };
    }

    case 'submit_job': {
      const raw = (input.urlOrText || '').trim();
      if (!raw) return { error: 'No job URL or text was given.' };

      const isUrl = /^https?:\/\//i.test(raw);
      let fullDescription;
      let applyEmail = null;
      const sourceUrl = isUrl ? raw : null;

      if (isUrl) {
        try {
          const detail = await fetchDetail(raw);
          fullDescription = detail.text;
          applyEmail = detail.email || null;
        } catch (err) {
          return { error: `Could not fetch that URL: ${err.message}` };
        }
      } else {
        fullDescription = raw;
        const emailMatch = raw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        applyEmail = emailMatch ? emailMatch[0] : null;
      }

      const job = {
        id: makeJobId(sourceUrl || fullDescription.slice(0, 300)),
        source: 'manual',
        url: sourceUrl,
        title: input.title,
        company: input.company || null,
        location: null,
        deadline: null,
        fullDescription,
        applyEmail,
        applyMethod: applyEmail ? 'email' : 'manual',
      };

      const profileText = loadProfileText();
      const cvTemplateText = loadCvTemplateText();

      const { score, reasoning } = await matchJobDetailed(job, profileText);
      job.matchScore = score;
      job.matchReason = reasoning;

      const draft = await generateApplication(job, profileText, cvTemplateText);
      job.draft = draft;
      job.status = 'pending_review';
      db.upsertJob(job);

      const { attachments } = await buildApplicationAttachments(draft);
      for (const att of attachments) {
        await ctx.sendFile(
          att.content,
          att.filename,
          'application/pdf',
          `Draft for ${job.title}${job.company ? ` at ${job.company}` : ''} (match ${score}/10)`
        );
      }

      return {
        success: true,
        jobId: job.id,
        matchScore: score,
        matchReason: reasoning,
        applyMethod: job.applyMethod,
        note:
          job.applyMethod === 'email'
            ? `Reply "apply ${job.id}" to send it.`
            : `No direct application email was found in that posting - this one needs a manual application${sourceUrl ? ` at ${sourceUrl}` : ''}.`,
      };
    }

    case 'get_summary': {
      const hours = input.hours || 24;
      const since = Date.now() - hours * 60 * 60 * 1000;
      const recent = db.listJobs().filter((j) => new Date(j.updatedAt || j.createdAt).getTime() >= since);
      return {
        windowHours: hours,
        lastRunAt: db.getSetting('lastRunAt') || null,
        paused: !!db.getSetting('paused'),
        autoApply: !!db.getSetting('autoApply'),
        postingsSeen: recent.length,
        matchesFound: recent
          .filter((j) => ['pending_review', 'applied'].includes(j.status))
          .sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0))
          .map((j) => ({ id: j.id, title: j.title, company: j.company, score: j.matchScore, status: j.status })),
        applied: recent.filter((j) => j.status === 'applied').length,
        belowThreshold: recent.filter((j) => j.status === 'below_threshold').length,
        errors: recent.filter((j) => j.status === 'error').length,
      };
    }

    default:
      return { error: `unknown tool ${name}` };
  }
}

module.exports = { TOOL_DEFS, execute };
