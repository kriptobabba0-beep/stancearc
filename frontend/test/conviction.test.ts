import { describe, it, expect } from 'vitest';
import { parseConvictionInput, type ConvictionParse } from '@/lib/conviction';

// parseConvictionInput turns a raw text USDC amount into a 6dp bigint and validates it against the
// market's [minConv, maxConv] bounds, returning a structured ok/error result the form renders. USDC is
// always 6dp (hard-asserted at boot), so we parse at 6dp here.
const BOUNDS = { minConv: 100_000000n, maxConv: 1_000_000000n };

function expectError(r: ConvictionParse): asserts r is Extract<ConvictionParse, { ok: false }> {
  expect(r.ok).toBe(false);
}
function expectOk(r: ConvictionParse): asserts r is Extract<ConvictionParse, { ok: true }> {
  expect(r.ok).toBe(true);
}

describe('parseConvictionInput', () => {
  it('parses a plain integer USDC amount to 6dp base units', () => {
    const r = parseConvictionInput('250', BOUNDS);
    expectOk(r);
    expect(r.value).toBe(250_000000n);
  });

  it('parses a fractional USDC amount to 6dp base units', () => {
    const r = parseConvictionInput('100.5', BOUNDS);
    expectOk(r);
    expect(r.value).toBe(100_500000n);
  });

  it('accepts the exact min and max bounds (inclusive)', () => {
    const lo = parseConvictionInput('100', BOUNDS);
    const hi = parseConvictionInput('1000', BOUNDS);
    expectOk(lo);
    expectOk(hi);
    expect(lo.value).toBe(BOUNDS.minConv);
    expect(hi.value).toBe(BOUNDS.maxConv);
  });

  it('rejects an empty / whitespace input', () => {
    expectError(parseConvictionInput('', BOUNDS));
    expectError(parseConvictionInput('   ', BOUNDS));
  });

  it('rejects a non-numeric input', () => {
    expectError(parseConvictionInput('abc', BOUNDS));
    expectError(parseConvictionInput('1.2.3', BOUNDS));
  });

  it('rejects an amount below minConv with a bounds message', () => {
    const r = parseConvictionInput('50', BOUNDS);
    expectError(r);
    expect(r.error).toMatch(/at least|min/i);
  });

  it('rejects an amount above maxConv with a bounds message', () => {
    const r = parseConvictionInput('2000', BOUNDS);
    expectError(r);
    expect(r.error).toMatch(/at most|max/i);
  });

  it('rejects sub-6dp precision (more than 6 fractional digits)', () => {
    expectError(parseConvictionInput('100.1234567', BOUNDS));
  });

  it('rejects a negative amount', () => {
    expectError(parseConvictionInput('-100', BOUNDS));
  });
});
