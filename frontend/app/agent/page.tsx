'use client';

// app/agent/page.tsx - the Limen Copilot: a conversational agent with live protocol access.
//
// Two-panel HUD: an identity rail (who the agent is, which model runs it, what it can do,
// the live context it operates in) and the conversation itself. The copilot reads the LIVE
// chain and oracle through tools before answering, and acts only through confirmation cards
// the user's own wallet signs - never silently. Brain: /api/agent/chat (docs/AGENT.md).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount, usePublicClient } from 'wagmi';
import { useActiveMarket } from '@/components/MarketProvider';
import { MarketSelector } from '@/components/MarketSelector';
import { TokenGlyph } from '@/components/TokenGlyph';
import { MARKETS, type Market } from '@/lib/markets';
import { formatUnits, type AbiEvent } from 'viem';
import { feeArenaV3Abi } from '@/abis/feeArenaV3';
import { getEventLogsChunked } from '@/lib/events';
import { useCopilotChat } from '@/hooks/useCopilotChat';
import { useAutopilot } from '@/hooks/useAutopilot';
import { useSessionAgent, recentSessionAddresses, marketsWithSessions } from '@/hooks/useSessionAgent';
import { useKeepAwake } from '@/hooks/useKeepAwake';
import { ActionCard } from '@/components/agent/ActionCard';
import { ModelPicker } from '@/components/agent/ModelPicker';
import { PayCard } from '@/components/agent/PayCard';
import { Markdown } from '@/components/agent/Markdown';
import { Logo } from '@/components/ui/icons';
import { BrandMark } from '@/components/ui/BrandMark';
import { cn } from '@/lib/cn';
import type { ActionProposal } from '@/lib/agent/copilot';
import type { StanceView } from '@/lib/agent/autopilot';
import { DEFAULT_MANDATE, MANDATE_STORAGE_KEY, parseMandate, buildUnattendedConfig, type AgentMandate } from '@/lib/agent/mandate';
import { quoteToken, tokenBySymbol } from '@/lib/tokens';
import { bandLabel, isFullRangeTicks } from '@/lib/rangeDisplay';
import { ARC_CHAIN_ID } from '@/lib/chain';

const AUTOPILOT_KEY = 'limen-autopilot-v1';
const ALL_VIEWS: StanceView[] = ['UP', 'DOWN', 'RANGE'];
// The History record is rebuilt from event logs (the only per-epoch truth - position
// records are overwritten on restake). A bounded lookback keeps the popover snappy.
const RESULTS_LOOKBACK_BLOCKS = 250_000n;
function v3Event(name: string): AbiEvent {
  const item = (feeArenaV3Abi as readonly { type: string; name?: string }[]).find((e) => e.type === 'event' && e.name === name);
  if (!item) throw new Error(`FeeArenaV3 ABI missing event ${name}`);
  return item as AbiEvent;
}
const STAKED_EVENT = v3Event('Staked');
const POSITION_PROCESSED_EVENT = v3Event('PositionProcessed');
const VIEW_CHIP: Record<StanceView, string> = {
  UP: 'border-side-up/50 text-side-up',
  DOWN: 'border-side-down/50 text-side-down',
  RANGE: 'border-side-range/50 text-side-range',
};

/** Stable identity for a proposal - remounts the ActionCard when the SUBSTANCE changes. */
function actionKey(a: ActionProposal): string {
  return [a.type, a.side ?? '', a.amountUsdc ?? '', a.priceLower ?? '', a.priceUpper ?? '', (a.tokenIds ?? []).join('.'), a.marketId].join('|');
}

/** An ActionCard outcome, rephrased for the thread (autopilot notes never hit the model). */
function autopilotOutcome(summary: string): string {
  return `**Autopilot** - ${summary
    .replace(/^\[Action result\]\s*/, '')
    .replace(/\s*Acknowledge briefly.*$/i, '')
    .replace(/\s*Explain briefly.*$/i, '')
    .trim()}`;
}

/** The session LP's band, formatted for the console + feed notes ("63,800 - 66,400 USDC"). */
function describeLpRange(
  range: { tickLower: number; tickUpper: number; poolTick: number; baseIsToken0: boolean },
  baseDecimals: number,
  quoteDecimals: number,
  quoteSymbol: string,
): { label: string; full: boolean; inRange: boolean } {
  const full = isFullRangeTicks(range.tickLower, range.tickUpper, 60);
  const dec0 = range.baseIsToken0 ? baseDecimals : quoteDecimals;
  const dec1 = range.baseIsToken0 ? quoteDecimals : baseDecimals;
  return {
    full,
    label: full ? 'Full range' : `${bandLabel(range.tickLower, range.tickUpper, dec0, dec1, range.baseIsToken0)} ${quoteSymbol}`,
    inRange: range.poolTick >= range.tickLower && range.poolTick < range.tickUpper,
  };
}

/** Console state presentation: title + tone for the big status line and pill. */
const STATE_META: Record<string, { title: string; tone: 'idle' | 'live' | 'act' | 'warn' }> = {
  off: { title: 'Stopped', tone: 'idle' },
  paused: { title: 'Paused', tone: 'idle' },
  watching: { title: 'Running - watching', tone: 'live' },
  evaluating: { title: 'Running - evaluating odds', tone: 'live' },
  waiting: { title: 'Running - epoch locked', tone: 'live' },
  entering: { title: 'Entering epoch', tone: 'act' },
  claiming: { title: 'Collecting fee share', tone: 'act' },
  retrying: { title: 'Recovering', tone: 'warn' },
};
const TONE_DOT: Record<string, string> = {
  idle: 'bg-ink-faint',
  live: 'bg-side-up',
  act: 'animate-pulse-soft bg-brand',
  warn: 'bg-[#d99e3b]',
};

