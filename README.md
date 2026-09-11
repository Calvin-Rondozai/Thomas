# Thomas Job Hunter

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

Runs as a single Node.js process. This setup targets **$0/month**: Render's free Web
Service tier, Upstash's free Redis tier, and Gemini's free API tier, with Gmail API
(OAuth) for sending so it works despite Render blocking outbound SMTP.

## How the pieces fit together

```
Render Web Service (free tier)
├─ http server on $PORT - satisfies Render's health check + an external keep-alive pinger
├─ WhatsApp (Baileys, unofficial/free) - your two-way chat interface
├─ node-cron loop - scrapes every SCRAPE_INTERVAL_MINUTES
│   ├─ scrapers/*.js - cheerio scraping of each job board
│   ├─ ai/gemini.js - cheap pre-filter, then detailed score + CV/cover letter/email draft (rotates across pooled API keys)
│   └─ notifier.js - pushes updates out to WhatsApp
├─ documents/pdf.js - renders the drafted CV/cover letter to PDF
├─ email/mailer.js - sends the application via the Gmail API (HTTPS, not SMTP)
└─ db.js + whatsapp/redisAuthState.js - job database + WhatsApp login, both persisted
   in Upstash Redis (Render's free tier wipes local disk on every restart)
```

## Important things to know before you rely on this

- **This is not a magic auto-apply button by default.** New matches are drafted and
  you are notified on WhatsApp; nothing is emailed to an employer until you reply
  "apply id-here" (or you turn on auto-apply by saying "auto apply on").
- **Not every posting can be auto-applied to.** Some sites route applications through
  their own portal/account system rather than a plain email address. When no email
  address is found on the job's detail page, the bot marks it "manual apply" and just
  gives you the link - it does not attempt to log in to or submit through third-party
  application portals.
- **The WhatsApp integration is unofficial** (it logs in as a real WhatsApp account via
  the Baileys library, the same way WhatsApp Web works, not Meta's official Business
  API). This is free and gives full two-way chat, but carries a small, low but
  non-zero risk of that number being flagged for automated use. Use a spare/secondary
  number for the bot, not your main one (see setup below).
- **AI-written CVs and cover letters can still be imperfect.** Review a draft
  ("show cv id-here") before sending, especially for jobs you care about.
- **A free Render Web Service sleeps after 15 minutes with no HTTP traffic.** An
  external pinger (step 5 below) hits it every ~10-14 minutes so it never sleeps -
  without that, WhatsApp messages/scrapes would only happen when something happens to
  wake it up.
- **Gemini's free tier is genuinely limited** - in testing, the strongest free model
  had only ~20 requests/day per Google Cloud project (pooling several API keys only
  helps if they're on *separate* projects/accounts). The bot defaults to
  gemini-flash-lite-latest for everything, which has much more free headroom; quality
  is still good, but if you later add billing you can bump SMART_MODEL in
  src/ai/gemini.js for better writing.
- **zimbajob.com is intentionally not scraped** - its robots.txt explicitly disallows
  AI crawlers, including Claude's. All other sources' robots.txt were checked and
  allow crawling their listing pages.
- Site HTML structures change over time. If a scraper's result count drops to 0 for a
  source, that source's page layout has probably changed and its selectors in
  src/scrapers/ will need a small update.

## Prerequisites (all free, no card required for any of them)

- Node.js 18+ (only needed for local testing - Render provides it in production).
- A **Gemini API key**: https://aistudio.google.com/apikey.
- A **Google Cloud project with the Gmail API enabled and an OAuth client**, so the
  bot can send as your real Gmail address over HTTPS (Render's free tier blocks the
  ports plain SMTP needs). Full steps in section 2 below.
- An **Upstash Redis database** (free): https://console.upstash.com/ - this is where
  the WhatsApp session and job history are stored, since Render's free tier has no
  persistent disk.
- A **second, dedicated phone number** for the bot's own WhatsApp account (a spare
  SIM, dual-SIM slot, or similar). The bot logs into WhatsApp as this number; you chat
  with it from your own personal number, like messaging any contact. This is required
  because a normal account cannot cleanly message itself and be told apart from your
  own outgoing messages.
