'use client';

// hooks/useCopilotChat.ts - client state machine for the Limen Copilot conversation.
//
// Streams /api/agent/chat (SSE), folding events into: the message thread, the live tool-
// activity chips, and at most one pending action proposal awaiting the user's confirm/decline.
// Action results are reported back INTO the conversation as a user turn so the model can
// acknowledge honestly ("the app executed it - tx 0x…"), matching the route's stateless
// plain-text history contract. parseSseChunk is pure and unit-tested.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActionProposal } from '@/lib/agent/copilot';
import type { Payment402 } from '@/lib/agent/x402Client';

export interface CopilotMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Set for app-generated notes (autopilot log lines) - rendered as a timestamped feed. */
  at?: number;
}

export type CopilotEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; status: 'start' | 'done' }
  | { type: 'action'; action: ActionProposal }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** Fold a raw SSE text chunk into events + the unconsumed remainder. PURE. */
export function parseSseChunk(buffer: string): { events: CopilotEvent[]; rest: string } {
  const events: CopilotEvent[] = [];
  let rest = buffer;
  let idx: number;
  while ((idx = rest.indexOf('\n\n')) !== -1) {
    const frame = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    const line = frame.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    try {
      events.push(JSON.parse(line.slice(5).trim()) as CopilotEvent);
    } catch {
      // malformed frame - skip rather than kill the stream
    }
  }
  return { events, rest };
}

export type CopilotStatus = 'ready' | 'thinking' | 'offline' | 'error';

// The thread survives reloads (localStorage) so a conversation isn't lost to a refresh.
const THREAD_KEY = 'limen-copilot-thread-v1';
const MODEL_KEY = 'limen-copilot-model-v1';
const HISTORY_KEY = 'limen-copilot-history-v1';
const THREAD_CAP = 40;
const HISTORY_CAP = 10;

export interface ThreadArchive {
  id: string;
  title: string;
  at: number;
  messages: CopilotMessage[];
}

function loadHistory(): ThreadArchive[] {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(HISTORY_KEY) : null;
    const parsed = raw ? (JSON.parse(raw) as ThreadArchive[]) : [];
    return Array.isArray(parsed) ? parsed.slice(0, HISTORY_CAP) : [];
  } catch {
    return [];
  }
}

function saveHistory(list: ThreadArchive[]): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_CAP)));
  } catch {
    // best-effort
  }
}

/** Archive a thread (if it has real content) onto the front of the history list. */
function archiveThread(list: ThreadArchive[], messages: CopilotMessage[]): ThreadArchive[] {
  const meaningful = messages.filter((m) => !m.content.startsWith('**Autopilot**'));
  if (meaningful.length === 0) return list;
  const firstUser = messages.find((m) => m.role === 'user' && !m.content.startsWith('[Action result]'));
  const title = (firstUser?.content ?? 'Conversation').slice(0, 64);
  return [{ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title, at: Date.now(), messages }, ...list].slice(0, HISTORY_CAP);
}

function loadThread(): CopilotMessage[] {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(THREAD_KEY) : null;
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CopilotMessage[];
    return Array.isArray(parsed)
      ? parsed
          .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .map((m) => ({ role: m.role, content: m.content, ...(typeof m.at === 'number' ? { at: m.at } : {}) }))
          .slice(-THREAD_CAP)
      : [];
  } catch {
    return [];
  }
}

function saveThread(messages: CopilotMessage[]): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(THREAD_KEY, JSON.stringify(messages.slice(-THREAD_CAP)));
  } catch {
    // storage full/blocked - persistence is best-effort
  }
}

