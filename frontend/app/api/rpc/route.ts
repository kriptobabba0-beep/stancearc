// app/api/rpc/route.ts - edge JSON-RPC cache/proxy for the Arc testnet RPC.
// All logic lives in lib/rpcProxy.ts (route files only export HTTP handlers). The browser's
// wagmi transport points here FIRST; the direct Arc endpoints stay in the fallback chain, so
// if this route is ever down the app behaves exactly as before the proxy existed.
import { NextResponse } from 'next/server';
import { handleRpcPayload } from '@/lib/rpcProxy';

export const runtime = 'nodejs';

const MAX_BODY_BYTES = 256 * 1024;

export async function POST(req: Request): Promise<NextResponse> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return NextResponse.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'unreadable body' } }, { status: 400 });
  }
  if (text.length > MAX_BODY_BYTES) {
    return NextResponse.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'body too large' } }, { status: 413 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return NextResponse.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'invalid JSON' } }, { status: 400 });
  }
  const body = await handleRpcPayload(payload);
  return NextResponse.json(body, {
    // JSON-RPC results/errors always ride a 200; transport-level failures are for real transport problems.
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}

/** Tiny health probe so a human (or uptime check) can see the proxy is alive. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true, service: 'arc-rpc-proxy' });
}
