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

exports.api = onRequest(
  { secrets: [ANTHROPIC_API_KEY], cors: true, invoker: 'public' },
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
      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system,
          messages: [{
            role: 'user',
            content: `Generate one concept for the ${category} signal from the STEEP futures framework. Follow the output format and rules exactly.`
          }]
        })
      });

      if (!upstream.ok) {
        const err = await upstream.json();
        return res.status(upstream.status).json({ error: err.error?.message || upstream.statusText });
      }

      const data = await upstream.json();
      res.json({ text: data.content[0].text });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);
