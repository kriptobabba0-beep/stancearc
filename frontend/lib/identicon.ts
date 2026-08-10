// lib/identicon.ts — deterministic on-chain avatars for the leaderboard: every address gets
// a 5×5 vertically-mirrored pixel mark (blockies-style) in one of the arena's accent hues.
// Pure address-bytes → cells/color, so the same wallet looks the same on every device — no
// uploads, no external avatar service, nothing to moderate.

/** Accent palette tuned for the dark canvas (vivid, distinguishable, no muddy mid-tones). */
export const IDENTICON_COLORS = [
  '#E5484D', // crimson
  '#E8AE1F', // gold
  '#2DD4BF', // teal
  '#8B5CF6', // violet
  '#38BDF8', // sky
  '#34D399', // green
  '#F472B6', // pink
  '#FB923C', // amber
] as const;

export interface Identicon {
  /** 25 cells, row-major 5×5; columns 3/4 mirror columns 1/0. */
  cells: boolean[];
  color: string;
}

/** Address → bytes (20). Non-hex input still yields a stable (all-zero) fallback. */
function addressBytes(address: string): number[] {
  const hex = address.toLowerCase().replace(/^0x/, '').padEnd(40, '0').slice(0, 40);
  const out: number[] = [];
  for (let i = 0; i < 40; i += 2) {
    const b = parseInt(hex.slice(i, i + 2), 16);
    out.push(Number.isNaN(b) ? 0 : b);
  }
  return out;
}

/**
 * Deterministic identicon for an address. The left 3 columns come from the first 15 bytes'
 * parity (bit 0 xor bit 4 keeps neighbouring addresses from looking alike); the right 2
 * columns mirror the left for the face-like symmetry that makes marks memorable.
 */
export function identiconFor(address: string): Identicon {
  const bytes = addressBytes(address);
  const color = IDENTICON_COLORS[bytes[0] % IDENTICON_COLORS.length];
  const cells = new Array<boolean>(25).fill(false);
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 3; col++) {
      const b = bytes[(row * 3 + col) % bytes.length] ^ bytes[(row * 3 + col + 7) % bytes.length];
      const on = (b & 1) === 1 || (b & 16) === 16 ? (b % 3) !== 0 : false;
      cells[row * 5 + col] = on;
      cells[row * 5 + (4 - col)] = on; // mirror
    }
  }
  // Guarantee a visible mark even for pathological inputs (all-off looks like a bug).
  if (!cells.some(Boolean)) {
    cells[7] = cells[11] = cells[12] = cells[13] = cells[17] = true;
  }
  return { cells, color };
}

// ── Compact money formatting for standings (…$22.5M style) ─────────────────────────────

/** usd6 → compact display: $807.70 / $22.5k / $7.2M (floor, one decimal for k/M). */
export function compactUsd6(v: bigint, symbol = '$'): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const sign = neg ? '−' : '';
  const M = 1_000_000n;
  if (abs >= 1_000_000n * M) {
    const tenth = abs / (100_000n * M); // value in 0.1M units
    return `${sign}${symbol}${(Number(tenth) / 10).toFixed(1)}M`;
  }
  if (abs >= 1_000n * M) {
    const tenth = abs / (100n * M); // value in 0.1k units
    return `${sign}${symbol}${(Number(tenth) / 10).toFixed(1)}k`;
  }
  if (abs > 0n && abs < 10_000n) {
    // Sub-cent (testnet dust is real money here): four decimals beat a misleading $0.00.
    return `${sign}${symbol}${(Number(abs) / 1_000_000).toFixed(4)}`;
  }
  const cents = abs / 10_000n;
  return `${sign}${symbol}${(Number(cents) / 100).toFixed(2)}`;
}

/** PnL display with an explicit sign: +$12.3k / −$4.10 / $0.00 for zero. */
export function signedCompactUsd6(v: bigint, symbol = '$'): string {
  if (v === 0n) return `${symbol}0.00`;
  const body = compactUsd6(v < 0n ? -v : v, symbol);
  return v > 0n ? `+${body}` : `−${body}`;
}
