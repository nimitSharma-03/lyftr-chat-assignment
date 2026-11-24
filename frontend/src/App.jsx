import React, { useEffect, useRef, useState } from 'react';
import { API_BASE_URL, fetchHealth, newSessionId, sendChat } from './api.js';
import Markdown from './Markdown.jsx';

const FAILURE_PRESETS = [
  { value: '', label: 'Off' },
  { value: 'key_1=429', label: 'key_1 → 429' },
  { value: 'key_1=500', label: 'key_1 → 500' },
  { value: 'key_1=429,key_2=503', label: 'key_1 → 429, key_2 → 503' },
  { value: '*=429', label: 'All keys → 429' },
];

function AssistantMessage({ message }) {
  const m = message.metadata || {};
  const cached = m.resolution_source === 'LLM_CACHE';
  return (
    <div className="row row-assistant">
      <div className="avatar" aria-hidden="true">
        L
      </div>
      <div className="bubble bubble-assistant" data-testid="assistant-message">
        <div className="reply">
          <Markdown text={message.content} />
        </div>
        <div className="meta" aria-label="Request metadata">
          <span className={`chip ${cached ? 'chip-cache' : 'chip-live'}`} title="Resolution source">
            <span data-testid="meta-source">{m.resolution_source}</span>
          </span>
          <span className="chip" title="Model">
            <span className="chip-label">model</span>
            <span data-testid="meta-model">{m.model}</span>
          </span>
          <span className="chip" title="Server-measured latency">
            <span className="chip-label">latency</span>
            <span data-testid="meta-latency">{m.latency_ms} ms</span>
          </span>
          <span className="chip" title="Input (prompt) tokens for this request">
            <span className="chip-label">in</span>
            <span data-testid="meta-input-tokens">{m.input_tokens}</span>
          </span>
          <span className="chip" title="Output (completion) tokens for this reply">
            <span className="chip-label">out</span>
            <span data-testid="meta-output-tokens">{m.output_tokens}</span>
          </span>
          <span className="chip" title="Key that answered (null on cache hits)">
            <span className="chip-label">key</span>
            <span data-testid="meta-key-id">{m.key_id ?? 'null'}</span>
          </span>
          <span
            className={`chip ${m.fallback_attempts > 0 ? 'chip-warn' : ''}`}
            title="Keys that failed before this one succeeded"
          >
            <span className="chip-label">fallbacks</span>
            <span data-testid="meta-fallback-attempts">{m.fallback_attempts}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function UserMessage({ message }) {
  return (
    <div className="row row-user">
      <div className="bubble bubble-user" data-testid="user-message">
        {message.content}
      </div>
    </div>
  );
}

function ErrorMessage({ message, onRetry, disabled }) {
  return (
    <div className="row row-assistant">
      <div className="avatar avatar-error" aria-hidden="true">
        !
      </div>
      <div className="bubble bubble-error" role="alert" data-testid="error-message">
        <span>{message.content}</span>
        {message.retry && (
          <button type="button" className="link-btn" onClick={() => onRetry(message)} disabled={disabled}>
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [sessionId, setSessionId] = useState(() => newSessionId());
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [simulateFailure, setSimulateFailure] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [pending, setPending] = useState(false);
  const [health, setHealth] = useState({ state: 'checking' });
  const listRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const { ok, body } = await fetchHealth();
        if (!cancelled) setHealth({ state: ok ? 'ok' : 'degraded', body });
      } catch {
        if (!cancelled) setHealth({ state: 'down' });
      }
    };
    check();
    const id = setInterval(check, 30000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  const submit = async (text) => {
    const trimmed = text.trim();
    if (!trimmed || pending) return;
    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: 'user', content: trimmed }]);
    setPending(true);
    try {
      const data = await sendChat({ sessionId, message: trimmed, systemPrompt, simulateFailure });
      setMessages((prev) => [
        ...prev,
        { id: `a-${Date.now()}`, role: 'assistant', content: data.reply, metadata: data.metadata },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { id: `e-${Date.now()}`, role: 'error', content: err.message, retry: trimmed },
      ]);
    } finally {
      setPending(false);
      inputRef.current?.focus();
    }
  };

  const onSend = () => {
    const text = input;
    if (!text.trim() || pending) return;
    setInput('');
    submit(text);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSend();
    }
  };

  const onRetry = (msg) => {
    // Failed turns are not stored server-side, so re-sending is safe.
    // Drop the error bubble and the user turn that produced it, then send again.
    setMessages((prev) => {
      const errIdx = prev.findIndex((m) => m.id === msg.id);
      if (errIdx === -1) return prev;
      const drop = new Set([errIdx]);
      if (errIdx > 0 && prev[errIdx - 1].role === 'user') drop.add(errIdx - 1);
      return prev.filter((_, i) => !drop.has(i));
    });
    submit(msg.retry);
  };

  const onNewChat = () => {
    setSessionId(newSessionId());
    setMessages([]);
    setInput('');
    inputRef.current?.focus();
  };

  const healthLabel =
    health.state === 'ok'
      ? `Online · ${health.body?.keys_configured ?? 0} keys · cache ${health.body?.cache_enabled ? 'on' : 'off'}`
      : health.state === 'checking'
        ? 'Connecting…'
        : health.state === 'degraded'
          ? 'Degraded'
          : 'Backend unreachable';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            L
          </span>
          <div>
            <h1>Lyftr Chat</h1>
            <p className="subtitle">Multi-key failover · response caching · per-request tokens</p>
          </div>
        </div>
        <div className="topbar-actions">
          <span className={`status status-${health.state}`} title={API_BASE_URL}>
            <span className="dot" />
            {healthLabel}
          </span>
          <button type="button" className="btn btn-ghost" onClick={() => setShowSettings((s) => !s)}>
            {showSettings ? 'Hide settings' : 'Settings'}
          </button>
          <button type="button" className="btn" onClick={onNewChat} data-testid="new-chat-button">
            New chat
          </button>
        </div>
      </header>

      {showSettings && (
        <section className="settings" aria-label="Session settings">
          <label className="field">
            <span className="field-label">System prompt (optional, applies to this session)</span>
            <textarea
              data-testid="system-prompt-input"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="e.g. You are a concise travel assistant. Answer in two sentences."
              rows={3}
              maxLength={4000}
            />
          </label>
          <label className="field field-inline">
            <span className="field-label">Failover test (X-Simulate-Failure, next requests only)</span>
            <select value={simulateFailure} onChange={(e) => setSimulateFailure(e.target.value)}>
              {FAILURE_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </section>
      )}

      <main className="chat" ref={listRef}>
        <div className="session-line">
          Session <code>{sessionId}</code>
          {simulateFailure && <span className="sim-badge">simulating: {simulateFailure}</span>}
        </div>

        {messages.length === 0 && (
          <div className="empty">
            <h2>Start a conversation</h2>
            <p>
              Every reply shows where it came from (<code>LIVE_INFERENCE</code> or <code>LLM_CACHE</code>), the
              model, latency and the input/output tokens of that request.
            </p>
            <div className="suggestions">
              {['What is the capital of France?', 'Explain caching in one paragraph.', 'Give me 3 tips for writing clean code.'].map(
                (s) => (
                  <button key={s} type="button" className="suggestion" onClick={() => submit(s)} disabled={pending}>
                    {s}
                  </button>
                ),
              )}
            </div>
          </div>
        )}

        {messages.map((m) => {
          if (m.role === 'user') return <UserMessage key={m.id} message={m} />;
          if (m.role === 'assistant') return <AssistantMessage key={m.id} message={m} />;
          return <ErrorMessage key={m.id} message={m} onRetry={onRetry} disabled={pending} />;
        })}

        {pending && (
          <div className="row row-assistant" aria-live="polite">
            <div className="avatar" aria-hidden="true">
              L
            </div>
            <div className="bubble bubble-assistant typing">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
      </main>

      <footer className="composer">
        <textarea
          ref={inputRef}
          data-testid="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type a message… (Enter to send, Shift+Enter for a new line)"
          rows={1}
          autoFocus
        />
        <button
          type="button"
          className="btn btn-send"
          data-testid="send-button"
          onClick={onSend}
          disabled={pending || !input.trim()}
        >
          {pending ? 'Sending…' : 'Send'}
        </button>
      </footer>
    </div>
  );
}
