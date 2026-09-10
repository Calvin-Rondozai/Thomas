# Zim Job Bot

A personal job-search assistant that:
1. Scrapes Zimbabwean job boards (VacancyMail, JobsZimbabwe, iHarare Jobs, ApplyNOW).
2. Scores each posting against your profile using Gemini, and drops anything that
   does not fit.
3. Drafts a tailored CV, cover letter, and application email for good matches (never
   inventing facts beyond what is in your profile).
4. Messages you on WhatsApp with what it found.
5. Waits for your approval, then emails the application - or you can turn on
   auto-apply.
6. Lets you talk to it on WhatsApp ("status", "show cv 12", "apply 12", "pause",
   "scrape now"...) and it runs the matching action for you.

Runs as a single Node.js process, deployed on Render as an always-on background
worker.

## How the pieces fit together

```
Render Background Worker (always-on, persistent disk at /data)
├─ WhatsApp (Baileys, unofficial/free) - your two-way chat interface
├─ node-cron loop - scrapes every SCRAPE_INTERVAL_MINUTES
│   ├─ scrapers/*.js - cheerio scraping of each job board
│   ├─ ai/gemini.js - cheap pre-filter, then detailed score + CV/cover letter/email draft (rotates across pooled API keys)
│   └─ notifier.js - pushes updates out to WhatsApp
├─ documents/pdf.js - renders the drafted CV/cover letter to PDF
├─ email/mailer.js - sends the application (Gmail SMTP)
└─ db.js - flat JSON file tracking every job seen/matched/applied
```

## Important things to know before you rely on this

- This is not a magic auto-apply button by default. New matches are drafted and you
  are notified on WhatsApp; nothing is emailed to an employer until you reply
  "apply id-here" (or you turn on auto-apply by saying "auto apply on").
- Not every posting can be auto-applied to. Some sites route applications through
  their own portal/account system rather than a plain email address. When no email
  address is found on the job's detail page, the bot marks it "manual apply" and just
  gives you the link - it does not attempt to log in to or submit through third-party
  application portals.
- The WhatsApp integration is unofficial (it logs in as a real WhatsApp account via
  the Baileys library, the same way WhatsApp Web works, not Meta's official Business
  API). This is free and gives full two-way chat, but carries a small, low but
  non-zero risk of that number being flagged for automated use. Use a spare/secondary
  number for the bot, not your main one (see setup below).
- AI-written CVs and cover letters can still be imperfect. Review a draft
  ("show cv id-here") before sending, especially for jobs you care about.
- zimbajob.com is intentionally not scraped - its robots.txt explicitly disallows AI
  crawlers, including Claude's. All other sources' robots.txt were checked and allow
  crawling their listing pages.
- Site HTML structures change over time. If a scraper's result count drops to 0 for a
  source, that source's page layout has probably changed and its selectors in
  src/scrapers/ will need a small update.

## Prerequisites

- Node.js 18+ (only needed for local testing - Render provides it in production).
- A Gemini API key from https://aistudio.google.com/apikey (this is separate from a
  Gemini/Google One consumer subscription - it is its own pay-as-you-go API billing,
  though it has a usable free tier). You can list more than one key in
  GEMINI_API_KEYS (comma-separated) - the bot automatically rotates to the next key
  when one hits its quota, and only messages you on WhatsApp once every key in the
  list is exhausted, including an estimate of when the quota resets.
- A Gmail account with an App Password (Google Account, Security, 2-Step
  Verification, App Passwords) - this is what the bot sends applications from.
- A second, dedicated phone number for the bot's own WhatsApp account (a spare SIM,
  dual-SIM slot, or similar). The bot logs into WhatsApp as this number. You then chat
  with it from your own personal WhatsApp number, like messaging any contact. This is
  required because a normal account cannot cleanly message itself and be told apart
  from your own outgoing messages.
- A Render account (https://render.com) for hosting, plus a card on file for the
  Starter plan (about $7/month) plus a small persistent disk (about $1/month for
  1GB). This is the only tier that (a) never sleeps and (b) can keep a persistent
  disk, both of which "runs non-stop" requires.

## 1. Fill in your profile and CV style

Two files under data/ drive everything the AI writes. They are already git-ignored so
your personal details never get committed:

- data/profile.md - your real facts: contact info, experience, education, skills,
  certifications, job preferences. This is the only source of truth for what the AI
  is allowed to say about you.
- data/cv_template.md - the layout, section order, and tone you want your generated
  CVs to follow (not fed as facts, just style).

Generic starting points are provided at data/profile.example.md and
data/cv_template.example.md - copy and edit those for a fresh profile. These two real
files have already been filled in from the CV you shared
(Calvin_Rondozai_TNCyberTech_ICT_Graduate_Trainee.docx), including a "Target roles /
job preferences" section - open data/profile.md and adjust it any time (specific
companies to avoid, salary floor, more locations, and so on). You can also just tell
the bot your new preferences over WhatsApp, though editing the file directly is what
actually changes matching.

