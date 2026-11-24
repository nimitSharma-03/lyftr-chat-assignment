import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { API_BASE_URL, ChatError, fetchHealth, newSessionId, sendChat } from './api.js';
import Markdown from './Markdown.jsx';
import {
  AlertIcon,
  ArrowUpIcon,
  BoltIcon,
  CheckIcon,
  ChipIcon,
  ClockIcon,
  CloseIcon,
  CopyIcon,
  DatabaseIcon,
  KeyIcon,
  LogoMark,
  MenuIcon,
  PlusIcon,
  RetryIcon,
  TokensIcon,
} from './icons.jsx';

const MAX_CHARS = 4000;

const FAILURE_PRESETS = [
  { value: '', label: 'Off', hint: 'Requests use the key pool normally.' },
  { value: 'key_1=429', label: 'key_1 → 429', hint: 'key_1 is rate-limited; expect key_2 to answer.' },
  { value: 'key_1=500', label: 'key_1 → 500', hint: 'key_1 returns a server error; expect key_2.' },
  { value: 'key_1=503', label: 'key_1 → 503', hint: 'key_1 is unavailable; expect key_2.' },
  { value: '*=429', label: 'All keys → 429', hint: 'Every key fails; expect a 503 and nothing stored.' },
];

const STARTERS = [
  { title: 'Quick fact', prompt: 'What is the capital of France?' },
  { title: 'Explain a concept', prompt: 'Explain response caching for LLM APIs in one short paragraph.' },
  { title: 'Draft something', prompt: 'Write a two-line status update saying the deployment finished successfully.' },
];

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable */
    }
  }, []);
  return [copied, copy];
}

/* ------------------------------------------------------------------ messages */

function MetaItem({ icon: IconCmp, label, children, className = '' }) {
  return (
    <span className={`meta-item ${className}`} title={label}>
      {IconCmp && <IconCmp size={13} />}
      {children}
    </span>
  );
}

function AssistantMessage({ message }) {
  const m = message.metadata || {};
  const cached = m.resolution_source === 'LLM_CACHE';
  const [copied, copy] = useCopy();

  return (
    <article className="msg msg-assistant" data-testid="assistant-message">
      <div className="msg-avatar" aria-hidden="true">
        <LogoMark size={26} />
      </div>
      <div className="msg-main">
        <header className="msg-head">
          <span className="msg-author">Assistant</span>
          <time className="msg-time">{timeFmt.format(message.at)}</time>
        </header>
        <div className="msg-body">
          <Markdown text={message.content} />
        </div>
        <footer className="msg-meta" aria-label="Response details">
          <span className={`source ${cached ? 'source-cache' : 'source-live'}`} title="Resolution source">
            {cached ? <DatabaseIcon size={12} /> : <BoltIcon size={12} />}
            <span data-testid="meta-source">{m.resolution_source}</span>
          </span>
          <MetaItem icon={ChipIcon} label="Model">
            <span data-testid="meta-model">{m.model}</span>
          </MetaItem>
          <MetaItem icon={ClockIcon} label="Server-measured latency">
            <span data-testid="meta-latency">{m.latency_ms} ms</span>
          </MetaItem>
          <MetaItem icon={TokensIcon} label="Tokens for this request (input / output)">
            <span data-testid="meta-input-tokens">{m.input_tokens}</span>
            <span className="meta-unit">in</span>
            <span className="meta-sep">/</span>
            <span data-testid="meta-output-tokens">{m.output_tokens}</span>
            <span className="meta-unit">out</span>
          </MetaItem>
          <MetaItem
            icon={KeyIcon}
            label="Key that answered (null when served from cache)"
            className={m.fallback_attempts > 0 ? 'meta-warn' : ''}
          >
            <span data-testid="meta-key-id">{m.key_id ?? 'null'}</span>
            {m.fallback_attempts > 0 && (
              <span className="meta-fallback">
                after <span data-testid="meta-fallback-attempts">{m.fallback_attempts}</span>{' '}
                {m.fallback_attempts === 1 ? 'failover' : 'failovers'}
              </span>
            )}
          </MetaItem>
          <button
            type="button"
            className="icon-btn msg-copy"
            onClick={() => copy(message.content)}
            aria-label="Copy reply"
            title="Copy reply"
          >
            {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          </button>
        </footer>
      </div>
    </article>
  );
}

function UserMessage({ message }) {
  return (
    <article className="msg msg-user">
      <div className="msg-user-inner">
        <div className="msg-user-bubble" data-testid="user-message">
          {message.content}
        </div>
        <time className="msg-time">{timeFmt.format(message.at)}</time>
      </div>
    </article>
  );
}

function ErrorMessage({ message, onRetry, disabled }) {
  return (
    <article className="msg msg-error" role="alert" data-testid="error-message">
      <div className="error-icon" aria-hidden="true">
        <AlertIcon size={16} />
      </div>
      <div className="error-main">
        <div className="error-title">
          {message.title}
          {message.status && <span className="error-code">HTTP {message.status}</span>}
        </div>
        <p className="error-text">{message.content}</p>
        {message.retry && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onRetry(message)} disabled={disabled}>
            <RetryIcon size={13} />
            Retry
          </button>
        )}
      </div>
    </article>
  );
}

