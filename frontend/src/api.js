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

export class ChatError extends Error {
  constructor(title, message, status = null) {
    super(message);
    this.title = title;
    this.status = status;
  }
}

function toChatError(status, body) {
  const detail = body && body.detail;
  if (status === 503) {
    return new ChatError(
      'All providers unavailable',
      'Every API key in the pool failed for this request. Nothing was saved to the conversation, so it is safe to retry.',
      status,
    );
  }
  if (status === 422) {
    let msg = 'Please check your input.';
    if (Array.isArray(detail)) {
      msg = detail
        .map((d) => String(d.msg || '').replace(/^Value error, /, ''))
        .filter(Boolean)
        .join('; ');
    } else if (typeof detail === 'string') {
      msg = detail;
    }
    msg = msg.charAt(0).toUpperCase() + msg.slice(1);
    return new ChatError('Request rejected', msg, status);
  }
  if (typeof detail === 'string') return new ChatError('Request failed', detail, status);
  return new ChatError('Request failed', 'The server returned an unexpected error. Please try again.', status);
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
    throw new ChatError(
      'Server unreachable',
      'Could not connect to the API. If it was idle it may take up to a minute to wake up. Please retry shortly.',
    );
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) throw toChatError(res.status, body);
  if (!body || typeof body.reply !== 'string') {
    throw new ChatError('Unexpected response', 'The server returned a response in an unknown format.');
  }
  return body;
}

export async function fetchHealth() {
  const res = await fetch(`${API_BASE_URL}/health`);
  const body = await res.json().catch(() => null);
  return { ok: res.ok, body };
}
