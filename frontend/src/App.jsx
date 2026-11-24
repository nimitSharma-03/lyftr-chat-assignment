import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChatError, fetchHealth, newSessionId, sendChat } from './api.js';
import Markdown from './Markdown.jsx';
import {
  AlertIcon,
  ArrowUpIcon,
  BoltIcon,
  CheckIcon,
  CloseIcon,
  CopyIcon,
  DatabaseIcon,
  LogoMark,
  PlusIcon,
  RetryIcon,
  SlidersIcon,
} from './icons.jsx';

const MAX_CHARS = 4000;

const FAILURE_PRESETS = [
  { value: '', label: 'Off' },
  { value: 'key_1=429', label: 'key_1 returns 429 (rate limit)' },
  { value: 'key_1=500', label: 'key_1 returns 500 (server error)' },
  { value: 'key_1=503', label: 'key_1 returns 503 (unavailable)' },
  { value: '*=429', label: 'Every key returns 429' },
];

const STARTERS = [
  'What is the capital of France?',
  'Explain response caching in one short paragraph.',
  'Give me three tips for writing clean code.',
];

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
        <div className="msg-body">
          <Markdown text={message.content} />
        </div>
        <footer className="msg-meta" aria-label="Response details">
          <span className={`source ${cached ? 'source-cache' : 'source-live'}`} title="Resolution source">
            {cached ? <DatabaseIcon size={11} /> : <BoltIcon size={11} />}
            <span data-testid="meta-source">{m.resolution_source}</span>
          </span>
          <span className="meta-item" title="Model">
            <span data-testid="meta-model">{m.model}</span>
          </span>
          <span className="meta-item" title="Latency">
            <span data-testid="meta-latency">{m.latency_ms} ms</span>
          </span>
          <span className="meta-item" title="Input / output tokens for this request">
            <span data-testid="meta-input-tokens">{m.input_tokens}</span> in ·{' '}
            <span data-testid="meta-output-tokens">{m.output_tokens}</span> out
          </span>
          {m.fallback_attempts > 0 && (
            <span className="meta-item meta-warn" title="Keys that failed before this one answered">
              served by <span data-testid="meta-key-id">{m.key_id}</span> after{' '}
              <span data-testid="meta-fallback-attempts">{m.fallback_attempts}</span>{' '}
              {m.fallback_attempts === 1 ? 'failover' : 'failovers'}
            </span>
          )}
          <button
            type="button"
            className="icon-btn msg-copy"
            onClick={() => copy(message.content)}
            aria-label="Copy reply"
            title="Copy"
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
      <div className="msg-user-bubble" data-testid="user-message">
        {message.content}
      </div>
    </article>
  );
}

function ErrorMessage({ message, onRetry, disabled }) {
  return (
    <article className="msg msg-error" role="alert" data-testid="error-message">
      <AlertIcon size={16} className="error-icon" />
      <div className="error-main">
        <p className="error-text">
          <strong>{message.title}.</strong> {message.content}
        </p>
        {message.retry && (
          <button type="button" className="link-btn" onClick={() => onRetry(message)} disabled={disabled}>
            <RetryIcon size={13} />
            Try again
          </button>
        )}
      </div>
    </article>
  );
}

