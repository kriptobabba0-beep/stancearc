// lib/conviction.ts — FeeArena v2 conviction-input parsing + bounds validation.
//
// The v2 stake form takes a human USDC amount (the at-risk conviction) and must turn it into the 6dp
// base-units bigint the arena expects, validated against the market's [minConv, maxConv]. USDC is
// always 6dp (hard-asserted at boot), so we parse at 6dp. Pure + framework-free so it is unit-testable
// in isolation and reused by the form. Returns a structured ok/error result the UI renders inline.
import { parseUnits } from 'viem';
import { formatUSDC } from '@/lib/format';

export const USDC_DECIMALS = 6;

export interface ConvictionBoundsInput {
  minConv: bigint;
  maxConv: bigint;
}

export type ConvictionParse =
  | { ok: true; value: bigint }
  | { ok: false; error: string };

// A USDC amount: optional leading sign-less integer part + up to 6 fractional digits.
const USDC_AMOUNT_RE = /^\d+(\.\d{1,6})?$/;

/**
 * Parse a raw text USDC amount into a 6dp bigint and validate it against the [minConv, maxConv] bounds.
 *  - empty/whitespace, non-numeric, negative, or >6 fractional digits -> { ok:false, error }
 *  - below minConv / above maxConv -> { ok:false, error } (message names the bound, formatted as USDC)
 *  - otherwise -> { ok:true, value } (6dp base units)
 */
export function parseConvictionInput(raw: string, bounds: ConvictionBoundsInput): ConvictionParse {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, error: 'Enter a conviction amount.' };
  if (!USDC_AMOUNT_RE.test(trimmed)) {
    return { ok: false, error: 'Enter a valid USDC amount (up to 6 decimal places).' };
  }
  let value: bigint;
  try {
    value = parseUnits(trimmed, USDC_DECIMALS);
  } catch {
    return { ok: false, error: 'Enter a valid USDC amount (up to 6 decimal places).' };
  }
  if (value < bounds.minConv) {
    return { ok: false, error: `Conviction must be at least ${formatUSDC(bounds.minConv)} USDC.` };
  }
  if (value > bounds.maxConv) {
    return { ok: false, error: `Conviction must be at most ${formatUSDC(bounds.maxConv)} USDC.` };
  }
  return { ok: true, value };
}
