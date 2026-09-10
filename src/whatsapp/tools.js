const db = require('../db');
const { sendApplicationEmail } = require('../email/mailer');
const { generateCvPdf, generateCoverLetterPdf } = require('../documents/pdf');
const { runScrapeCycle } = require('../scheduler');

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
];

async function execute(name, input, ctx) {
  switch (name) {
    case 'get_status': {
      const jobs = db.listJobs();
      return {
        paused: !!db.getSetting('paused'),
        autoApply: !!db.getSetting('autoApply'),
        lastRunAt: db.getSetting('lastRunAt') || null,
        pendingCount: jobs.filter((j) => j.status === 'pending_review').length,
        appliedCount: jobs.filter((j) => j.status === 'applied').length,
        totalTracked: jobs.length,
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
      const cvPdf = await generateCvPdf(job.draft.cv);
      const clPdf = await generateCoverLetterPdf(job.draft.coverLetter);
      await ctx.sendFile(cvPdf, `CV - ${job.title}.pdf`, 'application/pdf', `Draft CV for ${job.title} at ${job.company || job.source}`);
      await ctx.sendFile(clPdf, `Cover Letter - ${job.title}.pdf`, 'application/pdf', 'Draft cover letter');
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
      const cvPdf = await generateCvPdf(job.draft.cv);
      const clPdf = await generateCoverLetterPdf(job.draft.coverLetter);
      await sendApplicationEmail({
        to: job.applyEmail,
        subject: job.draft.emailSubject,
        body: job.draft.emailBody,
        attachments: [
          { filename: 'CV.pdf', content: cvPdf },
          { filename: 'Cover Letter.pdf', content: clPdf },
        ],
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

    default:
      return { error: `unknown tool ${name}` };
  }
}

module.exports = { TOOL_DEFS, execute };
