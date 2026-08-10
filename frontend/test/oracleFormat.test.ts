import { describe, it, expect } from 'vitest';
import { formatPythPrice, formatUnixTime } from '@/lib/oracleFormat';

describe('formatPythPrice — int64 price × 10^expo with trailing-zero trim', () => {
  it('expo -8: 10_000_000_000_000 → 100000 (BTC ~ $100k)', () => {
    // 1e13 at expo -8 = 100000.00000
    expect(formatPythPrice(10_000_000_000_000n, -8n)).toBe('100000');
  });
  it('expo -8: keeps fractional digits, trims trailing zeros', () => {
    // 10_000_012_345_678 at -8 = 100000.12345678
    expect(formatPythPrice(10_000_012_345_678n, -8n)).toBe('100000.12345678');
  });
  it('expo -5: 1_234_567 → 12.34567', () => {
    expect(formatPythPrice(1_234_567n, -5n)).toBe('12.34567');
  });
  it('a non-negative expo scales up (rare for Pyth but handled)', () => {
    expect(formatPythPrice(5n, 2n)).toBe('500');
  });
  it('zero → "0"', () => {
    expect(formatPythPrice(0n, -8n)).toBe('0');
  });
  it('negative price keeps the sign', () => {
    expect(formatPythPrice(-1_234_567n, -5n)).toBe('-12.34567');
  });
});

describe('formatUnixTime — UTC ISO-ish label', () => {
  it('formats a unix-seconds timestamp as a readable UTC string', () => {
    // 2021-01-01T00:00:00Z = 1609459200
    expect(formatUnixTime(1_609_459_200n)).toBe('2021-01-01 00:00:00 UTC');
  });
  it('zero/undefined → em-dash', () => {
    expect(formatUnixTime(0n)).toBe('—');
    expect(formatUnixTime(undefined)).toBe('—');
  });
});
