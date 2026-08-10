// lib/campaignMeta.ts — the human-facing bits of a campaign that aren't numbers.
//
// Kept apart from leaderboardStore because that module reaches for the Workers KV binding and so
// can only run on the server, while the campaign pages need these in the browser too.

/**
 * Arc's block time, for turning a block distance into words a reader can act on.
 *
 * Approximate on purpose: it is used for "ends in about 20 min", never for anything that decides
 * a result. Every figure that decides one is measured in blocks.
 */
export const ARC_SECONDS_PER_BLOCK = 0.517;

/** The id a campaign publishes under, made readable when no explicit title was configured. */
export function campaignTitle(id: string, explicit?: string | null): string {
  const given = explicit?.trim();
  if (given) return given;
  // Ids are operator-typed slugs like "aug" or "test1h". Turning one into a title is a fallback,
  // not a feature — the point is that a campaign never shows up on the index page nameless.
  const words = id
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([0-9])/gi, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return 'Campaign';
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * How far through its block range a campaign is, 0..1.
 *
 * Blocks rather than clock time, because the campaign's own boundaries are blocks and the
 * standings only move when blocks are folded in. Returns null when there is nothing sensible to
 * show: an open-ended campaign, or a range that hasn't started.
 */
export function campaignProgress(startBlock: string, endBlock: string, cursor: string): number | null {
  try {
    // Checked before converting because BigInt('') is 0n rather than an error, and a missing
    // cursor read as block zero would draw an empty bar on a campaign that may be half over.
    // Absent is not the same as "hasn't started".
    if (!startBlock?.trim() || !endBlock?.trim() || !cursor?.trim()) return null;
    const start = BigInt(startBlock);
    const end = BigInt(endBlock);
    const at = BigInt(cursor);
    if (end <= start) return null; // open-ended (endBlock 0) or malformed
    if (at <= start) return 0;
    if (at >= end) return 1;
    const span = end - start;
    // Scaled to an integer before converting, so a long range doesn't lose the fraction.
    return Number(((at - start) * 10_000n) / span) / 10_000;
  } catch {
    return null;
  }
}
