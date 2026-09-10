const { createMessage, SMART_MODEL } = require('../ai/claude');
const tools = require('./tools');
const { loadProfileSummary } = require('../profile/loadProfile');

const SYSTEM_PROMPT_INTRO = `You are the personal job-search assistant running for this user in Zimbabwe, reachable over WhatsApp. You have tools to check status, list job matches you found, show/send a drafted CV and cover letter for a match, send an application email, reject a match, pause/resume scraping, toggle auto-apply, and trigger an immediate scrape. Always use a tool when the user is asking about real data (matches, status, drafts) or wants an action performed - never invent job details, scores, ids, or statuses yourself. Keep replies short, plain, and WhatsApp-appropriate (no markdown headers). If a job requires manual application (no direct email on file), be clear that you can't send it for them and share the link instead.`;

async function handleIncomingMessage(text, ctx) {
  const profileSummary = await loadProfileSummary().catch(() => '(profile not loaded)');
  const systemPrompt = `${SYSTEM_PROMPT_INTRO}\n\nCandidate background (context only, not for tool arguments):\n${profileSummary}`;

  const messages = [{ role: 'user', content: text }];

  for (let turn = 0; turn < 5; turn++) {
    const res = await createMessage({
      model: SMART_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      tools: tools.TOOL_DEFS,
      messages,
    });

    const toolUses = res.content.filter((b) => b.type === 'tool_use');
    const textReply = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

    if (toolUses.length === 0) {
      if (textReply) await ctx.sendMessage(textReply);
      return;
    }

    messages.push({ role: 'assistant', content: res.content });

    const toolResults = [];
    for (const tu of toolUses) {
      let result;
      try {
        result = await tools.execute(tu.name, tu.input, ctx);
      } catch (err) {
        result = { error: err.message };
      }
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
    }
    messages.push({ role: 'user', content: toolResults });

    if (res.stop_reason !== 'tool_use') {
      if (textReply) await ctx.sendMessage(textReply);
      return;
    }
  }

  await ctx.sendMessage("I've taken several steps on that but I'm not fully done - try asking again, or be more specific.");
}

module.exports = { handleIncomingMessage };