function Thinking() {
  return (
    <div className="msg msg-assistant" aria-live="polite" aria-label="Waiting for reply">
      <div className="msg-avatar" aria-hidden="true">
        <LogoMark size={26} />
      </div>
      <div className="typing">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ settings */

function SettingsDialog({ open, onClose, systemPrompt, setSystemPrompt, simulateFailure, setSimulateFailure }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <div className={`dialog-root ${open ? 'dialog-open' : ''}`} aria-hidden={!open}>
      <div className="dialog-scrim" onClick={onClose} />
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="dialog-head">
          <h2 id="settings-title">Chat settings</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings">
            <CloseIcon size={16} />
          </button>
        </header>

        <div className="dialog-body">
          <label className="field">
            <span className="field-label">Instructions</span>
            <span className="field-help">Tell the assistant how to respond in this conversation.</span>
            <textarea
              className="input textarea"
              data-testid="system-prompt-input"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="e.g. Keep answers under three sentences."
              rows={4}
              maxLength={MAX_CHARS}
              tabIndex={open ? 0 : -1}
            />
          </label>

          <label className="field">
            <span className="field-label">Simulate key failure</span>
            <span className="field-help">For testing failover. Applies to the next messages until turned off.</span>
            <select
              className="input"
              value={simulateFailure}
              onChange={(e) => setSimulateFailure(e.target.value)}
              data-testid="failover-select"
              tabIndex={open ? 0 : -1}
            >
              {FAILURE_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <footer className="dialog-foot">
          <button type="button" className="btn btn-primary" onClick={onClose} tabIndex={open ? 0 : -1}>
            Done
          </button>
        </footer>
      </div>
    </div>
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
    <div className={`composer ${over ? 'composer-over' : ''}`}>
      <textarea
        ref={inputRef}
        data-testid="chat-input"
        className="composer-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Message Lyftr…"
        rows={1}
        aria-label="Message"
        autoFocus
      />
      {over && <span className="composer-count">{`${length.toLocaleString()} / ${MAX_CHARS.toLocaleString()}`}</span>}
      <button
        type="button"
        className="send-btn"
        data-testid="send-button"
        onClick={onSend}
        disabled={pending || length === 0}
        aria-label="Send message"
        title="Send"
      >
        <ArrowUpIcon size={16} />
      </button>
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [online, setOnline] = useState(true);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  // Quietly wake the API (free hosting sleeps when idle) and only surface a
  // notice if it is not reachable.
  useEffect(() => {
    let cancelled = false;
    let timer;
    const check = async () => {
      let ok = false;
      try {
        ok = (await fetchHealth()).ok;
      } catch {
        ok = false;
      }
      if (cancelled) return;
      setOnline(ok);
      timer = setTimeout(check, ok ? 60000 : 5000);
    };
    check();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, pending]);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    inputRef.current?.focus();
  }, []);

  const submit = async (text) => {
    const trimmed = text.trim();
    if (!trimmed || pending) return;
    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: 'user', content: trimmed }]);
    setPending(true);
    try {
      const data = await sendChat({ sessionId, message: trimmed, systemPrompt, simulateFailure });
      setOnline(true);
      setMessages((prev) => [
        ...prev,
        { id: `a-${Date.now()}`, role: 'assistant', content: data.reply, metadata: data.metadata },
      ]);
    } catch (err) {
      const e = err instanceof ChatError ? err : new ChatError('Something went wrong', String(err?.message || err));
      setMessages((prev) => [
        ...prev,
        { id: `e-${Date.now()}`, role: 'error', title: e.title, content: e.message, retry: trimmed },
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
    inputRef.current?.focus();
  };

  const empty = messages.length === 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <LogoMark size={26} />
          <span className="brand-name">Lyftr</span>
        </div>
        <div className="topbar-actions">
          {simulateFailure && (
            <button type="button" className="pill-warn" onClick={() => setSettingsOpen(true)}>
              Failure test on
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            onClick={() => setSettingsOpen(true)}
            aria-label="Chat settings"
            title="Chat settings"
          >
            <SlidersIcon size={17} />
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onNewChat}
            disabled={empty && !pending}
            data-testid="new-chat-button"
          >
            <PlusIcon size={15} />
            New chat
          </button>
        </div>
      </header>

      <main className="scroll" ref={scrollRef}>
        <div className={`thread ${empty ? 'thread-empty' : ''}`}>
          {empty ? (
            <div className="welcome">
              <h1>What can I help with?</h1>
              <div className="starters">
                {STARTERS.map((s) => (
                  <button key={s} type="button" className="starter" onClick={() => submit(s)} disabled={pending}>
                    {s}
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
      </main>

      <div className="bottom">
        {!online && (
          <p className="notice">
            <span className="notice-dot" />
            Connecting to the server. This can take up to a minute after a period of inactivity.
          </p>
        )}
        <Composer value={input} onChange={setInput} onSend={onSend} pending={pending} inputRef={inputRef} />
        <p className="disclaimer">Replies can be inaccurate. Verify important information.</p>
      </div>

      <SettingsDialog
        open={settingsOpen}
        onClose={closeSettings}
        systemPrompt={systemPrompt}
        setSystemPrompt={setSystemPrompt}
        simulateFailure={simulateFailure}
        setSimulateFailure={setSimulateFailure}
      />
    </div>
  );
}