function fmtSecs(sec: number): string {
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  if (sec >= 60) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${sec}s`;
}

function relTime(at: number): string {
  const d = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (d < 15) return 'just now';
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  return `${Math.floor(d / 3600)}h ago`;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-[13.5px] font-medium text-ink">{value}</dd>
    </div>
  );
}

function fmtClock(at?: number): string {
  return at === undefined ? '' : new Date(at).toLocaleTimeString('en-GB', { hour12: false });
}

/** Live mm:ss countdown interpolated between 15s status ticks. */
function Countdown({ seconds, since }: { seconds: number | null; since: number | null }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (seconds === null) return <>-</>;
  const elapsed = since === null ? 0 : Math.floor((Date.now() - since) / 1000);
  const left = Math.max(0, seconds - elapsed);
  const m = Math.floor(left / 60);
  const sec = left % 60;
  return <>{`${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`}</>;
}

/** The epoch lifecycle track: Started → Locked → Settles → Settled. */
function EpochStepper({ pilot }: { pilot: ReturnType<typeof useAutopilot> }) {
  const stage =
    pilot.phaseName === 'entry open' ? 1 : pilot.phaseName === 'locked' ? 2 : pilot.phaseName === 'settling' ? 3 : pilot.phaseName === 'settled' ? 4 : 0;
  const nodes = [
    { label: 'Started', doneAt: 1 },
    { label: stage <= 1 ? 'Entry open' : 'Locked', doneAt: 2 },
    { label: 'Settles', doneAt: 4 },
    { label: 'Settled', doneAt: 5 },
  ];
  return (
    <div className="relative mt-4">
      <div className="absolute left-2 right-2 top-[7px] h-px bg-line" aria-hidden="true" />
      <div
        className="absolute left-2 top-[7px] h-px bg-side-up transition-all"
        style={{ width: `${Math.min(100, Math.max(0, (stage / 3) * 88))}%` }}
        aria-hidden="true"
      />
      <div className="relative grid grid-cols-4">
        {nodes.map((n, i) => {
          const done = stage > i;
          const active = stage === i || (i === 2 && stage === 2) ? stage >= i && !done : false;
          const isCurrent = (i === 1 && stage === 1) || (i === 2 && stage === 2) || (i === 3 && stage >= 3);
          return (
            <div key={n.label} className={cn('flex flex-col gap-1.5', i === 0 ? 'items-start' : i === 3 ? 'items-end' : 'items-center')}>
              <span
                className={cn(
                  'grid h-[15px] w-[15px] place-items-center rounded-full border-2',
                  done ? 'border-side-up bg-side-up' : isCurrent ? 'border-brand bg-surface' : 'border-line bg-surface',
                )}
              >
                {done && (
                  <svg viewBox="0 0 10 8" className="h-2 w-2 text-white" fill="none" aria-hidden="true">
                    <path d="M1 4l2.5 2.5L9 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
                {isCurrent && !done && <span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden="true" />}
              </span>
              <span className={cn('font-mono text-[10.5px] uppercase tracking-[0.08em]', isCurrent ? 'text-ink' : 'text-ink-faint')}>
                {i === 1 && stage === 1 && pilot.entryLeftSec !== null ? (
                  <>Locks in <Countdown seconds={pilot.entryLeftSec} since={pilot.lastCheckedAt} /></>
                ) : i === 2 && stage === 2 && pilot.settleInSec !== null ? (
                  <>Settles in <Countdown seconds={pilot.settleInSec} since={pilot.lastCheckedAt} /></>
                ) : (
                  n.label
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const TOOL_LABELS: Record<string, string> = {
  get_market_overview: 'Reading the live market',
  get_stance_signal: 'Estimating qualification odds',
  get_user_positions: 'Checking your positions',
  get_limen_knowledge: 'Consulting the docs',
  get_side_concentration: 'Reading epoch participation',
  get_epoch_history: 'Reading settled epochs',
  get_claim_status: 'Computing your claimables',
  get_wallet_balances: 'Reading your balances',
};

const CAPABILITIES = [
  { label: 'Live market & epoch state', hint: 'reads the chain, not memory' },
  { label: 'Qualification odds engine', hint: 'volatility vs the band, honestly stated' },
  { label: 'Epoch history & qualify rates', hint: 'how recent epochs really settled' },
  { label: 'Your record, claims & balances', hint: 'exact claimables from the contract' },
  { label: 'Crowd positioning per epoch', hint: 'where UP/DOWN/RANGE stakes sit' },
  { label: 'Cross-market comparison', hint: 'cirBTC/USDC vs cirBTC/EURC, side by side' },
  { label: 'Executes with your confirmation', hint: 'stake · swap · liquidity · claim' },
  { label: 'Unattended session signer', hint: 'budget-capped key, zero prompts, sweeps home' },
  { label: 'Auto-claims settled fee shares', hint: 'collects before every re-entry - nothing strands' },
  { label: 'Pay-per-message billing', hint: 'Circle x402 - gasless USDC, same price every model' },
];

const SUGGESTIONS = [
  'What is happening in this epoch right now?',
  'Which view do the odds favor - and why?',
  'Add $5 of liquidity in a ±10% range.',
  'How did the last 6 epochs settle?',
  'What can I claim right now?',
  'Which side is most crowded this epoch?',
  'Compare both markets - where would you enter?',
  'Enter this epoch for me with the best view.',
  'Buy $100 of cirBTC with USDC.',
];

function shortAddr(a?: string): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : 'not connected';
}

/** The epoch ring: fills second by second as the phase runs out - full at zero, then
 *  restarts from empty when the next window begins. Circumference = 2π·66 ≈ 414.7. */
function EpochRing({ pilot }: { pilot: ReturnType<typeof useAutopilot> }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const base = pilot.entryLeftSec ?? pilot.settleInSec;
  const elapsed = pilot.lastCheckedAt === null ? 0 : Math.floor((Date.now() - pilot.lastCheckedAt) / 1000);
  const left = base === null ? null : Math.max(0, base - elapsed);
  const frac =
    left === null || pilot.phaseTotalSec === null || pilot.phaseTotalSec <= 0
      ? 0
      : Math.min(1, Math.max(0, 1 - left / pilot.phaseTotalSec));
  const C = 414.7;
  const m = left === null ? null : Math.floor(left / 60);
  const sec = left === null ? null : left % 60;
  return (
    <div className="relative grid h-[150px] w-[150px] shrink-0 place-items-center">
      <svg viewBox="0 0 150 150" className="absolute inset-0 -rotate-90" aria-hidden="true">
        <defs>
          <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#16a34a" />
            <stop offset="100%" stopColor="#4ade80" />
          </linearGradient>
        </defs>
        <circle cx="75" cy="75" r="66" fill="none" stroke="rgb(255 255 255 / 0.07)" strokeWidth="6" />
        <circle
          cx="75"
          cy="75"
          r="66"
          fill="none"
          stroke="url(#ringGrad)"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={String(C)}
          strokeDashoffset={C * (1 - frac)}
          style={{ transition: 'stroke-dashoffset 1s linear' }}
        />
      </svg>
      <div className="text-center">
        <div className="font-display text-[30px] font-bold leading-none tracking-tight text-ink">{pilot.epochId ?? '-'}</div>
        <div className="mt-1.5 font-mono text-[13px] font-semibold text-ink-soft">
          {left === null ? '-' : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`}
        </div>
        <div className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-ink-faint">
          {pilot.entryLeftSec !== null ? 'until entry closes' : 'until settlement'}
        </div>
      </div>
    </div>
  );
}

