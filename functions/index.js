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

// Call Anthropic with automatic retry on 529 Overloaded
async function callAnthropic(apiKey, body, attempt = 1) {
  const MAX_ATTEMPTS = 4;
  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  // Retry on 529 (Overloaded) or 503 (Service Unavailable) with exponential backoff
  if ((upstream.status === 529 || upstream.status === 503) && attempt < MAX_ATTEMPTS) {
    const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
    console.log(`Anthropic overloaded (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${delay}ms...`);
    await new Promise(r => setTimeout(r, delay));
    return callAnthropic(apiKey, body, attempt + 1);
  }

  return upstream;
}

exports.api = onRequest(
  { secrets: [ANTHROPIC_API_KEY], cors: true, invoker: 'public', timeoutSeconds: 120 },
  async (req, res) => {
    // Only allow POST requests
    if (req.method !== 'POST') {
      return res.status(404).json({ error: 'Not found' });
    }

    const apiKey = ANTHROPIC_API_KEY.value();
    const { category } = req.body;
    if (!category) return res.status(400).json({ error: 'category required' });

    const model = 'claude-sonnet-4-6';
    const system = buildSystemPrompt();

    try {
      const upstream = await callAnthropic(apiKey, {
        model,
        max_tokens: 1024,
        system,
        messages: [{
          role: 'user',
          content: `Generate one concept for the ${category} signal from the STEEP futures framework. Follow the output format and rules exactly.`
        }]
      });

      if (!upstream.ok) {
        const err = await upstream.json();
        const msg = upstream.status === 529
          ? 'Claude is busy right now — please try again in a moment'
          : (err.error?.message || upstream.statusText);
        return res.status(upstream.status).json({ error: msg });
      }

      const data = await upstream.json();
      res.json({ text: data.content[0].text });
    } catch (err) {
      console.error('Unexpected error:', err);
      res.status(500).json({ error: 'Something went wrong — please try again' });
    }
  }
);
