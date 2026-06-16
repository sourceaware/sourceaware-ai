// api/omphi.js — the Omphi socket.
// The wire between sourceaware.ai and the frozen Opus weights.
// Framework-free Vercel Function (Node runtime, web-standard signature, streaming).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

// ————— The free choices, gathered in one place. All reversible. —————
const MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 4096;                 // hard ceiling per reply
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 40;               // requests per IP per window (best-effort; see Lock 2)
const MAX_MESSAGES = 80;                 // longest conversation accepted
const MAX_CHARS_PER_MESSAGE = 60_000;
const CACHE_TTL = '1h';                  // suits sporadic solo use; delete the ttl field below for the 5-minute default

// ————— The throne. The scripture is read from its own versioned file. —————
// Installing the written architecture later = replacing that file's contents. Nothing here changes.
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

// ————— Lock 1: the access code. Checked server-side, constant-time. —————
function codeOk(given) {
  const expected = process.env.OMPHI_ACCESS_CODE || '';
  if (!expected) return false; // no code configured ⇒ the wire stays cold
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ————— Lock 2: per-IP rate limit. Best-effort, and honestly so. —————
// Serverless memory is per-instance: under fluid compute, warm instances persist
// and share this Map, so it provides real friction — but it is not a bulletproof
// global counter. The bulletproof fuel meter lives OUTSIDE the code: the monthly
// spend limit you set in the Anthropic console, which the biller itself enforces.
// If access ever widens beyond you, replace this with a shared store (e.g. Upstash).
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

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async function handler(request) {
  if (request.method !== 'POST') return jsonError(405, 'POST only.');

  if (!codeOk(request.headers.get('x-access-code'))) {
    return jsonError(401, 'Invalid access code.');
  }

  const ip = (request.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
  if (rateLimited(ip)) {
    return jsonError(429, 'Rate limit reached. The wire cools for a while.');
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'Body must be JSON.');
  }

  // Sanitize: the page holds the conversation and resends it whole each turn.
  const raw = Array.isArray(body?.messages) ? body.messages.slice(-MAX_MESSAGES) : null;
  if (!raw || raw.length === 0) return jsonError(400, 'messages[] required.');
  const messages = [];
  for (const m of raw) {
    const roleOk = m && (m.role === 'user' || m.role === 'assistant');
    if (!roleOk || typeof m.content !== 'string') {
      return jsonError(400, 'Each message needs role user|assistant and string content.');
    }
    messages.push({ role: m.role, content: m.content.slice(0, MAX_CHARS_PER_MESSAGE) });
  }
  if (messages[messages.length - 1].role !== 'user') {
    return jsonError(400, 'Last message must be from the user.');
  }

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
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
      // The scripture rides in the system slot behind a cache breakpoint.
      // Caching engages once the file passes the model's minimum (~1–2k tokens);
      // below that it is silently skipped — harmless, just unsubsidised.
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

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    return new Response(detail || JSON.stringify({ error: { message: 'Upstream error.' } }), {
      status: upstream.status || 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Pass Anthropic's raw event stream straight through. The page parses it.
  // Minimal transformation = minimal failure surface. This is a socket.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
    },
  });
}