export default function AgentPage() {
  const { address } = useAccount();
  const market = useActiveMarket();
  // Session-signer addresses for the copilot's context - bridged through state because the
  // session hook is declared further down. The chat must know WHO the autopilot is on-chain,
  // or it reads the connected wallet, finds nothing, and denies the autopilot's own work.
  const [sessionAddrCtx, setSessionAddrCtx] = useState<{ live?: `0x${string}`; past: string[] }>({ past: [] });
  const {
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
  } = useCopilotChat({
    address,
    marketId: market.id,
    sessionAddress: sessionAddrCtx.live,
    pastSessionAddresses: sessionAddrCtx.past,
  });
  const [draft, setDraft] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [historyTab, setHistoryTab] = useState<'results' | 'chats'>('results');
  const [results, setResults] = useState<Array<{ epochId: string; side: string; won: boolean }> | null>(null);
  const publicClientForResults = usePublicClient({ chainId: ARC_CHAIN_ID });
  // The chat must have a BOUNDED height or its scroll area can never overflow (a flex/grid
  // child grows with content otherwise). Bind it to the right column's measured height.
  const asideRef = useRef<HTMLDivElement>(null);
  const [chatHeight, setChatHeight] = useState<number | null>(null);
  useEffect(() => {
    const el = asideRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const apply = () => setChatHeight(mq.matches ? el.offsetHeight : null);
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    mq.addEventListener('change', apply);
    apply();
    return () => {
      ro.disconnect();
      mq.removeEventListener('change', apply);
    };
  }, []);
  const threadRef = useRef<HTMLDivElement>(null);
  const budgetInputRef = useRef<HTMLInputElement>(null);

  // ── Autopilot under a mandate: watches epochs client-side, proposes entries you confirm ──
  const [autopilotOn, setAutopilotOn] = useState(false);
  const [autoAction, setAutoAction] = useState<ActionProposal | null>(null);
  const [mandate, setMandate] = useState<AgentMandate>(DEFAULT_MANDATE);
  const [copied, setCopied] = useState(false);
  // The console's "last activity" line - every meaningful agent event lands here too.
  const [lastEvent, setLastEvent] = useState<{ text: string; txHash?: string; at: number } | null>(null);
  useEffect(() => {
    try {
      setAutopilotOn(window.localStorage.getItem(AUTOPILOT_KEY) === 'on');
      setMandate(parseMandate(window.localStorage.getItem(MANDATE_STORAGE_KEY)));
    } catch {
      // storage blocked - defaults
    }
  }, []);
  const updateMandate = (next: AgentMandate) => {
    setMandate(next);
    try {
      window.localStorage.setItem(MANDATE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // best-effort
    }
  };
  const toggleView = (v: StanceView) => {
    const has = mandate.views.includes(v);
    if (has && mandate.views.length === 1) return; // a mandate always allows at least one view
    updateMandate({ ...mandate, views: has ? mandate.views.filter((x) => x !== v) : [...mandate.views, v] });
  };
  const toggleAutopilot = () => {
    setAutopilotOn((v) => {
      try {
        window.localStorage.setItem(AUTOPILOT_KEY, v ? 'off' : 'on');
      } catch {
        // best-effort
      }
      return !v;
    });
  };
  // The unattended session signer (zero prompts once funded). Refs keep the autopilot
  // callback stable so the watch loop never restarts on re-renders.
  const session = useSessionAgent(market as Market, mandate.lpRangePct);
  useEffect(() => {
    const live = session.active && session.address !== null ? session.address : undefined;
    setSessionAddrCtx({
      live,
      // Swept sessions' history still belongs to the user - keep attributing it.
      past: recentSessionAddresses()
        .filter((a) => a.toLowerCase() !== (live ?? '').toLowerCase())
        .slice(0, 3),
    });
  }, [session.active, session.address]);
  // Sessions on OTHER markets (per-market keys): funds are parked there, safe, and
  // manageable the moment the user switches - the console must SAY so, not hide it.
  const [parkedSessions, setParkedSessions] = useState<string[]>([]);
  useEffect(() => {
    setParkedSessions(marketsWithSessions(MARKETS.map((m) => m.id)).filter((id) => id !== market.id));
  }, [market.id, session.active]);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const mandateRef = useRef(mandate);
  mandateRef.current = mandate;
  const onAutopilotPropose = useCallback((action: ActionProposal) => {
    // REPLACE any pending autopilot card: a previous epoch's un-confirmed proposal is
    // dead the moment its window closes, and keeping it silently swallowed every newer
    // proposal (the loop marks epochs handled when it proposes).
    setAutoAction(action);
  }, []);
  /** Session-signed entry (zero prompts). Returns true when this epoch is dealt with -
   *  a transient failure returns false so the watch loop retries instead of burning it. */
  // Transient entry failures used to retry in TOTAL silence - if the same snag repeated
  // through the whole window, the feed showed nothing and the epoch just slipped by.
  // Voice each distinct snag once, and RE-voice it every 10 minutes: the one-shot dedupe
  // once hid a repeating blocker for two straight hours.
  const entrySnagSeen = useRef<{ key: string; at: number } | null>(null);
  // Timestamp of the last autopilot note in the feed - the no-entry heartbeat keys off it.
  const lastAutoNoteAt = useRef(Date.now());
  const executeEntry = useCallback(
    async (side: StanceView, odds: { up: number; down: number; range: number }) => {
      if (stopPendingRef.current) return true; // stop armed - never start another epoch
      const r = await sessionRef.current.enterEpoch(side);
      if (r.ok) {
        if (r.claimedFirst) {
          appendLocalNote('**Autopilot** - collected the previous epoch\'s fee share into the session before re-entering. 💰');
        }
        // The chosen side is the strongest the MANDATE allows - which may not be the global
        // favorite (a user who excludes RANGE is deliberately betting the other sides).
        const sideOdds = side === 'UP' ? odds.up : side === 'DOWN' ? odds.down : odds.range;
        const isGlobalBest = sideOdds >= Math.max(odds.up, odds.down, odds.range);
        appendLocalNote(
          `**Autopilot** - entered ${side} with the session signer. Computed odds: UP ${odds.up}% · DOWN ${odds.down}% · RANGE ${odds.range}% - ${side} was the strongest${isGlobalBest ? '' : ' your mandate allows'}. Tx ${r.txHash.slice(0, 18)}… 🎯`,
        );
        setLastEvent({ text: `Entered ${side} (${side === 'UP' ? odds.up : side === 'DOWN' ? odds.down : odds.range}% odds)`, txHash: r.txHash, at: Date.now() });
        entrySnagSeen.current = null;
        lastAutoNoteAt.current = Date.now();
      } else if (r.permanent && r.reason !== 'already entered this epoch') {
        appendLocalNote(`**Autopilot** - cannot enter: ${r.reason}`);
        setLastEvent({ text: `Entry blocked: ${r.reason}`, at: Date.now() });
        lastAutoNoteAt.current = Date.now();
      } else if (!r.permanent) {
        const key = r.reason.slice(0, 80);
        const now = Date.now();
        if (entrySnagSeen.current?.key !== key || now - entrySnagSeen.current.at > 600_000) {
          entrySnagSeen.current = { key, at: now };
          appendLocalNote(`**Autopilot** - entry attempt hit a snag (retrying): ${r.reason} ⏳`);
          setLastEvent({ text: `Entry retrying: ${r.reason.slice(0, 60)}`, at: Date.now() });
          lastAutoNoteAt.current = now;
        }
      }
      return r.ok || r.permanent === true;
    },
    [appendLocalNote],
  );
  const startSession = async () => {
    try {
      await session.start(mandate.maxStakeUsdc);
      if (!mandate.autoEnter) updateMandate({ ...mandate, autoEnter: true });
      if (!autopilotOn) toggleAutopilot();
      const budgetLabel =
        (market.quoteSymbol ?? 'USDC') === 'USDC' ? `$${mandate.maxStakeUsdc}` : `${mandate.maxStakeUsdc} ${market.quoteSymbol}`;
      appendLocalNote(
        `**Autopilot** - unattended session live on ${market.label}. A dedicated session signer now holds ${budgetLabel} + gas and will enter epochs by itself, with no prompts, until you press Stop. 🚀`,
      );
      setLastEvent({ text: `Session started with a ${budgetLabel} budget`, at: Date.now() });
    } catch (err) {
      appendLocalNote(`**Autopilot** - could not start the session: ${err instanceof Error ? err.message.slice(0, 160) : 'failed'}`);
    }
  };
  // Budget field draft: lets the user clear/retype without the committed value snapping back mid-keystroke.
  const [budgetDraft, setBudgetDraft] = useState<string | null>(null);
  const [stopPending, setStopPending] = useState(false);
  const stopPendingRef = useRef(false);
  stopPendingRef.current = stopPending;
  // An armed sweep belongs to ONE market's session. Switching markets swaps the session
  // hook underneath the retry interval - disarm rather than sweep the wrong session.
  // (The original market's LP auto-returns at settlement and parks safely; pressing Stop
  // there once, after switching back, finishes the job.)
  useEffect(() => {
    setStopPending(false);
  }, [market.id]);
  const stopSession = async () => {
    // Stop wins the race: entries halt IMMEDIATELY, and if the LP is mid-epoch the sweep
    // completes by itself right after settlement - no button-mashing contest with the bot.
    if (autopilotOn) toggleAutopilot();
    const r = await session.stop();
    if (r.swept) {
      appendLocalNote(
        r.moved !== undefined
          ? `**Autopilot** - session stopped. Returned to your wallet: ${r.moved}. 💰`
          : '**Autopilot** - session closed. It held no funds, so there was nothing to return. ✅',
      );
      setLastEvent({ text: 'Session stopped - everything swept back', at: Date.now() });
      setStopPending(false);
    } else if (r.retriable === true) {
      // The one self-resolving case: the LP sits in a live epoch and auto-returns at
      // settlement - arm the retry loop and say so.
      appendLocalNote(
        `**Autopilot** - the LP is mid-epoch, so the sweep is armed: it will complete automatically the moment the epoch settles. Entries are already halted. ⏳`,
      );
      setLastEvent({ text: 'Sweep armed - completing after settlement', at: Date.now() });
      setStopPending(true);
    } else {
      // Anything else (gas top-up declined, RPC trouble, a reverted transfer) does NOT
      // fix itself - retrying it silently every 12s would just fail every 12s (and the
      // old copy blamed "mid-epoch" for all of it, freezing the button on a lie).
      appendLocalNote(
        `**Autopilot** - the sweep did not complete: ${r.reason ?? 'unknown error'}. Nothing is lost - press "Stop & sweep back" to try again. ⚠️`,
      );
      setLastEvent({ text: 'Sweep incomplete - press Stop to retry', at: Date.now() });
      setStopPending(false);
    }
  };

  // The armed sweep: retry Stop every 12s until the LP has auto-returned and everything
  // is home. Entries stay halted the whole time (autopilot was switched off above).
  useEffect(() => {
    if (!stopPending || !session.active) {
      if (stopPending && !session.active) setStopPending(false);
      return;
    }
    const inFlight = { current: false };
    const t = setInterval(() => {
      if (inFlight.current) return; // a previous attempt may still be waiting on the lock
      inFlight.current = true;
      void sessionRef.current
        .stop()
        .then((r) => {
          if (r.swept) {
            setStopPending(false);
            appendLocalNote(
              r.moved !== undefined
                ? `**Autopilot** - sweep completed after settlement. Returned to your wallet: ${r.moved}. 💰`
                : '**Autopilot** - session closed after settlement; nothing was left to return. ✅',
            );
            setLastEvent({ text: 'Sweep completed - session closed', at: Date.now() });
          } else if (r.retriable !== true) {
            // The wait turned into a problem retrying can't fix (e.g. the sweep now needs
            // a wallet-approved gas top-up). Hand control back instead of looping on it.
            setStopPending(false);
            appendLocalNote(
              `**Autopilot** - the armed sweep stopped: ${r.reason ?? 'unknown error'}. Press "Stop & sweep back" to finish. ⚠️`,
            );
            setLastEvent({ text: 'Sweep needs another press of Stop', at: Date.now() });
          }
        })
        .finally(() => {
          inFlight.current = false;
        });
    }, 12_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopPending, session.active]);
  // Range drift watch: one feed note when the price LEAVES the session LP's band, one when
  // it returns. Primed silently on the first read so a reload never replays old news.
  const rangeSeen = useRef<boolean | null>(null);
  useEffect(() => {
    const r = session.active ? session.info?.range : null;
    if (!r || isFullRangeTicks(r.tickLower, r.tickUpper, 60)) {
      rangeSeen.current = null;
      return;
    }
    const d = describeLpRange(
      r,
      tokenBySymbol(market.baseSymbol)?.decimals ?? 8,
      quoteToken(market.quoteSymbol).decimals,
      market.quoteSymbol ?? 'USDC',
    );
    if (rangeSeen.current === null) {
      rangeSeen.current = d.inRange;
      return;
    }
    if (d.inRange !== rangeSeen.current) {
      rangeSeen.current = d.inRange;
      appendLocalNote(
        d.inRange
          ? `**Autopilot** - the price is back INSIDE your liquidity range (${d.label}). The position is earning fees again. ✅`
          : `**Autopilot** - heads-up: the price moved OUTSIDE your liquidity range (${d.label}). ⚠️ While it stays outside, the LP earns no fees, so epoch entries cannot produce a fee share. It re-activates by itself if the price comes back - or press Stop & Sweep Back and start a fresh session to re-center the range.`,
      );
      setLastEvent({ text: d.inRange ? 'Price back inside the LP range' : 'Price left the LP range', at: Date.now() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.active, session.info?.range, market.id]);

  const onClaimable = useCallback(
    (ids: string[]) => {
      const s = sessionRef.current;
      if (s.active) {
        // Session mode closes the whole loop by itself: enter → win → claim, no prompts.
        void s.claimMany(ids).then(({ claimed, failed, failReason }) => {
          appendLocalNote(
            failed === 0
              ? `**Autopilot** - claimed ${claimed} settled fee share${claimed > 1 ? 's' : ''} automatically. 💰`
              : `**Autopilot** - claimed ${claimed}, ${failed} failed (still claimable - they retry at Stop)${failReason !== undefined ? `: ${failReason}` : ''}. ⏳`,
          );
          setLastEvent({ text: failed === 0 ? `Claimed ${claimed} fee share${claimed > 1 ? 's' : ''}` : `Claimed ${claimed}, ${failed} pending retry`, at: Date.now() });
        });
        return;
      }
      appendLocalNote(
        `**Autopilot** - ${ids.length} settled fee share${ids.length > 1 ? 's are' : ' is'} ready to claim (position #${ids.join(', #')}).`,
      );
      setAutoAction((prev) => prev ?? { type: 'claim', tokenIds: ids, marketId: market.id, note: `You have ${ids.length} settled fee share${ids.length > 1 ? 's' : ''} - claim right here.` });
    },
    [appendLocalNote, market.id],
  );
  const onDiagnostic = useCallback(
    (message: string) => {
      appendLocalNote(`**Autopilot** - a check failed during this epoch (the loop keeps retrying): ${message} ⏳`);
    },
    [appendLocalNote],
  );
  const onSettledOutcome = useCallback(
    (o: { epochId: string; side: 'UP' | 'DOWN' | 'RANGE'; won: boolean }) => {
      appendLocalNote(
        o.won
          ? `**Autopilot** - Epoch ${o.epochId}: ${o.side} qualified at settlement - collecting the fee share ✅🎉`
          : `**Autopilot** - Epoch ${o.epochId}: ${o.side} did not qualify - the settlement price ended outside its zone, so that epoch's fees are forfeited ❌`,
      );
      setLastEvent({ text: o.won ? `Epoch ${o.epochId} qualified (${o.side}) ✅` : `Epoch ${o.epochId} did not qualify (${o.side}) ❌`, at: Date.now() });
    },
    [appendLocalNote],
  );
  // Hold a Web Lock while the agent works: Chromium exempts lock-holding pages from
  // intensive background-tab throttling - without it, overnight background sessions
  // stretched every read to ~60s and missed every entry window.
  useKeepAwake(session.active || autopilotOn);
  const pilot = useAutopilot({
    enabled: autopilotOn && Boolean(address),
    market: market as Market,
    // With a session live, watch the SESSION signer's positions (it owns the LP + wins).
    address: session.active && session.address !== null ? session.address : address,
    minConfidence: mandate.minConfidence,
    allowedViews: mandate.views,
    onPropose: onAutopilotPropose,
    onClaimable,
    executeEntry: session.active && mandate.autoEnter ? executeEntry : undefined,
    onSettledOutcome,
    onDiagnostic,
  });

  // No-entry HEARTBEAT: a running unattended session that keeps skipping epochs used to be
  // SILENT for hours (each skip either repeated a deduped reason or never reached the feed
  // at all - sub-floor odds just re-evaluate). Every 10 minutes without a feed note, say
  // what the autopilot is actually seeing, in its own words (the live status line), so
  // "why isn't it entering?" always has an answer in the feed.
  const pilotRef = useRef(pilot);
  pilotRef.current = pilot;
  useEffect(() => {
    if (!session.active || pilot.state === 'off') return;
    const t = setInterval(() => {
      if (Date.now() - lastAutoNoteAt.current < 600_000) return;
      const p = pilotRef.current;
      if (p.state === 'off' || p.detail === '') return;
      lastAutoNoteAt.current = Date.now();
      appendLocalNote(`**Autopilot** - still watching, no entry in the last 10 minutes. Right now: ${p.detail}`);
    }, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.active, pilot.state === 'off', appendLocalNote]);

  /** Compile the mandate into the self-custody unattended agent config and copy it. */
  const copyUnattendedConfig = async () => {
    const { ENV } = await import('@/lib/env');
    const base = tokenBySymbol(market.baseSymbol);
    const quote = quoteToken(market.quoteSymbol);
    const text = buildUnattendedConfig({
      mandate,
      expiresDays: 7,
      market: market as Market,
      tokens: { base: base?.address ?? '', quote: quote.address, quoteDecimals: quote.decimals },
      addresses: { npm: ENV.NPM_ADDRESS, router: ENV.SWAP_ROUTER_ADDRESS, pyth: ENV.PYTH_ADDRESS },
      agentWalletAddress: '<your Circle Agent Wallet address - `circle wallet list`>',
    });
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_500);
    } catch {
      // clipboard blocked - the config is also in the docs
    }
  };

  /** Win/lose record for the History panel. NO on-chain view can rebuild this: the arena
   *  keeps ONE position record per token, overwritten on every restake, so getUserStakes
   *  AND getStakesByEpoch both mirror the LATEST state (the "epoch 3143 x4" duplicate bug).
   *  Event logs are the only per-epoch truth: Staked(owner-indexed) gives each entry,
   *  PositionProcessed(tokenId-indexed) gives its verdict. Scanned over a recent window so
   *  the popover opens in seconds; entries from both the wallet AND the live session count. */
  const loadResults = async () => {
    const owners = [...new Set(
      [address, session.active ? session.address : null, ...recentSessionAddresses()]
        .filter((a): a is `0x${string}` => typeof a === 'string')
        .map((a) => a.toLowerCase() as `0x${string}`),
    )];
    if (!publicClientForResults || owners.length === 0) {
      setResults([]);
      return;
    }
    try {
      const toBlock = await publicClientForResults.getBlockNumber();
      const floor = market.fromBlock ?? 0n;
      const fromBlock = toBlock > floor + RESULTS_LOOKBACK_BLOCKS ? toBlock - RESULTS_LOOKBACK_BLOCKS : floor;
      const stakedLogs = await getEventLogsChunked(publicClientForResults, {
        address: market.feeArena,
        event: STAKED_EVENT,
        fromBlock,
        toBlock,
        eventArgs: { owner: owners },
      });
      if (stakedLogs.length === 0) {
        setResults([]);
        return;
      }
      const tokenIds = [...new Set(stakedLogs.map((l) => (l.args as { tokenId?: bigint }).tokenId).filter((t): t is bigint => t !== undefined))];
      const processedLogs = await getEventLogsChunked(publicClientForResults, {
        address: market.feeArena,
        event: POSITION_PROCESSED_EVENT,
        fromBlock,
        toBlock,
        eventArgs: { tokenId: tokenIds },
      });
      const verdicts = new Map<string, boolean>();
      for (const l of processedLogs) {
        const a = l.args as { epochId?: bigint; tokenId?: bigint; won?: boolean };
        if (a.epochId !== undefined && a.tokenId !== undefined) verdicts.set(`${a.epochId}-${a.tokenId}`, a.won === true);
      }
      const SIDES = ['NONE', 'UP', 'DOWN', 'RANGE'];
      const mine: Array<{ epochId: string; side: string; won: boolean }> = [];
      for (const l of stakedLogs) {
        const a = l.args as { epochId?: bigint; tokenId?: bigint; side?: number };
        if (a.epochId === undefined || a.tokenId === undefined) continue;
        const won = verdicts.get(`${a.epochId}-${a.tokenId}`);
        if (won === undefined) continue; // not settled yet - the record lists verdicts only
        mine.push({ epochId: a.epochId.toString(), side: SIDES[Number(a.side ?? 0)] ?? '?', won });
      }
      mine.reverse(); // logs arrive oldest-first; the record reads newest-first
      setResults(mine);
    } catch {
      setResults([]);
    }
  };
  const toggleHistory = () => {
    setShowHistory((v) => {
      if (!v) {
        setResults(null);
        void loadResults();
      }
      return !v;
    });
  };

  // Keep the newest message in view while streaming - but only when the user is already
  // near the bottom, so scrolling up to read history is never yanked away.
  const nearBottom = useRef(true);
  const onThreadScroll = () => {
    const el = threadRef.current;
    if (el) nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  useEffect(() => {
    if (nearBottom.current) {
      threadRef.current?.scrollTo?.({ top: threadRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages, activity, pendingAction, autoAction, paymentRequired]);

  const submit = () => {
    send(draft);
    setDraft('');
  };

  const modelLabel = model ?? '-';

  return (
    <div data-testid="agent-page" className="relative mx-auto max-w-none overflow-x-clip px-5 py-7 sm:px-8 lg:px-12">
      {/* faint red ambience, as in the reference */}
      <div className="pointer-events-none absolute -right-24 top-64 h-[420px] w-[420px] rounded-full bg-brand/[0.05] blur-[130px]" aria-hidden="true" />
      <div className="pointer-events-none absolute -left-24 bottom-10 h-[360px] w-[420px] rounded-full bg-brand/[0.05] blur-[130px]" aria-hidden="true" />

      {/* ── Console header ─────────────────────────────────────────────────────────── */}
      <header className="rounded-2xl border border-line bg-surface relative flex flex-wrap items-center gap-x-0 gap-y-4 px-6 py-3.5 sm:px-7">
        <div className="flex items-center gap-4 pr-8">
          <span className="relative grid h-[52px] w-[52px] place-items-center rounded-full border border-brand/60 bg-surface-muted shadow-[0_0_26px_rgb(229_72_77/0.4)]">
            {/* The mark fills the inner ring EDGE-TO-EDGE (inset matches the ring's box), and
                the ring is painted AFTER it so its line sits right on the mark's rim. */}
            <BrandMark circle className="absolute inset-[3px] drop-shadow-[0_0_8px_rgb(229_72_77/0.8)]" />
            <span className="absolute inset-[3px] rounded-full border border-brand/25" aria-hidden="true" />
          </span>
          <div>
            <div className="font-display text-[21px] font-bold tracking-tight text-ink">Limen Copilot</div>
            <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-muted">
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  status === 'offline' ? 'bg-side-down' : status === 'thinking' ? 'animate-pulse-soft bg-brand' : 'bg-side-up',
                )}
                aria-hidden="true"
              />
              {status === 'offline' ? 'Offline' : status === 'thinking' ? 'Working' : 'Online'}
            </div>
          </div>
        </div>
        <div className="hidden h-10 w-px self-center bg-line md:block" aria-hidden="true" />
        <div className="px-8">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">Model</div>
          <div className="mt-1.5">
            {models.length > 1 ? (
              <ModelPicker
                models={models}
                value={model}
                onChange={setModel}
                priceLabel={billing?.enabled ? `$${(Number(billing.priceUsdc6 ?? '10000') / 1e6).toFixed(2)} per message` : 'nothing - this deployment is free'}
              />
            ) : (
              <span data-testid="agent-model" className="rounded-lg border border-line bg-surface-muted px-3 py-1.5 font-mono text-[12.5px] font-semibold text-ink">
                {modelLabel}
              </span>
            )}
          </div>
        </div>
        <div className="hidden h-10 w-px self-center bg-line md:block" aria-hidden="true" />
        <div className="px-8">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">Billing</div>
          <div className="mt-2 flex items-baseline gap-2.5">
            <span className="text-[15px] font-semibold text-side-up">
              {billing?.enabled ? `$${(Number(billing.priceUsdc6 ?? '10000') / 1e6).toFixed(2)} / message` : 'Free quota'}
            </span>
            <span className="font-mono text-[11.5px] text-ink-faint">
              {billing?.enabled ? 'Circle x402 · gasless' : 'about $0.01 / message'}
            </span>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-6 pl-6">
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">Market</span>
          {MARKETS.length >= 2 ? (
            <div className="ml-4 origin-right scale-[1.08]">
              <MarketSelector />
            </div>
          ) : (
            <span className="font-mono text-[12px] text-ink-soft">{market.label}</span>
          )}
        </div>
      </header>

      <div className="mt-[18px] grid items-stretch gap-[18px] lg:grid-cols-[1.042fr_1fr]">
        {/* ── Copilot activity ─────────────────────────────────────────────────────── */}
        <section
          className="rounded-2xl border border-line bg-surface order-1 flex min-h-[570px] flex-col overflow-hidden px-0 py-0"
          style={chatHeight !== null ? { height: chatHeight, minHeight: 570 } : undefined}
        >
          <div className="px-6 pb-1 pt-4">
            <span className="kicker font-mono">Copilot activity</span>
          </div>
          <div ref={threadRef} onScroll={onThreadScroll} className="relative min-h-0 flex-1 space-y-0 overflow-y-auto px-6 pb-4 pt-2">
            {status === 'offline' ? (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <BrandMark className="h-7 w-7 opacity-40 grayscale" />
                <p className="mt-3 max-w-sm text-[14px] leading-relaxed text-ink-muted">
                  The copilot service is not configured on this deployment yet. It comes online the moment the
                  operator adds the model API key - everything else is ready.
                </p>
              </div>
            ) : messages.length === 0 && !autoAction ? (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <span className="grid h-14 w-14 place-items-center rounded-2xl border border-brand/40 bg-surface-muted shadow-[0_0_30px_rgb(229_72_77/0.25)]">
                  <BrandMark className="h-8 w-8 drop-shadow-[0_0_8px_rgb(229_72_77/0.55)]" />
                </span>
                <h2 className="mt-5 font-display text-2xl font-semibold tracking-tight text-ink">Ask. Understand. Act.</h2>
                <p className="mt-2 max-w-md text-[14.5px] leading-relaxed text-ink-muted">
                  I read the live chain, the oracle, and your positions before answering - and when you ask me
                  to act, your wallet confirms every transaction.
                </p>
              </div>
            ) : (
              <div className="relative">
                <div className="pointer-events-none absolute bottom-2 left-[81px] top-2 border-l border-dashed border-line/70" aria-hidden="true" />
                {messages.map((m, i) => {
                  if (m.role === 'user' && m.content.startsWith('[Action result]')) {
                    return (
                      <div key={i} className="relative flex justify-center py-2.5">
                        <span className="rounded-full border border-line bg-surface-muted px-3 py-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">
                          action outcome reported
                        </span>
                      </div>
                    );
                  }
                  if (m.role === 'assistant' && m.content.startsWith('**Autopilot**')) {
                    const body = m.content.replace(/^\*\*Autopilot\*\*\s*-?\s*/, '');
                    return (
                      <div key={i} className="relative flex items-start gap-3.5 border-b border-line/50 py-3">
                        <span className="w-[58px] shrink-0 pt-px font-mono text-[11px] text-ink-faint">{fmtClock(m.at)}</span>
                        <span className="z-10 mt-[2px] grid h-[15px] w-[15px] shrink-0 place-items-center rounded-full border border-brand/70 bg-[#160b0c]">
                          <span className="h-[6px] w-[6px] rounded-full bg-brand" aria-hidden="true" />
                        </span>
                        <p
                          className={cn(
                            'text-[13px] leading-relaxed',
                            // Emoji markers double as the feed's tone map - every lifecycle
                            // event gets its own colour so the eye can sort the stream.
                            body.includes('🏆') || body.includes('✅')
                              ? 'font-medium text-side-up'
                              : body.includes('❌')
                                ? 'font-medium text-side-down'
                                : body.includes('🎯')
                                  ? 'font-medium text-brand'
                                  : body.includes('🚀')
                                    ? 'font-medium text-side-range'
                                    : body.includes('💰') || body.includes('⚠️') || body.includes('⏳')
                                      ? 'font-medium text-[#d99e3b]'
                                      : 'text-ink-muted',
                          )}
                        >
                          <span className="font-semibold text-ink">Autopilot</span> {body}
                        </p>
                      </div>
                    );
                  }
                  return (
                    <div key={i} className={cn('relative flex items-start gap-2.5 py-2', m.role === 'user' && 'flex-row-reverse')}>
                      {m.role === 'assistant' && (
                        <span className="z-10 mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-brand/30 bg-surface-muted">
                          <Logo className="h-3.5 w-3.5 text-brand" />
                        </span>
                      )}
                      <div
                        className={cn(
                          'max-w-[82%] rounded-2xl px-4 py-2.5 text-[13.5px] leading-relaxed',
                          m.role === 'user' ? 'z-10 rounded-br-md bg-brand/15 text-ink' : 'z-10 rounded-tl-md border border-line bg-surface-muted/80 text-ink-soft',
                        )}
                      >
                        {m.role === 'assistant' ? <Markdown text={m.content} /> : m.content}
                      </div>
                    </div>
                  );
                })}
                {activity && (
                  <div className="relative ml-[88px] flex items-center gap-2 py-2 font-mono text-[11.5px] uppercase tracking-[0.12em] text-ink-faint">
                    <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-brand" aria-hidden="true" />
                    {TOOL_LABELS[activity] ?? activity}…
                  </div>
                )}
                {status === 'thinking' && !activity && messages[messages.length - 1]?.role === 'user' && (
                  <div className="relative flex items-start gap-2.5 py-2" aria-label="Copilot is thinking" role="status">
                    <span className="z-10 mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-brand/30 bg-surface-muted">
                      <Logo className="h-3.5 w-3.5 text-brand" />
                    </span>
                    <div className="z-10 rounded-2xl rounded-tl-md border border-line bg-surface-muted/80 px-4 py-3">
                      <span className="flex items-center gap-1.5">
                        {[0, 160, 320].map((delay) => (
                          <span
                            key={delay}
                            className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-muted"
                            style={{ animationDelay: `${delay}ms`, animationDuration: '900ms' }}
                            aria-hidden="true"
                          />
                        ))}
                      </span>
                    </div>
                  </div>
                )}
                {pendingAction && (
                  <div className="relative z-10 py-2">
                    {/* Keyed by proposal identity: a NEW proposal of the same type must remount
                        the card, or mount-time plans (the LP mint sizing) would go stale. */}
                    <ActionCard key={actionKey(pendingAction)} action={pendingAction} onResult={reportActionResult} onDismiss={dismissAction} />
                  </div>
                )}
                {autoAction && (
                  <div className="relative z-10 py-2">
                    <ActionCard
                      key={actionKey(autoAction)}
                      action={autoAction}
                      autoConfirm={mandate.autoEnter && autoAction.type === 'stake'}
                      onResult={(summary) => {
                        appendLocalNote(autopilotOutcome(summary));
                        setAutoAction(null);
                      }}
                      onDismiss={() => setAutoAction(null)}
                    />
                  </div>
                )}
                {paymentRequired && (
                  <div className="relative z-10 py-2">
                    <PayCard payment={paymentRequired} onPaid={retryWithPayment} onDismiss={dismissPayment} />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="px-5 pb-4 pt-1 sm:px-6">
            <div className="mb-3 flex items-stretch gap-2.5">
              {SUGGESTIONS.slice(0, 3).map((sug, si) => (
                <button
                  key={sug}
                  type="button"
                  onClick={() => send(sug)}
                  disabled={status === 'offline' || !address}
                  className="flex flex-1 items-center gap-3 rounded-xl border border-line bg-surface-muted/40 px-3.5 py-2.5 text-left text-[12px] leading-snug text-ink-soft transition-colors hover:border-brand/40 hover:text-ink disabled:opacity-50"
                >
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-brand/25 bg-brand/5 text-brand" aria-hidden="true">
                    {si === 0 ? (
                      <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5"><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                    ) : si === 1 ? (
                      <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5"><path d="M12 3l7 4v5c0 4.4-3 8-7 9-4-1-7-4.6-7-9V7l7-4z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5"><circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" /><path d="M12 7.5V12l3 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                    )}
                  </span>
                  {sug}
                </button>
              ))}
              <div className="relative flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={toggleHistory}
                  title="Previous conversations"
                  aria-label="Previous conversations"
                  aria-expanded={showHistory}
                  className="flex w-[52px] flex-col items-center justify-center gap-1 rounded-xl border border-line text-ink-muted transition-colors hover:border-brand/40 hover:text-ink"
                >
                  <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                    <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
                    <path d="M12 7.5V12l3 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                  <span className="font-mono text-[8px] font-bold uppercase tracking-[0.1em]">History</span>
                </button>
                <button
                  type="button"
                  onClick={clearThread}
                  disabled={status === 'thinking' || messages.length === 0}
                  title="Clear conversation (it moves to History)"
                  aria-label="Clear conversation"
                  className="flex w-[52px] flex-col items-center justify-center gap-1 rounded-xl border border-line text-ink-muted transition-colors hover:border-brand/40 hover:text-ink disabled:opacity-40"
                >
                  <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                    <path d="M4 4v6h6M20 20v-6h-6M20 9a8 8 0 00-14-4M4 15a8 8 0 0014 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="font-mono text-[8px] font-bold uppercase tracking-[0.1em]">Clear</span>
                </button>
                {showHistory && (
                  <div className="absolute bottom-[calc(100%+8px)] right-0 z-30 w-[440px] rounded-xl border border-line bg-surface p-2.5 shadow-[0_16px_40px_rgb(0_0_0/0.6)]">
                    <div className="flex items-center gap-1.5 border-b border-line px-1 pb-2">
                      {(['results', 'chats'] as const).map((tab) => (
                        <button
                          key={tab}
                          type="button"
                          onClick={() => setHistoryTab(tab)}
                          className={cn(
                            'rounded-lg px-3 py-1.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.1em] transition-colors',
                            historyTab === tab ? 'bg-brand/15 text-brand' : 'text-ink-faint hover:text-ink',
                          )}
                        >
                          {tab === 'results' ? 'Qualification record' : 'Conversations'}
                        </button>
                      ))}
                    </div>
                    {historyTab === 'results' ? (
                      results === null ? (
                        <p className="px-2 py-3 text-[12.5px] text-ink-muted">Reading your record from the arena…</p>
                      ) : results.length === 0 ? (
                        <p className="px-2 py-3 text-[12.5px] text-ink-muted">
                          No settled entries yet{address ? '' : ' - connect a wallet first'}. Results appear here as epochs settle.
                        </p>
                      ) : (
                        <>
                          <div className="flex items-center gap-4 px-2 py-2 font-mono text-[11px] text-ink-muted">
                            <span className="font-semibold text-side-up">{results.filter((r) => r.won).length} qualified</span>
                            <span className="font-semibold text-side-down">{results.filter((r) => !r.won).length} missed</span>
                            <span className="text-ink-faint">
                              {Math.round((results.filter((r) => r.won).length / results.length) * 100)}% qualified · {results.length} entries
                            </span>
                          </div>
                          <ul className="max-h-[340px] overflow-y-auto pr-1">
                            {results.map((r, i) => (
                              <li
                                key={`${r.epochId}-${i}`}
                                className="flex items-center justify-between border-b border-line/50 px-2 py-2 last:border-0"
                              >
                                <span className="font-mono text-[12px] text-ink-soft">
                                  Epoch {r.epochId} · {r.side}
                                </span>
                                <span className={cn('font-mono text-[12px] font-bold', r.won ? 'text-side-up' : 'text-side-down')}>
                                  {r.won ? 'QUALIFIED ✅' : 'MISSED ❌'}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </>
                      )
                    ) : history.length === 0 ? (
                      <p className="px-2 py-3 text-[12.5px] text-ink-muted">
                        Nothing archived yet - clearing a conversation saves it here.
                      </p>
                    ) : (
                      <ul className="max-h-[340px] overflow-y-auto pr-1">
                        {history.map((h) => (
                          <li key={h.id}>
                            <button
                              type="button"
                              onClick={() => {
                                restoreThread(h.id);
                                setShowHistory(false);
                              }}
                              className="w-full rounded-lg px-2 py-2 text-left transition-colors hover:bg-surface-muted"
                            >
                              <div className="truncate text-[13px] font-medium text-ink">{h.title}</div>
                              <div className="mt-0.5 font-mono text-[10.5px] text-ink-faint">
                                {new Date(h.at).toLocaleString('en-GB', { hour12: false })} · {h.messages.length} messages
                              </div>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-end gap-2.5">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
                rows={1}
                placeholder={
                  status === 'offline'
                    ? 'Copilot offline'
                    : !address
                      ? 'Connect your wallet to chat with the agent'
                      : 'Ask about markets, odds, your positions - or ask me to act…'
                }
                disabled={status === 'offline' || !address}
                className="max-h-32 min-h-[52px] flex-1 resize-none rounded-xl border border-line bg-surface-muted/30 px-4 py-3.5 text-[14.5px] text-ink outline-none placeholder:text-ink-faint focus:border-brand/50 disabled:opacity-60"
              />
              <button
                type="button"
                onClick={submit}
                disabled={status === 'offline' || status === 'thinking' || !address || draft.trim() === ''}
                aria-label="Send"
                className="grid h-[52px] w-[60px] shrink-0 place-items-center rounded-xl bg-brand text-white shadow-[0_6px_24px_rgb(229_72_77/0.35)] transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
                  <path d="M3.5 11.5l16-7-6.5 16-2.5-6.5-7-2.5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
            <p className="mt-2.5 font-mono text-[11px] text-ink-faint">
              The agent reads the live chain, not memory. Always review before acting.
            </p>
          </div>
        </section>

        {/* ── Right column ─────────────────────────────────────────────────────────── */}
        <aside ref={asideRef} className="order-2 flex flex-col gap-[18px] self-start">
          {/* Mission control */}
          <div className="rounded-2xl border border-line bg-surface px-6 py-5">
            {(() => {
              const effState = pilot.state === 'off' ? (session.active ? 'paused' : 'off') : pilot.state;
              const meta = STATE_META[effState] ?? STATE_META.off!;
              return (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <span className="kicker font-mono">Mission control</span>
                    <span
                      className={cn(
                        'flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.14em]',
                        meta.tone === 'live' && 'border-side-up/40 text-side-up',
                        meta.tone === 'act' && 'border-brand/50 text-brand',
                        meta.tone === 'warn' && 'border-[#d99e3b]/50 text-[#d99e3b]',
                        meta.tone === 'idle' && 'border-line text-ink-muted',
                      )}
                    >
                      <span className={cn('h-1.5 w-1.5 rounded-full', TONE_DOT[meta.tone])} aria-hidden="true" />
                      {effState === 'off' ? 'Off' : effState === 'paused' ? 'Paused' : meta.tone === 'act' ? 'Acting' : meta.tone === 'warn' ? 'Retry' : 'Live'}
                    </span>
                  </div>

                  <div className="mt-3 flex items-start gap-6">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                        <span className="flex items-center gap-2.5 whitespace-nowrap">
                          <span className={cn('h-3 w-3 rounded-full', TONE_DOT[meta.tone])} aria-hidden="true" />
                          <span className="font-display text-[24px] font-bold tracking-tight text-ink">{meta.title.replace(/^Running - .*$/, 'Running')}</span>
                        </span>
                        <span className="min-w-0 text-[12.5px] leading-snug text-ink-muted [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">
                          {effState === 'paused'
                            ? 'Watching is paused - the session still holds its budget.'
                            : pilot.detail}
                        </span>
                      </div>
                      <EpochStepper pilot={pilot} />
                      <dl className="mt-3 grid grid-cols-3 gap-x-5 gap-y-0 border-t border-line">
              <div className="col-span-2 border-b border-line py-3">
                <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">Market</dt>
                <dd className="mt-1.5 flex items-center gap-2 text-[14px] font-semibold text-ink">
                  <TokenGlyph symbol="cirBTC" className="h-[18px] w-[18px]" />
                  {market.label}
                </dd>
              </div>
              <div className="border-b border-line py-3">
                <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">Epoch</dt>
                <dd className="mt-1.5 text-[14px] font-semibold text-ink">
                  {pilot.epochId === null ? '-' : `#${pilot.epochId} · ${pilot.phaseName ?? ''}`}
                </dd>
              </div>
              {(() => {
                const rg = session.active ? session.info?.range : null;
                if (!rg) return null;
                const r = describeLpRange(
                  rg,
                  tokenBySymbol(market.baseSymbol)?.decimals ?? 8,
                  quoteToken(market.quoteSymbol).decimals,
                  market.quoteSymbol ?? 'USDC',
                );
                return (
                  <div className="col-span-3 border-b border-line py-3">
                    <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">Liquidity range</dt>
                    <dd className="mt-1.5 flex items-center gap-2.5 text-[14px] font-semibold text-ink">
                      {r.label}
                      {!r.full && (
                        <span
                          className={cn(
                            'rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide',
                            r.inRange ? 'border-side-up/50 text-side-up' : 'border-side-down/50 text-side-down',
                          )}
                        >
                          {r.inRange ? 'in range · earning' : 'out of range'}
                        </span>
                      )}
                    </dd>
                  </div>
                );
              })()}
              <div className="py-3">
                <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">Live odds</dt>
                <dd className="mt-1.5 text-[14px] font-semibold text-ink">
                  {pilot.confidence === null ? '-' : `${(pilot.confidence * 100).toFixed(2)}%`}
                </dd>
                <dt className="mt-2 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">In epoch</dt>
                <dd className="mt-1 text-[12px]">
                  {lastEvent?.txHash !== undefined ? (
                    <a
                      href={`https://testnet.arcscan.app/tx/${lastEvent.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-ink-soft underline-offset-2 hover:text-brand hover:underline"
                    >
                      {lastEvent.txHash.slice(0, 6)}…{lastEvent.txHash.slice(-4)} ↗
                    </a>
                  ) : (
                    <span className="font-mono text-ink-faint">-</span>
                  )}
                </dd>
              </div>
              <div className="py-3">
                <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">Session budget</dt>
                {(() => {
                  if (!session.active) {
                    return <dd className="mt-1.5 text-[14px] font-semibold text-ink">no session</dd>;
                  }
                  // Cash + what the LP position holds - cash alone read as "$2 left" the
                  // moment a $100 session minted its LP.
                  const sym = (market.quoteSymbol ?? 'USDC') === 'USDC' ? '$' : `${market.quoteSymbol} `;
                  const cash = Number(formatUnits(session.info?.quoteBal ?? 0n, quoteToken(market.quoteSymbol).decimals));
                  const lp = session.info?.lpValue?.totalQuote;
                  if (lp === undefined) {
                    return <dd className="mt-1.5 text-[14px] font-semibold text-ink">{`${sym}${cash.toFixed(2)} left`}</dd>;
                  }
                  return (
                    <>
                      <dd className="mt-1.5 text-[14px] font-semibold text-ink">{`≈ ${sym}${(cash + lp).toFixed(2)} total`}</dd>
                      <dd className="mt-0.5 font-mono text-[10.5px] text-ink-faint">{`${sym}${cash.toFixed(2)} cash · ≈${sym}${lp.toFixed(2)} in the LP`}</dd>
                    </>
                  );
                })()}
              </div>
              <div className="py-3">
                <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">Latest activity</dt>
                <dd className="mt-1.5 truncate text-[13px] font-medium text-ink" title={lastEvent?.text}>
                  {lastEvent === null ? (pilot.detail === '' ? '-' : 'Nothing yet') : lastEvent.text}
                </dd>
              </div>
            </dl>
                    </div>
                    <EpochRing pilot={pilot} />
                  </div>
                </>
              );
            })()}

            <div className="mt-4 flex items-stretch gap-3">
              {session.active ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      toggleAutopilot();
                      appendLocalNote(
                        autopilotOn
                          ? '**Autopilot** - paused. No new epochs will be entered; the session keeps its funds and an already-staked epoch settles normally. Press Resume to continue, or Stop & Sweep Back to bring everything home.'
                          : '**Autopilot** - resumed. Watching epochs under your mandate again.',
                      );
                    }}
                    disabled={stopPending}
                    className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-line bg-surface-muted/40 px-3 py-3 text-[13.5px] font-semibold text-ink-soft transition-colors hover:border-brand/50 hover:text-ink disabled:opacity-40"
                  >
                    <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden="true"><path d="M9 5v14M15 5v14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></svg>
                    {autopilotOn ? 'Pause' : 'Resume'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void stopSession()}
                    disabled={session.busy || stopPending}
                    className="flex flex-[1.5] items-center justify-center gap-2 rounded-xl bg-brand px-3 py-3 text-[13.5px] font-semibold text-white shadow-[0_6px_24px_rgb(229_72_77/0.3)] transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="2" /></svg>
                    {stopPending ? 'Sweeping at settlement…' : session.busy ? 'Working…' : 'Stop & Sweep Back'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const k = session.exportKey();
                      if (k !== null) {
                        void navigator.clipboard.writeText(k).then(() => {
                          appendLocalNote('**Autopilot** - session key copied to your clipboard. Store it somewhere safe: it is the only way to recover the session\'s funds if this browser\'s storage is cleared.');
                          setLastEvent({ text: 'Session key backed up to clipboard', at: Date.now() });
                        });
                      }
                    }}
                    className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-line bg-surface-muted/40 px-3 py-3 text-[13.5px] font-semibold text-ink-soft transition-colors hover:border-brand/50 hover:text-ink"
                  >
                    <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden="true"><circle cx="8" cy="12" r="4" stroke="currentColor" strokeWidth="1.8" /><path d="M12 12h9m-3 0v3m-3-3v2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                    Backup Key
                  </button>
                </>
              ) : (
                <div className="w-full space-y-2.5">
                  <button
                    type="button"
                    onClick={() => void startSession()}
                    disabled={!address || session.busy}
                    className="w-full rounded-xl bg-brand px-4 py-3 text-[14px] font-semibold text-white shadow-[0_6px_24px_rgb(229_72_77/0.3)] transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {session.busy ? 'Starting…' : `Start unattended · $${mandate.maxStakeUsdc} budget`}
                  </button>
                  <button
                    type="button"
                    onClick={toggleAutopilot}
                    className="w-full rounded-xl border border-line px-4 py-2.5 text-[13px] font-semibold text-ink-soft transition-colors hover:border-brand/50 hover:text-ink"
                  >
                    {autopilotOn ? 'Pause watch-only mode' : 'Watch & propose only - you confirm each entry'}
                  </button>
                  <p className="text-center font-mono text-[10.5px] leading-relaxed text-ink-faint">
                    {!address ? 'Connect a wallet to start.' : 'Unattended funds a dedicated signer once (two approvals), then acts with zero prompts.'}
                  </p>
                </div>
              )}
            </div>

            {parkedSessions.length > 0 && (
              <p className="mt-3 rounded-lg border border-line bg-surface-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-muted">
                A session is also live on{' '}
                <span className="font-bold text-ink">
                  {parkedSessions.map((id) => MARKETS.find((m) => m.id === id)?.label ?? id).join(' · ')}
                </span>{' '}
                - its funds are parked safely under its own signer. Switch markets (top right) to manage it; entries run
                for the market you are viewing.
              </p>
            )}
          </div>

          <div className="grid gap-[18px] sm:grid-cols-2">
            {/* Mandate */}
            <div className="rounded-2xl border border-line bg-surface flex flex-col px-5 py-5">
              <div className="flex items-center justify-between">
                <span className="kicker font-mono">Mandate</span>
                <button
                  type="button"
                  onClick={() => budgetInputRef.current?.focus()}
                  className="rounded-md border border-line px-2.5 py-1 font-mono text-[10.5px] font-semibold text-ink-muted transition-colors hover:border-brand/50 hover:text-ink"
                >
                  Edit
                </button>
              </div>
              <div className="mt-4 space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-ink-faint">Allowed views</span>
                  <span className="flex items-center gap-1.5">
                    {ALL_VIEWS.map((v) => {
                      const on = mandate.views.includes(v);
                      return (
                        <button
                          key={v}
                          type="button"
                          aria-pressed={on}
                          onClick={() => toggleView(v)}
                          className={cn(
                            'rounded-lg border px-3 py-1.5 font-mono text-[12px] font-bold uppercase tracking-wide transition-colors',
                            on ? VIEW_CHIP[v] : 'border-line text-ink-faint opacity-40',
                          )}
                        >
                          {v}
                        </button>
                      );
                    })}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-ink-faint">Liquidity range</span>
                  <span className="flex items-center gap-1.5">
                    {([['Full', null], ['±10%', 10], ['±2%', 2]] as const).map(([label, pct]) => {
                      const on = mandate.lpRangePct === pct;
                      return (
                        <button
                          key={label}
                          type="button"
                          aria-pressed={on}
                          onClick={() => updateMandate({ ...mandate, lpRangePct: pct })}
                          className={cn(
                            'rounded-lg border px-2.5 py-1.5 font-mono text-[11.5px] font-bold tracking-wide transition-colors',
                            on ? 'border-brand/60 bg-brand/10 text-brand' : 'border-line text-ink-faint opacity-60 hover:opacity-100',
                          )}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </span>
                </div>
                <label className="block">
                  <span className="flex items-center justify-between font-mono text-[11.5px] uppercase tracking-[0.14em] text-ink-faint">
                    Confidence threshold
                    <span className="font-mono text-[16px] font-bold normal-case tracking-normal text-ink">{Math.round(mandate.minConfidence * 100)}%</span>
                  </span>
                  <input
                    type="range"
                    min={10}
                    max={90}
                    step={5}
                    value={Math.round(mandate.minConfidence * 100)}
                    onChange={(e) => updateMandate({ ...mandate, minConfidence: Number(e.target.value) / 100 })}
                    className="mt-3 w-full accent-[rgb(229_72_77)]"
                    aria-label="Autopilot confidence floor"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-ink-faint">Budget cap per entry</span>
                  {/* Full-width, spinner-free amount field: type="text" + numeric keyboard kills
                      the fiddly stepper arrows, and the DRAFT state lets the user clear/retype
                      freely - the mandate only commits values in range, and blur snaps the
                      display back to the last committed number. */}
                  <span className="flex h-11 items-center gap-2 rounded-xl border border-line bg-surface-muted px-3.5 transition-colors focus-within:border-brand/60">
                    <span className="font-mono text-[16px] font-semibold text-ink-muted">$</span>
                    <input
                      ref={budgetInputRef}
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      value={budgetDraft ?? String(mandate.maxStakeUsdc)}
                      onChange={(e) => {
                        const raw = e.target.value.replace(/[^0-9]/g, '');
                        setBudgetDraft(raw);
                        const n = Number(raw);
                        if (raw !== '' && Number.isFinite(n) && n >= 1 && n <= 1000) updateMandate({ ...mandate, maxStakeUsdc: n });
                      }}
                      onBlur={() => setBudgetDraft(null)}
                      className="w-full bg-transparent font-mono text-[16px] font-semibold text-ink outline-none placeholder:text-ink-faint"
                      placeholder="1 - 1000"
                      aria-label="Budget cap per entry in USDC"
                    />
                    <span className="shrink-0 font-mono text-[10.5px] uppercase tracking-wide text-ink-faint">max 1000</span>
                  </span>
                  <span className="font-mono text-[10.5px] leading-relaxed normal-case tracking-normal text-ink-faint">
                    This is the {market.quoteSymbol ?? 'USDC'} half of the LP pair - starting an unattended session also sends a matching
                    value of {market.baseSymbol} from your wallet (a pool position needs both halves)
                    {(market.quoteSymbol ?? 'USDC') === 'USDC' ? '' : ', plus ~$1.5 USDC for gas'}.
                  </span>
                </label>
                <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
                  <div>
                    <div className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-ink-faint">Auto-enter / unattended</div>
                    <div className="mt-1.5 font-mono text-[11px] leading-relaxed text-ink-faint">
                      {session.active ? 'Session signer · zero prompts' : 'Skips the card - wallet still signs'}
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={mandate.autoEnter}
                    aria-label="Toggle auto-enter"
                    onClick={() => updateMandate({ ...mandate, autoEnter: !mandate.autoEnter })}
                    className={cn(
                      'relative h-[26px] w-12 shrink-0 rounded-full border transition-colors',
                      mandate.autoEnter ? 'border-brand/60 bg-brand' : 'border-line bg-surface-muted',
                    )}
                  >
                    <span
                      className={cn('absolute top-[3px] rounded-full bg-white transition-all', mandate.autoEnter ? 'left-[25px]' : 'left-[3px]')}
                      style={{ height: '18px', width: '18px' }}
                      aria-hidden="true"
                    />
                  </button>
                </div>
              </div>
            </div>

            {/* Intelligence */}
            <div className="rounded-2xl border border-line bg-surface px-5 py-4">
              <div className="kicker font-mono">Intelligence</div>
              <ul className="mt-3 space-y-[9px]">
                {CAPABILITIES.map((c) => (
                  <li key={c.label} className="flex items-start gap-2.5">
                    <span className="mt-px grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border border-brand/50 text-brand" aria-hidden="true">
                      <svg viewBox="0 0 10 10" fill="none" className="h-2 w-2"><path d="M5 1v8M1 5h8M2.2 2.2l5.6 5.6M7.8 2.2L2.2 7.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
                    </span>
                    <div className="min-w-0">
                      <div className="text-[12px] font-semibold leading-tight text-ink">{c.label}</div>
                      <div className="mt-0.5 truncate font-mono text-[9.5px] text-ink-faint">{c.hint}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </aside>
      </div>

      {/* ── Self-hosted banner ─────────────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-line bg-surface mt-[18px] overflow-hidden px-7 py-6 sm:px-8">
        <div className="flex flex-col items-center gap-8 lg:flex-row">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/agent/agent-cube.png"
            alt=""
            aria-hidden="true"
            className="hidden h-[176px] w-auto shrink-0 select-none md:block [mask-image:radial-gradient(ellipse_75%_75%_at_center,black_55%,transparent_98%)]"
            draggable={false}
          />
          <div className="min-w-0 flex-1">
            <div className="kicker font-mono text-brand">Self-hosted · 24/7</div>
            <h2 className="mt-1.5 font-display text-[27px] font-bold tracking-tight text-ink">Run your own agent, around the clock</h2>
            <p className="mt-2 max-w-2xl text-[12.5px] leading-relaxed text-ink-soft">
              The autopilot above only works while this page is open. To enter epochs around the clock, run the
              same agent yourself - on your computer or any server. It is the exact program that powers Limen&apos;s
              own agent, and it obeys the mandate you set above as hard rules. Never a view you disallowed, never
              below your odds floor, never more than <span className="font-semibold text-ink">${mandate.maxStakeUsdc}</span> per
              entry, and it shuts itself off when the mandate expires.
            </p>
            <a
              href="/guides/limen-self-hosted-agent.md"
              target="_blank"
              rel="noreferrer"
              className="mt-2.5 inline-flex items-center gap-1.5 text-[13px] font-semibold text-brand underline decoration-brand/50 underline-offset-4 hover:decoration-brand"
            >
              View the complete beginner guide <span aria-hidden="true">→</span>
            </a>
          </div>
          <div className="w-full shrink-0 space-y-3 lg:w-[440px]">
            <a
              href="/guides/limen-self-hosted-agent.md"
              download="limen-self-hosted-agent.md"
              className="flex w-full items-center justify-center gap-2.5 rounded-xl bg-brand px-6 py-3.5 font-mono text-[14px] font-bold text-white shadow-[0_8px_30px_rgb(229_72_77/0.3)] transition-opacity hover:opacity-90"
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-[17px] w-[17px]" aria-hidden="true">
                <path d="M12 3v11m0 0l-4-4m4 4l4-4M4 20h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Download the beginner guide (.md)
            </a>
            <button
              type="button"
              onClick={() => void copyUnattendedConfig()}
              className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-line px-6 py-3 font-mono text-[13.5px] font-semibold text-ink-soft transition-colors hover:border-brand/50 hover:text-ink"
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                <rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.8" />
                <path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" stroke="currentColor" strokeWidth="1.8" />
              </svg>
              {copied ? 'Copied ✓' : 'Copy my agent config (.env)'}
            </button>
            <p className="text-center font-mono text-[11px] text-ink-faint">The config is compiled live from your mandate above.</p>
          </div>
        </div>
      </section>
    </div>
  );
}
