const RUNTIME = (typeof window !== 'undefined' && window.__APP_CONFIG__) || {};

export const API_BASE_URL = String(
  RUNTIME.API_URL || import.meta.env.VITE_API_URL || 'http://localhost:8000',
).replace(/\/+$/, '');

export function newSessionId() {
  let hex;
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    hex = crypto.randomUUID().replace(/-/g, '');
  } else {
    hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  }
  return `s-${hex.slice(0, 12)}`;
}

function describeError(status, body) {
  const detail = body && body.detail;
  if (status === 503) {
    return 'All providers are unavailable right now (every API key failed). Please try again in a moment.';
  }
  if (status === 422) {
    if (Array.isArray(detail)) {
      const msgs = detail.map((d) => d.msg || JSON.stringify(d)).join('; ');
      return `Invalid request: ${msgs}`;
    }
    return `Invalid request: ${typeof detail === 'string' ? detail : 'please check your input.'}`;
  }
  if (typeof detail === 'string') return `Error ${status}: ${detail}`;
  return `Unexpected error (HTTP ${status}). Please try again.`;
}

export async function sendChat({ sessionId, message, systemPrompt, simulateFailure }) {
  const payload = { session_id: sessionId, message };
  if (systemPrompt && systemPrompt.trim()) payload.system_prompt = systemPrompt.trim();

  const headers = { 'Content-Type': 'application/json' };
  if (simulateFailure && simulateFailure.trim()) headers['X-Simulate-Failure'] = simulateFailure.trim();

  let res;
  try {
    res = await fetch(`${API_BASE_URL}/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error(
      'Could not reach the server. It may be waking up from idle - please wait a few seconds and retry.',
    );
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) throw new Error(describeError(res.status, body));
  if (!body || typeof body.reply !== 'string') throw new Error('The server returned an unexpected response.');
  return body;
}

export async function fetchHealth() {
  const res = await fetch(`${API_BASE_URL}/health`);
  const body = await res.json().catch(() => null);
  return { ok: res.ok, body };
}