- A **Render account**: https://render.com (free Web Service, no card).
- A free **uptime pinger** (e.g. https://uptimerobot.com or https://cron-job.org) to
  keep the free Render service awake.

## 1. Fill in your profile and CV style

Two files under `data/` drive everything the AI writes. They are already git-ignored
so your personal details never get committed:

- `data/profile.md` - your real facts: contact info, experience, education, skills,
  certifications, job preferences. This is the only source of truth for what the AI
  is allowed to say about you.
- `data/cv_template.md` - the layout, section order, and tone you want your generated
  CVs to follow (not fed as facts, just style).

Generic starting points are provided at `data/profile.example.md` and
`data/cv_template.example.md` - copy and edit those for a fresh profile.

## 2. Set up Gmail sending (Gmail API + OAuth)

Render's free tier blocks outbound SMTP ports, so plain Gmail SMTP (an "App Password")
does not work there. Instead, the bot sends through the Gmail API over HTTPS, which
does work, and still sends as your real Gmail address.

1. Go to https://console.cloud.google.com/ and create a new project.
2. **APIs & Services → Library** → search "Gmail API" → **Enable**.
3. **APIs & Services → OAuth consent screen**: User type **External**. Fill in app
   name, your email as support/developer contact. Save.
4. Under **Scopes**, add `https://www.googleapis.com/auth/gmail.send`.
5. Under **Test users**, add your own Gmail address.
6. **APIs & Services → Credentials → Create Credentials → OAuth client ID** →
   Application type **Desktop app** → name it anything → **Create**. Note the
   **Client ID** and **Client Secret** shown.
7. Locally, put those two values in your `.env` as `GMAIL_CLIENT_ID` and
   `GMAIL_CLIENT_SECRET`, then run:
   ```
   npm install
   node scripts/get-gmail-token.js
   ```
   Follow its instructions (open a URL, sign in, click through the "unverified app"
   warning - expected for a personal project - copy a code back into the terminal). It
   prints a `GMAIL_REFRESH_TOKEN` - add that to your `.env` too.
8. **Important:** go back to the OAuth consent screen page and click **Publish App**
   to move it from "Testing" to "In production". Skip this and Google expires the
   refresh token after 7 days; publishing (without needing Google's full verification
   review, which is only required to remove the "unverified" warning for *other*
   users) makes it valid indefinitely for your own account.

## 3. Set up Upstash Redis

1. Go to https://console.upstash.com/ → sign up (no card) → **Create Database** →
   any name, choose a region close to your Render region.
2. On the database's page, copy the **REST URL** and **REST Token** - these become
   `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.

## 4. Local setup (to test before deploying)

```
npm install
copy .env.example .env
```

Fill in `.env` with everything from steps 1-3 above plus your Gemini key and
`WHATSAPP_OWNER_NUMBER` (your personal number, digits only, no `+`). Then:

```
npm start
```

A QR code prints in the terminal. Open WhatsApp on the **bot's phone** (the spare
number) → Settings → Linked Devices → Link a Device → scan it. The session is saved to
Upstash, so redeploys and restarts will not require re-scanning.

Once connected, message the bot from your own personal number: try "status".

## 5. Deploy to Render (free)

This repo includes a `render.yaml` blueprint.

1. Push this repo to GitHub.
2. In Render: **New → Blueprint** → pick this repo. Render reads `render.yaml` and
   creates a **Web Service** on the **Free** plan.
3. Fill in the environment variables it prompts for: `GEMINI_API_KEYS`, `EMAIL_USER`,
   `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`,
   `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `WHATSAPP_OWNER_NUMBER`.
4. Base64-encode your profile and CV template (they get rewritten from these on every
   boot, since local disk is ephemeral here):

   Windows PowerShell:
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("data\profile.md"))
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("data\cv_template.md"))
   ```
   macOS/Linux:
   ```bash
   base64 -i data/profile.md | tr -d '\n'
   base64 -i data/cv_template.md | tr -d '\n'
   ```
   Paste the results into `PROFILE_MD_BASE64` and `CV_TEMPLATE_MD_BASE64`.
5. Deploy. Watch the **Logs** tab - once it boots, a QR code prints. Scan it from the
   bot's WhatsApp (you only need to do this once - the session persists in Upstash
   after that, surviving restarts/redeploys).
6. Note the `.onrender.com` URL Render assigns the service.
7. **Set up the keep-alive pinger** so the free service never sleeps: in
   UptimeRobot or cron-job.org (both free, no card), create a new monitor that hits
   your service's URL every 10-14 minutes. That's it - as long as it's pinged, the
   free instance stays awake continuously.

From then on it runs continuously for $0/month, provided the pinger keeps running.

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
| EMAIL_USER | your real Gmail address (the "From") | required |
| GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN | Gmail API OAuth (see section 2) | required |
| UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN | persistent storage (see section 3) | required |
| WHATSAPP_OWNER_NUMBER | your personal number, digits only, no plus sign | required |
| SCRAPE_INTERVAL_MINUTES | how often to scrape all sources | 60 |
| MATCH_THRESHOLD | minimum score, 0 to 10, to draft a full application | 7 |
| MAX_PAGES_PER_SOURCE | listing pages fetched per source per run | 2 |
| SCRAPER_USER_AGENT | identifies the bot to job sites | generic |
| PORT | keep-alive HTTP server port | 3000 (Render sets this itself) |

## Costs

$0/month at this bot's typical volume: Render free Web Service, Upstash free Redis,
Gemini free API tier, Gmail API, Baileys WhatsApp, and a free uptime pinger. The only
way this stops being free is if you outgrow a free tier's limits (e.g. Gemini quota)
and choose to add billing yourself.

## Extending it

- Add another job site: create `src/scrapers/newsite.js` exporting `fetchListings()`
  in the same shape as the existing ones, then register it in `src/scrapers/index.js`.
- Everything the bot can do lives in `src/whatsapp/tools.js` as a small list of named
  tools - add a new one there and describe it in `TOOL_DEFS` to give the chat
  assistant a new capability.

## License

Apache License 2.0 - see LICENSE.
