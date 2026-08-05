// app/api/agent/chat/route.ts - the Limen Copilot conversation endpoint.
//
// POST { messages: [{role, content}], address?, marketId } -> Server-Sent Events:
//   {type:'text',   delta}                    streamed assistant prose
//   {type:'tool',   name, status}             tool activity ('start' | 'done') for the UI chips
//   {type:'action', action}                   a proposed transaction awaiting USER confirmation
//   {type:'done'} | {type:'error', message}
//
// The route runs Claude with tool-use in a bounded server-side loop: read-tools (market
// state, odds, positions, knowledge) execute HERE between model turns; `propose_action`
// never executes - it is validated and forwarded to the client, where the user confirms and
// the app's existing transaction hooks sign. History arrives as plain text turns (the client
// does not replay tool internals), so the model re-reads live state each turn - always fresh.
// Without ANTHROPIC_API_KEY the endpoint reports 'not_configured' and the page shows an
// honest offline card instead of a broken chat.
import { systemPrompt, COPILOT_TOOLS, runCopilotTool, validateActionProposal } from '@/lib/agent/copilot';
import { checkQuota, type QuotaEntry } from '@/lib/agent/quota';
import { loadX402Config, payment402Body, parsePaymentHeader, buildPaymentRequirements, verifyPayment, settlePayment, encodeBase64Json, type X402Config } from '@/lib/agent/x402';

export const dynamic = 'force-dynamic';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MAX_ROUNDS = 6;
const MAX_TURNS = 24;
const MAX_CHARS = 4_000;

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type ContentBlock = { type: 'text'; text: string } | ToolUseBlock;

function sse(controller: ReadableStreamDefaultController<Uint8Array>, payload: unknown): void {
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
}

/** One streaming Anthropic call; text deltas go to the client as they arrive. */
async function streamModelTurn(
  apiKey: string,
  model: string,
  system: string,
  convo: Array<{ role: string; content: unknown }>,
  controller: ReadableStreamDefaultController<Uint8Array>,
): Promise<{ blocks: ContentBlock[]; stopReason: string }> {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system,
      tools: COPILOT_TOOLS,
      messages: convo,
      stream: true,
    }),
    signal: AbortSignal.timeout(55_000),
  });
  if (!res.ok || res.body === null) {
    const detail = await res.text().catch(() => '');
    throw new Error(`model call failed (${res.status}): ${detail.slice(0, 200)}`);
  }

  const blocks: ContentBlock[] = [];
  let stopReason = 'end_turn';
  let currentTool: { id: string; name: string; json: string } | null = null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (raw === '' || raw === '[DONE]') continue;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      const t = ev.type as string;
      if (t === 'content_block_start') {
        const cb = ev.content_block as { type: string; id?: string; name?: string } | undefined;
        if (cb?.type === 'tool_use') {
          currentTool = { id: cb.id ?? '', name: cb.name ?? '', json: '' };
          sse(controller, { type: 'tool', name: currentTool.name, status: 'start' });
        } else if (cb?.type === 'text') {
          blocks.push({ type: 'text', text: '' });
        }
      } else if (t === 'content_block_delta') {
        const d = ev.delta as { type: string; text?: string; partial_json?: string } | undefined;
        if (d?.type === 'text_delta' && typeof d.text === 'string') {
          const last = blocks[blocks.length - 1];
          if (last && last.type === 'text') last.text += d.text;
          sse(controller, { type: 'text', delta: d.text });
        } else if (d?.type === 'input_json_delta' && currentTool !== null && typeof d.partial_json === 'string') {
          currentTool.json += d.partial_json;
        }
      } else if (t === 'content_block_stop') {
        if (currentTool !== null) {
          let input: Record<string, unknown> = {};
          try {
            input = currentTool.json.trim() === '' ? {} : (JSON.parse(currentTool.json) as Record<string, unknown>);
          } catch {
            input = {};
          }
          blocks.push({ type: 'tool_use', id: currentTool.id, name: currentTool.name, input });
          currentTool = null;
        }
      } else if (t === 'message_delta') {
        const dd = ev.delta as { stop_reason?: string } | undefined;
        if (dd?.stop_reason) stopReason = dd.stop_reason;
      }
    }
  }
  return { blocks, stopReason };
}

