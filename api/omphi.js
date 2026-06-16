// api/omphi.js — the Omphi socket (Vercel Node runtime, classic req/res style).
// The wire between sourceaware.ai and the frozen Opus weights.

import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ————— The free choices, gathered in one place. All reversible. —————
const MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 4096;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 40;
const MAX_MESSAGES = 80;
const MAX_CHARS_PER_MESSAGE = 60_000;
const CACHE_TTL = '1h';
const EFFORT = 'max';        // low | medium | high | xhigh | max — 'max' = deepest reasoning
const THINKING_ON = true;    // adaptive thinking: at max effort the model almost always thinks

// ————— The throne. Scripture read from its own versioned file. —————
let scriptureText = null;
function scripture() {
  if (scriptureText !== null) return scriptureText;
  try {
    scriptureText = readFileSync(join(process.cwd(), 'scripture', 'omphi.system.md'), 'utf8');
  } catch {
    scriptureText =
      'You are Omphi, the intelligence surface of SourceAware. ' +
      'The written architecture has not yet been installed.';
  }
  return scriptureText;
}

// ————— Lock 1: the access code. Constant-time. —————
function codeOk(given) {
  const expected = process.env.OMPHI_ACCESS_CODE || '';
  if (!expected) return false;
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ————— Lock 2: per-IP rate limit. Best-effort (per warm instance). —————
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

// Read the raw request body from the Node stream, then JSON-parse it.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 8_000_000) reject(new Error('Body too large.')); // ~8MB guard
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'POST only.' } });
    return;
  }

  // Headers are a plain object on the Node runtime; keys are lower-cased.
  if (!codeOk(req.headers['x-access-code'])) {
    res.status(401).json({ error: { message: 'Invalid access code.' } });
    return;
  }

  const fwd = req.headers['x-forwarded-for'] || 'unknown';
  const ip = String(fwd).split(',')[0].trim();
  if (rateLimited(ip)) {
    res.status(429).json({ error: { message: 'Rate limit reached. The wire cools for a while.' } });
    return;
  }

  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    res.status(400).json({ error: { message: 'Body must be JSON.' } });
    return;
  }

  const incoming = Array.isArray(body?.messages) ? body.messages.slice(-MAX_MESSAGES) : null;
  if (!incoming || incoming.length === 0) {
    res.status(400).json({ error: { message: 'messages[] required.' } });
    return;
  }
  const messages = [];
  for (const m of incoming) {
    const roleOk = m && (m.role === 'user' || m.role === 'assistant');
    if (!roleOk || typeof m.content !== 'string') {
      res.status(400).json({ error: { message: 'Each message needs role user|assistant and string content.' } });
      return;
    }
    messages.push({ role: m.role, content: m.content.slice(0, MAX_CHARS_PER_MESSAGE) });
  }
  if (messages[messages.length - 1].role !== 'user') {
    res.status(400).json({ error: { message: 'Last message must be from the user.' } });
    return;
  }

  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        stream: true,
        // Max effort + adaptive thinking: the deepest reasoning Opus 4.8 allows.
        // (Opus 4.8 rejects fixed thinking budgets; adaptive is the supported form.)
        ...(THINKING_ON ? { thinking: { type: 'adaptive' } } : {}),
        output_config: { effort: EFFORT },
        system: [
          {
            type: 'text',
            text: scripture(),
            cache_control: { type: 'ephemeral', ttl: CACHE_TTL },
          },
        ],
        messages,
      }),
    });
  } catch (e) {
    res.status(502).json({ error: { message: 'Could not reach the model: ' + (e?.message || 'network error') } });
    return;
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    res.status(upstream.status || 502);
    res.setHeader('Content-Type', 'application/json');
    res.end(detail || JSON.stringify({ error: { message: 'Upstream error.' } }));
    return;
  }

  // Stream Anthropic's raw event stream straight through to the browser.
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');

  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch {
    // client disconnected or stream broke; nothing more to do
  } finally {
    res.end();
  }
}