function Thinking() {
  return (
    <div className="msg msg-assistant msg-pending" aria-live="polite" aria-label="Waiting for reply">
      <div className="msg-avatar" aria-hidden="true">
        <LogoMark size={26} />
      </div>
      <div className="msg-main">
        <header className="msg-head">
          <span className="msg-author">Assistant</span>
        </header>
        <div className="skeleton">
          <span />
          <span />
          <span />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- sidebar */

function StatusPanel({ health }) {
  const body = health.body || {};
  const keys = Array.isArray(body.keys) ? body.keys : [];
  const label =
    health.state === 'ok'
      ? 'Operational'
      : health.state === 'checking'
        ? 'Connecting'
        : health.state === 'degraded'
          ? 'Degraded'
          : 'Unreachable';

  return (
    <section className="side-section">
      <h3 className="side-title">System</h3>
      <div className={`status-row status-${health.state}`}>
        <span className="status-dot" />
        <span className="status-label">API {label}</span>
      </div>
      {health.state === 'ok' && (
        <dl className="kv">
          <div>
            <dt>Response cache</dt>
            <dd>{body.cache_enabled ? 'Enabled' : 'Disabled'}</dd>
          </div>
          <div>
            <dt>Keys configured</dt>
            <dd>{body.keys_configured}</dd>
          </div>
          {keys.map((k) => (
            <div key={k.key_id}>
              <dt className="mono">{k.key_id}</dt>
              <dd className={k.cooling_down ? 'text-warn' : 'text-ok'}>{k.cooling_down ? 'Cooling down' : 'Healthy'}</dd>
            </div>
          ))}
        </dl>
      )}
      {(health.state === 'down' || health.state === 'degraded') && (
        <p className="side-help">The API may be waking up after inactivity. This panel refreshes every 30 seconds.</p>
      )}
    </section>
  );
}

function Sidebar({
  open,
  onClose,
  sessionId,
  turnCount,
  onNewChat,
  systemPrompt,
  setSystemPrompt,
  simulateFailure,
  setSimulateFailure,
  health,
}) {
  const [copied, copy] = useCopy();
  const preset = FAILURE_PRESETS.find((p) => p.value === simulateFailure) || FAILURE_PRESETS[0];

  return (
    <>
      <div className={`scrim ${open ? 'scrim-open' : ''}`} onClick={onClose} aria-hidden="true" />
      <aside className={`sidebar ${open ? 'sidebar-open' : ''}`} aria-label="Conversation settings">
        <div className="side-brand">
          <LogoMark size={26} />
          <span className="brand-name">Lyftr</span>
          <span className="brand-product">Chat</span>
          <button type="button" className="icon-btn side-close" onClick={onClose} aria-label="Close panel">
            <CloseIcon size={16} />
          </button>
        </div>

        <button type="button" className="btn btn-primary btn-block" onClick={onNewChat} data-testid="new-chat-button">
          <PlusIcon size={15} />
          New conversation
        </button>

        <div className="side-scroll">
          <section className="side-section">
            <h3 className="side-title">Session</h3>
            <div className="session-id">
              <code>{sessionId}</code>
              <button
                type="button"
                className="icon-btn"
                onClick={() => copy(sessionId)}
                aria-label="Copy session id"
                title="Copy session id"
              >
                {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
              </button>
            </div>
            <p className="side-help">
              {turnCount === 0
                ? 'No messages yet. History is stored on the server per session.'
                : `${turnCount} ${turnCount === 1 ? 'exchange' : 'exchanges'} in this session.`}
            </p>
          </section>

          <section className="side-section">
            <label className="side-title" htmlFor="system-prompt">
              System prompt
            </label>
            <textarea
              id="system-prompt"
              className="input textarea"
              data-testid="system-prompt-input"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="Optional. e.g. Answer as a concise travel assistant."
              rows={4}
              maxLength={MAX_CHARS}
            />
            <p className="side-help">Overrides the default instructions for this session from the next message on.</p>
          </section>

          <section className="side-section">
            <label className="side-title" htmlFor="failover">
              Failover test
            </label>
            <select
              id="failover"
              className="input"
              value={simulateFailure}
              onChange={(e) => setSimulateFailure(e.target.value)}
            >
              {FAILURE_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            <p className="side-help">
              {preset.hint}
              {preset.value && (
                <>
                  {' '}
                  Sent as <code>X-Simulate-Failure</code>.
                </>
              )}
            </p>
          </section>

          <StatusPanel health={health} />
        </div>

        <footer className="side-footer" title={API_BASE_URL}>
          <span className="mono truncate">{API_BASE_URL.replace(/^https?:\/\//, '')}</span>
        </footer>
      </aside>
    </>
  );
}

/* ------------------------------------------------------------------ composer */

function Composer({ value, onChange, onSend, pending, inputRef }) {
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value, inputRef]);

  const length = value.trim().length;
  const over = length > MAX_CHARS;

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div className="composer-wrap">
      <div className={`composer ${over ? 'composer-over' : ''}`}>
        <textarea
          ref={inputRef}
          data-testid="chat-input"
          className="composer-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message the assistant…"
          rows={1}
          aria-label="Message"
          autoFocus
        />
        <div className="composer-bar">
          <span className="composer-hint">
            <kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line
          </span>
          <span className={`composer-count ${over ? 'text-danger' : ''}`}>
            {length > 0 && `${length.toLocaleString()} / ${MAX_CHARS.toLocaleString()}`}
          </span>
          <button
            type="button"
            className="send-btn"
            data-testid="send-button"
            onClick={onSend}
            disabled={pending || length === 0}
            aria-label="Send message"
            title="Send message"
          >
            <ArrowUpIcon size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------- app */

export default function App() {
  const [sessionId, setSessionId] = useState(() => newSessionId());
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [simulateFailure, setSimulateFailure] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [health, setHealth] = useState({ state: 'checking' });
  const scrollRef = useRef(null);
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
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, pending]);

  const submit = async (text) => {
    const trimmed = text.trim();
    if (!trimmed || pending) return;
    const now = new Date();
    setMessages((prev) => [...prev, { id: `u-${now.getTime()}`, role: 'user', content: trimmed, at: now }]);
    setPending(true);
    try {
      const data = await sendChat({ sessionId, message: trimmed, systemPrompt, simulateFailure });
      const at = new Date();
      setMessages((prev) => [
        ...prev,
        { id: `a-${at.getTime()}`, role: 'assistant', content: data.reply, metadata: data.metadata, at },
      ]);
    } catch (err) {
      const e = err instanceof ChatError ? err : new ChatError('Request failed', String(err?.message || err));
      setMessages((prev) => [
        ...prev,
        { id: `e-${Date.now()}`, role: 'error', title: e.title, status: e.status, content: e.message, retry: trimmed },
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

  const onRetry = (msg) => {
    // Failed turns are never stored server-side, so re-sending is safe.
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
    setSidebarOpen(false);
    inputRef.current?.focus();
  };

  const firstUser = messages.find((m) => m.role === 'user');
  const title = firstUser ? firstUser.content : 'New conversation';
  const turnCount = messages.filter((m) => m.role === 'assistant').length;
  const model = health.body?.keys?.[0]?.model;

  return (
    <div className="shell">
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        sessionId={sessionId}
        turnCount={turnCount}
        onNewChat={onNewChat}
        systemPrompt={systemPrompt}
        setSystemPrompt={setSystemPrompt}
        simulateFailure={simulateFailure}
        setSimulateFailure={setSimulateFailure}
        health={health}
      />

      <main className="main">
        <header className="topbar">
          <button
            type="button"
            className="icon-btn topbar-menu"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open settings panel"
          >
            <MenuIcon size={18} />
          </button>
          <h1 className="topbar-title truncate" title={title}>
            {title}
          </h1>
          <div className="topbar-right">
            {simulateFailure && (
              <span className="tag tag-warn" title="X-Simulate-Failure is active">
                Failover test: <span className="mono">{simulateFailure}</span>
              </span>
            )}
            {model && (
              <span className="tag" title="Model of the first key in the pool">
                <ChipIcon size={12} />
                <span className="mono">{model}</span>
              </span>
            )}
          </div>
        </header>

        <div className="scroll" ref={scrollRef}>
          <div className="thread">
            {messages.length === 0 ? (
              <div className="welcome">
                <LogoMark size={40} />
                <h2>How can I help today?</h2>
                <p>
                  Ask anything. Each reply shows whether it came from the model or the cache, which key served it,
                  latency, and token usage for that request.
                </p>
                <div className="starters">
                  {STARTERS.map((s) => (
                    <button
                      key={s.title}
                      type="button"
                      className="starter"
                      onClick={() => submit(s.prompt)}
                      disabled={pending}
                    >
                      <span className="starter-title">{s.title}</span>
                      <span className="starter-text">{s.prompt}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m) => {
                if (m.role === 'user') return <UserMessage key={m.id} message={m} />;
                if (m.role === 'assistant') return <AssistantMessage key={m.id} message={m} />;
                return <ErrorMessage key={m.id} message={m} onRetry={onRetry} disabled={pending} />;
              })
            )}
            {pending && <Thinking />}
          </div>
        </div>

        <Composer value={input} onChange={setInput} onSend={onSend} pending={pending} inputRef={inputRef} />
        <p className="disclaimer">Replies can be inaccurate. Verify important information.</p>
      </main>
    </div>
  );
}