## 2. Local setup (to test before deploying)

```
npm install
copy .env.example .env
```

Then edit .env with your real values, and run:

```
npm start
```

On first run, a QR code prints in the terminal. Open WhatsApp on the bot's phone (the
spare number), go to Settings, Linked Devices, Link a Device, and scan it. The session
is then saved under data/wa_auth/ so you will not need to scan again unless you log
the device out.

Once connected, message the bot from your own personal number (the one you put in
WHATSAPP_OWNER_NUMBER): try "status".

## 3. Deploy to Render (always-on)

This repo includes a render.yaml blueprint.

1. Push this repo to GitHub (a private repo is recommended, since even with data/*.md
   git-ignored you may not want the rest public - your call).
2. In Render: New, then Blueprint, then pick this repo. Render reads render.yaml and
   creates a Background Worker on the Starter plan with a 1GB persistent disk mounted
   at /data.
3. Fill in the environment variables it asks for (marked sync: false in render.yaml):
   GEMINI_API_KEYS, EMAIL_USER, EMAIL_APP_PASSWORD, WHATSAPP_OWNER_NUMBER.
4. Base64-encode your profile and CV template so Render can write them onto the
   persistent disk on first boot, instead of committing them to git:

   macOS/Linux:
   ```
   base64 -i data/profile.md | tr -d '\n'
   base64 -i data/cv_template.md | tr -d '\n'
   ```

   Windows PowerShell:
   ```
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("data\profile.md"))
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("data\cv_template.md"))
   ```

   Paste the results into the PROFILE_MD_BASE64 and CV_TEMPLATE_MD_BASE64 env vars in
   Render. These are only read once - if the file already exists on the disk, they
   are ignored, so to update your profile later either edit the env var and delete
   /data/profile.md via Render's Shell tab, or just edit the file directly with
   Render's Shell.
5. Deploy. Watch the Logs tab for the QR code on first boot, and scan it from the
   bot's WhatsApp within a couple of minutes (it keeps reprinting on reconnect
   attempts if you miss it, or you can just trigger a manual redeploy for a fresh
   one).
6. From then on it just runs. Render's Starter plan does not spin down, and the
   persistent disk keeps the WhatsApp session and job database across restarts and
   redeploys.

## Talking to the bot on WhatsApp

Once running, message it in plain English from your personal number, for example:

- "status" - are you paused, is auto-apply on, how many pending matches
- "matches" or "what have you found" - lists jobs awaiting your review
- "show cv 4f2a91" or "show the draft for 4f2a91" - sends the CV and cover letter PDFs
- "apply 4f2a91" - sends that application email now
- "reject 4f2a91" or "not interested in 4f2a91" - dismisses it
- "pause" or "resume" - stop or start the scraping loop
- "scrape now" or "check now" - run an immediate cycle instead of waiting
- "turn auto apply on" or "turn auto apply off"

It is a real Gemini conversation with tools behind it, not a fixed command list, so
phrasing does not have to be exact.

## Configuration (env vars)

| Variable | Purpose | Default |
|---|---|---|
| GEMINI_API_KEYS | Gemini API key(s), comma-separated | required |
| EMAIL_SERVICE / EMAIL_USER / EMAIL_APP_PASSWORD | sends applications | required |
| WHATSAPP_OWNER_NUMBER | your personal number, digits only, no plus sign | required |
| SCRAPE_INTERVAL_MINUTES | how often to scrape all sources | 60 |
| MATCH_THRESHOLD | minimum score, 0 to 10, to draft a full application | 7 |
| MAX_PAGES_PER_SOURCE | listing pages fetched per source per run | 2 |
| SCRAPER_USER_AGENT | identifies the bot to job sites | generic |

## Costs (realistic estimate)

- Render Starter worker plus 1GB disk: about $8/month.
- Gemini API: pay-per-use, scales with how many new postings show up and how many get
  fully drafted; the cheap pre-filter step in front of the expensive drafting step
  keeps this low, and pooling a few free-tier keys in GEMINI_API_KEYS can cover most
  or all of typical usage at this bot's volume.
- WhatsApp (Baileys) and Gmail SMTP: free.

## Extending it

- Add another job site: create src/scrapers/newsite.js exporting fetchListings() in
  the same shape as the existing ones, then register it in src/scrapers/index.js.
- Everything the bot can do lives in src/whatsapp/tools.js as a small list of named
  tools - add a new one there and describe it in TOOL_DEFS to give the chat assistant
  a new capability.

## License

Apache License 2.0 - see LICENSE.
