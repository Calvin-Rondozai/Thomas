const { generateContent, SMART_MODEL } = require('../ai/gemini');
const tools = require('./tools');
const { loadProfileSummary } = require('../profile/loadProfile');

const SYSTEM_PROMPT_INTRO = `Your name is HELLO C. You are the personal job-search assistant running for this user in Zimbabwe, reachable over WhatsApp - when asked who you are or greeted, introduce yourself as HELLO C. You have tools to check status, get a recent-activity summary, list job matches you found, show/send a drafted CV and cover letter for a match, send an application email, reject a match, pause/resume scraping, toggle auto-apply, trigger an immediate scrape, and evaluate/draft an application for one specific job the user sends you (a URL or pasted job description). Always use a tool when the user is asking about real data (matches, status, a summary, drafts) or wants an action performed - never invent job details, scores, ids, or statuses yourself. When asked for a "summary" of what you've been doing, use the get_summary tool. Whenever the user sends a job posting link or pastes job description text (whether or not it came from the automatic scraper), use the submit_job tool to draft a CV/cover letter for it and send the PDFs - then wait for the user to say "apply" before sending anything to an employer. Keep replies short, plain, and WhatsApp-appropriate (no markdown headers). If a job requires manual application (no direct email on file), be clear that you can't send it for them and share the link instead. The user can send you a single PDF of their certificates directly in this chat - that gets saved automatically (not a tool call) and attached alongside every future CV/cover letter, so if asked about certificates just point them to sending the PDF directly.`;

// Gemini's function-calling schema is close enough to the Anthropic-shaped TOOL_DEFS
// in tools.js that it's just a field rename, not a rewrite.
const FUNCTION_DECLARATIONS = tools.TOOL_DEFS.map((t) => ({
  name: t.name,
  description: t.description,
  parametersJsonSchema: t.input_schema,
}));

async function handleIncomingMessage(text, ctx) {
  const profileSummary = await loadProfileSummary().catch(() => '(profile not loaded)');
  const systemPrompt = `${SYSTEM_PROMPT_INTRO}\n\nCandidate background (context only, not for tool arguments):\n${profileSummary}`;

  const contents = [{ role: 'user', parts: [{ text }] }];

  for (let turn = 0; turn < 5; turn++) {
    const res = await generateContent({
      model: SMART_MODEL,
      contents,
      config: {
        systemInstruction: systemPrompt,
        tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
        maxOutputTokens: 1024,
      },
    });

    const functionCalls = res.functionCalls || [];
    const textReply = (res.text || '').trim();

    if (functionCalls.length === 0) {
      if (textReply) await ctx.sendMessage(textReply);
      return;
    }

    // Record the model's own turn verbatim (not a hand-rebuilt one) - newer Gemini
    // models attach a required `thoughtSignature` to function-call parts, and only
    // the original response content carries it back correctly on the next turn.
    contents.push(res.candidates[0].content);

    const responseParts = [];
    for (const fc of functionCalls) {
      let result;
      try {
        result = await tools.execute(fc.name, fc.args || {}, ctx);
      } catch (err) {
        result = { error: err.message };
      }
      responseParts.push({ functionResponse: { id: fc.id, name: fc.name, response: result } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  await ctx.sendMessage("I've taken several steps on that but I'm not fully done - try asking again, or be more specific.");
}

module.exports = { handleIncomingMessage };