// Cost bound: a per-wallet (or per-IP) daily message quota (lib/agent/quota). In-memory per
// isolate - a soft cap, deliberately simple until x402 nanopayments become the real billing
// layer (see docs/AGENT.md "Paying for the copilot").
const quota = new Map<string, QuotaEntry>();

// Master switch: on by default; set AGENT_ENABLED=false to park the copilot (the page shows
// its offline card and POST refuses) - a hard stop on model spend without touching the key.
const agentEnabled = (): boolean => process.env.AGENT_ENABLED !== 'false';

// Models users may pick from. AGENT_MODELS (comma-separated) overrides; the first entry is
// the default. Requests asking for anything off-list get the default - never a free choice
// of arbitrary (pricier) models.
function allowedModels(): string[] {
  const csv = (process.env.AGENT_MODELS ?? '').trim();
  const primary = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';
  const list = csv !== '' ? csv.split(',').map((s) => s.trim()).filter((s) => s !== '') : [primary, 'claude-haiku-4-5-20251001'];
  return [...new Set(list)];
}

/** GET - the copilot's status card: configured?, which model, today's quota, billing. */
export function GET(): Response {
  const configured = agentEnabled() && Boolean(process.env.ANTHROPIC_API_KEY);
  const x402 = loadX402Config();
  const models = allowedModels();
  return Response.json({
    configured,
    model: configured ? models[0] : null,
    models: configured ? models : [],
    dailyLimit: Number(process.env.AGENT_DAILY_MSG_LIMIT ?? (x402.enabled ? 20 : 40)),
    x402: x402.enabled ? { enabled: true, priceUsdc6: x402.amount } : { enabled: false },
  });
}