export function useCopilotChat(ctx: { address?: string; marketId: string; sessionAddress?: string; pastSessionAddresses?: string[] }) {
  const [messages, setMessages] = useState<CopilotMessage[]>(loadThread);
  const [status, setStatus] = useState<CopilotStatus>('ready');
  const [activity, setActivity] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<ActionProposal | null>(null);
  const [paymentRequired, setPaymentRequired] = useState<Payment402 | null>(null);
  const [model, setModelState] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [billing, setBilling] = useState<{ enabled: boolean; priceUsdc6?: string } | null>(null);
  const [history, setHistory] = useState<ThreadArchive[]>(loadHistory);
  const inFlight = useRef(false);
  // The history whose request got a 402 - retried verbatim once the user pays.
  const unpaidHistory = useRef<CopilotMessage[] | null>(null);

  // The status card: configured? which model? Sets the honest offline state up front.
  useEffect(() => {
    let alive = true;
    void fetch('/api/agent/chat')
      .then((r) => (r.ok ? r.json() : null))
      .then((info: { configured?: boolean; model?: string | null; models?: string[]; x402?: { enabled: boolean; priceUsdc6?: string } } | null) => {
        if (!alive || !info) return;
        const list = info.models ?? [];
        setModels(list);
        // Restore the user's model choice when it is still on the server's list.
        let saved: string | null = null;
        try {
          saved = typeof window !== 'undefined' ? window.localStorage.getItem(MODEL_KEY) : null;
        } catch {
          // storage blocked
        }
        setModelState(saved !== null && list.includes(saved) ? saved : (info.model ?? null));
        setBilling(info.x402 ?? null);
        if (info.configured === false) setStatus('offline');
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const run = useCallback(
    async (history: CopilotMessage[], opts: { paymentHeader?: string } = {}) => {
      inFlight.current = true;
      setStatus('thinking');
      setActivity(null);
      // A fresh exchange supersedes any unconfirmed proposal from the previous one.
      setPendingAction(null);
      setPaymentRequired(null);
      let assistantStarted = false;
      try {
        const res = await fetch('/api/agent/chat', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(opts.paymentHeader !== undefined ? { 'payment-signature': opts.paymentHeader } : {}),
          },
          body: JSON.stringify({
            messages: history,
            address: ctx.address,
            marketId: ctx.marketId,
            sessionAddress: ctx.sessionAddress,
            pastSessionAddresses: ctx.pastSessionAddresses,
            model: model ?? undefined,
          }),
        });
        if (res.status === 503) {
          setStatus('offline');
          return;
        }
        if (res.status === 429) {
          setStatus('ready');
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', content: 'You have reached today\'s free message limit - it resets tomorrow. (Usage-based payment via Circle x402 is on the roadmap.)' },
          ]);
          return;
        }
        if (res.status === 401) {
          setStatus('ready');
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', content: 'Connect your wallet first - the copilot works with your positions, claims, and balances, so a connected wallet is required to chat.' },
          ]);
          return;
        }
        if (res.status === 402) {
          // Payment required (free quota exhausted): surface the pay card instead of text.
          const body402 = (await res.json().catch(() => null)) as Payment402 | null;
          unpaidHistory.current = history;
          setPaymentRequired(body402 ?? {});
          setStatus('ready');
          return;
        }
        if (!res.ok || res.body === null) throw new Error(`copilot request failed (${res.status})`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const { events, rest } = parseSseChunk(buf);
          buf = rest;
          for (const ev of events) {
            if (ev.type === 'text') {
              setActivity(null);
              if (!assistantStarted) {
                assistantStarted = true;
                setMessages((prev) => [...prev, { role: 'assistant', content: ev.delta }]);
              } else {
                setMessages((prev) => {
                  const out = [...prev];
                  const last = out[out.length - 1];
                  if (last && last.role === 'assistant') out[out.length - 1] = { ...last, content: last.content + ev.delta };
                  return out;
                });
              }
            } else if (ev.type === 'tool') {
              setActivity(ev.status === 'start' ? ev.name : null);
              // A follow-up model turn after tool results streams into a fresh bubble.
              if (ev.status === 'done') assistantStarted = false;
            } else if (ev.type === 'action') {
              setPendingAction(ev.action);
            } else if (ev.type === 'error') {
              setMessages((prev) => [...prev, { role: 'assistant', content: `Something went wrong on my side: ${ev.message}` }]);
            }
          }
        }
        setStatus('ready');
      } catch (err) {
        setStatus('error');
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `I could not reach the copilot service (${err instanceof Error ? err.message : 'network error'}). Try again in a moment.` },
        ]);
      } finally {
        setActivity(null);
        inFlight.current = false;
      }
    },
    [ctx.address, ctx.marketId, ctx.sessionAddress, ctx.pastSessionAddresses, model],
  );

  /** Pick a model from the server's allowlist; persists across sessions. */
  const setModel = useCallback((m: string) => {
    setModelState(m);
    try {
      if (typeof window !== 'undefined') window.localStorage.setItem(MODEL_KEY, m);
    } catch {
      // best-effort
    }
  }, []);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed === '' || inFlight.current) return;
      const next: CopilotMessage[] = [...messages, { role: 'user', content: trimmed }];
      setMessages(next);
      void run(next);
    },
    [messages, run],
  );

  /** Report a confirmed/declined/failed action back into the conversation. */
  const reportActionResult = useCallback(
    (summary: string) => {
      setPendingAction(null);
      const next: CopilotMessage[] = [...messages, { role: 'user', content: summary }];
      setMessages(next);
      void run(next);
    },
    [messages, run],
  );

  const dismissAction = useCallback(() => setPendingAction(null), []);

  /** Retry the 402'd request with a signed Payment-Signature header (from the pay card). */
  const retryWithPayment = useCallback(
    (paymentHeader: string) => {
      const history = unpaidHistory.current;
      if (history === null || inFlight.current) return;
      unpaidHistory.current = null;
      setPaymentRequired(null);
      void run(history, { paymentHeader });
    },
    [run],
  );

  const dismissPayment = useCallback(() => {
    unpaidHistory.current = null;
    setPaymentRequired(null);
  }, []);

  /** Append an app-generated note to the thread WITHOUT a model round-trip (autopilot etc.). */
  const appendLocalNote = useCallback((text: string) => {
    setMessages((prev) => [...prev, { role: 'assistant', content: text, at: Date.now() }]);
  }, []);

  /** Clear the conversation - the outgoing thread is archived into History first. */
  const clearThread = useCallback(() => {
    if (inFlight.current) return;
    setMessages((prev) => {
      setHistory((h) => {
        const next = archiveThread(h, prev);
        saveHistory(next);
        return next;
      });
      return [];
    });
    setPendingAction(null);
    setActivity(null);
    try {
      if (typeof window !== 'undefined') window.localStorage.removeItem(THREAD_KEY);
    } catch {
      // best-effort
    }
  }, []);

  /** Bring an archived conversation back (the current one is archived in its place). */
  const restoreThread = useCallback((id: string) => {
    if (inFlight.current) return;
    setHistory((h) => {
      const target = h.find((t) => t.id === id);
      if (target === undefined) return h;
      let next = h.filter((t) => t.id !== id);
      setMessages((prev) => {
        next = archiveThread(next, prev);
        return target.messages;
      });
      saveHistory(next);
      return next;
    });
    setPendingAction(null);
  }, []);

  // Persist after every thread change (streaming included - cheap, bounded by THREAD_CAP).
  useEffect(() => {
    saveThread(messages);
  }, [messages]);

  return {
    messages,
    status,
    activity,
    pendingAction,
    paymentRequired,
    model,
    models,
    setModel,
    billing,
    send,
    reportActionResult,
    dismissAction,
    retryWithPayment,
    dismissPayment,
    appendLocalNote,
    clearThread,
    history,
    restoreThread,
  };
}
