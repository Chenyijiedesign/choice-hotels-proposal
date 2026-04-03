import express from 'express';
import { createServer } from 'http';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';

// Load .env file directly — overrides any empty shell vars
try {
  const envFile = readFileSync(new URL('.env', import.meta.url), 'utf8');
  for (const line of envFile.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
} catch { /* .env not found — rely on real env vars */ }

const __dir = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(__dir));

function buildSystemPrompt() {
  let prompt = '';
  try {
    prompt = readFileSync(join(__dir, 'system-prompt.txt'), 'utf8').trim();
  } catch {
    prompt = 'You are a strategic futures provocateur for IDEO, working with Choice Hotels.';
  }
  const contextDir = join(__dir, 'context');
  try {
    const files = readdirSync(contextDir).filter(f => ['.txt', '.md'].includes(extname(f).toLowerCase()) && f !== 'README.txt');
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
    console.log(`Overloaded (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${delay}ms...`);
    await new Promise(r => setTimeout(r, delay));
    return callAnthropic(apiKey, body, attempt + 1);
  }
  return upstream;
}

app.post('/api/generate', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on server' });

  const model  = process.env.MODEL || 'claude-sonnet-4-6';
  const system = buildSystemPrompt();
  const signal = req.body.signal || 'Agentic AI Expansion';
  console.log(`[generate] signal → "${signal}"`);

  try {
    const upstream = await callAnthropic(apiKey, {
      model,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: `Build a concept grounded in this macro signal: "${signal}". Start your response with "In a future where" and follow the output format exactly.` }]
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
});

const PORT = process.env.PORT || 3000;
createServer(app).listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
