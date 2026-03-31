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

// Read system prompt + context files on each request so edits take effect without restart
function buildSystemPrompt() {
  // Base instructions from system-prompt.txt
  let prompt = '';
  try {
    prompt = readFileSync(join(__dir, 'system-prompt.txt'), 'utf8').trim();
  } catch {
    prompt = 'You are a strategic futures provocateur for IDEO, working with Choice Hotels. Return exactly 2 questions as valid JSON: {"questions": ["...", "..."]}';
  }

  // Append any .txt / .md files from the context/ folder
  const contextDir = join(__dir, 'context');
  try {
    const files = readdirSync(contextDir).filter(f => ['.txt', '.md'].includes(extname(f).toLowerCase()) && f !== 'README.txt');
    for (const file of files) {
      const content = readFileSync(join(contextDir, file), 'utf8').trim();
      if (content) prompt += `\n\n--- CONTEXT: ${file} ---\n${content}`;
    }
  } catch { /* context folder missing or empty — fine */ }

  return prompt;
}

app.post('/api/generate', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on server' });

  const { category } = req.body;
  if (!category) return res.status(400).json({ error: 'category required' });

  const model  = process.env.MODEL || 'claude-sonnet-4-6';
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
});

const PORT = process.env.PORT || 3000;
createServer(app).listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