export async function POST(req: Request): Promise<Response> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!agentEnabled() || !apiKey) {
    return Response.json({ error: 'not_configured' }, { status: 503 });
  }

  // Bound the request body - a chat turn is a few KB; anything huge is abuse.
  if (Number(req.headers.get('content-length') ?? 0) > 131_072) {
    return Response.json({ error: 'request too large' }, { status: 413 });
  }

  let body: {
    messages?: ChatTurn[];
    address?: string;
    marketId?: string;
    model?: string;
    sessionAddress?: unknown;
    pastSessionAddresses?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  // A connected wallet is required to chat: the copilot's personal tools are wallet-scoped,
  // and anonymous traffic must not be able to spend the model budget at all. (The address
  // is client-attested; the IP-keyed quota + x402 billing remain the hard cost bounds.)
  if (typeof body.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(body.address)) {
    return Response.json({ error: 'wallet_required' }, { status: 401 });
  }

  const turns = (body.messages ?? [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim() !== '')
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  if (turns.length === 0 || turns[turns.length - 1].role !== 'user') {
    return Response.json({ error: 'messages must end with a user turn' }, { status: 400 });
  }
  const isAddr = (a: unknown): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
  const ctx = {
    address: body.address,
    sessionAddress: isAddr(body.sessionAddress) ? body.sessionAddress : undefined,
    pastSessionAddresses: Array.isArray(body.pastSessionAddresses)
      ? (body.pastSessionAddresses as unknown[]).filter(isAddr).slice(0, 3)
      : undefined,
    marketId: body.marketId ?? 'cirbtc',
  };
  const system = systemPrompt(ctx);
  const models = allowedModels();
  const model = typeof body.model === 'string' && models.includes(body.model) ? body.model : models[0]!;

  // Billing model: a free daily quota first; past it, x402 nanopayments take over when
  // enabled (a paid message bypasses the quota). x402 off -> the quota 429s as before.
  const x402 = loadX402Config();
  const respond402 = (cfg: X402Config, error: string): Response => {
    const bodyJson = payment402Body(cfg, error, req.url);
    return Response.json(bodyJson, { status: 402, headers: { 'PAYMENT-REQUIRED': encodeBase64Json(bodyJson) } });
  };

  let paid = false;
  let settleReceipt: string | null = null;
  if (x402.enabled) {
    // Circle's reference buyer sends Payment-Signature; plain x402 clients send X-PAYMENT.
    const payment = parsePaymentHeader(req.headers.get('payment-signature') ?? req.headers.get('x-payment'));
    if (payment !== null) {
      try {
        const requirements = buildPaymentRequirements(x402);
        const v = await verifyPayment(x402, payment, requirements);
        if (!v.isValid) {
          return respond402(x402, v.invalidReason ?? 'payment rejected');
        }
        // Settle before serving (sub-cent, batched by Circle) so the receipt can travel
        // back in the PAYMENT-RESPONSE header of this very response.
        const s = await settlePayment(x402, payment, requirements);
        if (!s.success) {
          return respond402(x402, `settlement failed: ${s.errorReason ?? 'unknown'}`);
        }
        settleReceipt = encodeBase64Json(s);
        paid = true;
      } catch (err) {
        // Facilitator outage must not brick the copilot - fall back to the quota bound.
        console.error('x402 facilitator unavailable:', err instanceof Error ? err.message : String(err));
      }
    }
  }

  // With billing ON, a small daily free allowance (20) covers trying the copilot out -
  // beyond it every message pays. AGENT_DAILY_MSG_LIMIT overrides (0 = pay from the first
  // message). With billing OFF the daily quota is the only cost bound, as before.
  const limit = Number(process.env.AGENT_DAILY_MSG_LIMIT ?? (x402.enabled ? 20 : 40));
  // Keyed by the CDN-attested client IP first: the wallet address is client-supplied and
  // unauthenticated, so keying on it first would let anyone farm the free tier by rotating
  // fabricated addresses. Address is only the fallback when no IP header exists (local dev).
  const quotaKey = req.headers.get('cf-connecting-ip') ?? body.address ?? 'anon';
  if (!paid && !checkQuota(quota, quotaKey, Date.now(), limit)) {
    if (x402.enabled) {
      return respond402(
        x402,
        limit > 0
          ? `free daily quota (${limit} messages) exhausted - pay per message to continue`
          : 'this copilot is pay-per-message - each message settles in USDC over Circle x402',
      );
    }
    return Response.json({ error: 'quota', limit }, { status: 429 });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const convo: Array<{ role: string; content: unknown }> = [...turns];
        for (let round = 0; round < MAX_ROUNDS; round += 1) {
          const { blocks, stopReason } = await streamModelTurn(apiKey, model, system, convo, controller);

          if (stopReason !== 'tool_use') break;

          // Execute the read tools; forward any action proposal to the user and END the turn
          // (the confirmation card is now the conversation's next move).
          const toolUses = blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use');
          let proposed = false;
          const results: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];
          for (const tu of toolUses) {
            if (tu.name === 'propose_action') {
              const v = validateActionProposal(tu.input, ctx.marketId);
              if ('error' in v) {
                results.push({ type: 'tool_result', tool_use_id: tu.id, content: `invalid proposal: ${v.error}` });
              } else {
                sse(controller, { type: 'action', action: v });
                proposed = true;
              }
              continue;
            }
            const out = await runCopilotTool(tu.name, tu.input, ctx);
            sse(controller, { type: 'tool', name: tu.name, status: 'done' });
            results.push({ type: 'tool_result', tool_use_id: tu.id, content: out });
          }
          if (proposed) break;

          // Drop empty text blocks (a text block may open without deltas) - the API rejects them.
          convo.push({ role: 'assistant', content: blocks.filter((b) => b.type !== 'text' || b.text !== '') });
          convo.push({ role: 'user', content: results });
        }
        sse(controller, { type: 'done' });
      } catch (err) {
        sse(controller, { type: 'error', message: err instanceof Error ? err.message : 'copilot unavailable' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // Paid message: the settlement receipt rides back per Circle's buyer protocol.
      ...(settleReceipt !== null ? { 'PAYMENT-RESPONSE': settleReceipt } : {}),
    },
  });
}
