const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { readFileSync, readdirSync } = require('fs');
const { join, extname } = require('path');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

function buildSystemPrompt() {
  let prompt = '';
  try {
    prompt = readFileSync(join(__dirname, 'system-prompt.txt'), 'utf8').trim();
  } catch {
    prompt = 'You are a strategic futures provocateur for IDEO, working with Choice Hotels.';
  }
  const contextDir = join(__dirname, 'context');
  try {
    const files = readdirSync(contextDir).filter(
      f => ['.txt', '.md'].includes(extname(f).toLowerCase()) && f !== 'README.txt'
    );
    for (const file of files) {
      const content = readFileSync(join(contextDir, file), 'utf8').trim();
      if (content) prompt += `\n\n--- CONTEXT: ${file} ---\n${content}`;
    }
  } catch { /* context folder missing */ }
  return prompt;
}

// Call Anthropic with retry on 529/503
async function callAnthropic(apiKey, body, attempt = 1) {
  const MAX_ATTEMPTS = 4;
  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if ((upstream.status === 529 || upstream.status === 503) && attempt < MAX_ATTEMPTS) {
    const delay = Math.pow(2, attempt) * 1000;
    console.log(`Overloaded (attempt ${attempt}), retrying in ${delay}ms...`);
    await new Promise(r => setTimeout(r, delay));
    return callAnthropic(apiKey, body, attempt + 1);
  }
  return upstream;
}

exports.api = onRequest(
  { secrets: [ANTHROPIC_API_KEY], cors: true, invoker: 'public', timeoutSeconds: 120 },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(404).json({ error: 'Not found' });

    const apiKey = ANTHROPIC_API_KEY.value();
    const model = 'claude-sonnet-4-6';
    const system = buildSystemPrompt();

    try {
      const upstream = await callAnthropic(apiKey, {
        model,
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: `Build a concept grounded in this macro signal: "${req.body.signal || 'Agentic AI Expansion'}". Start your response with "In a future where" and follow the output format exactly.` }]
      });

      if (!upstream.ok) {
        const err = await upstream.json();
        const msg = upstream.status === 529
          ? 'Claude is busy right now — please try again in a moment'
          : (err.error?.message || upstream.statusText);
        return res.status(upstream.status).json({ error: msg });
      }

      const data = await upstream.json();
      const text = data.content[0].text.trim().replace(/\*\*/g, '');
      res.json({ text });
    } catch (err) {
      console.error('Unexpected error:', err);
      res.status(500).json({ error: 'Something went wrong — please try again' });
    }
  }
);
