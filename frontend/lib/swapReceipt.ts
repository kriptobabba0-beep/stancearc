// lib/swapReceipt.ts — what a finished swap actually paid out.
//
// The confirmation screen shows a number, and the honest number is the one the chain settled at,
// not the quote the user was shown before signing. On a thin pool those differ: the quote is a
// prediction made a block or two earlier, and anything that traded in between moves the fill.
// Quoting back the prediction would be telling the user what we expected rather than what
// happened, which is exactly the sort of small lie that costs trust when they check the explorer.
//
// So the amount is read from the receipt: the ERC-20 Transfer of the bought token INTO the
// recipient's own address. That log is emitted by the token itself as part of the swap, so it is
// the settled figure by definition.
//
// Reading it here, off the receipt we already wait for, also means no extra RPC call.

/** keccak256("Transfer(address,address,uint256)") — the ERC-20 Transfer topic. */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** The shape of a receipt log this reads; a subset of viem's, so a receipt can be passed straight in. */
export interface ReceiptLog {
  address: string;
  topics: readonly string[];
  data: string;
}

const sameAddr = (a: string | undefined, b: string | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** An indexed address topic is the address right-padded into 32 bytes. */
function topicIsAddress(topic: string | undefined, address: string): boolean {
  if (!topic || topic.length < 42) return false;
  return sameAddr(`0x${topic.slice(-40)}`, address);
}

/**
 * How much of `token` landed in `recipient` in this receipt.
 *
 * Sums every matching Transfer rather than taking the first: a router that fills across hops can
 * credit the recipient more than once, and the user's number is the total that reached them.
 * Returns null when the receipt carries no such transfer — the caller must then say nothing
 * rather than invent a figure.
 */
export function receivedAmount(
  logs: readonly ReceiptLog[] | undefined,
  token: string | undefined,
  recipient: string | undefined,
): bigint | null {
  if (!logs?.length || !token || !recipient) return null;
  let total = 0n;
  let seen = false;
  for (const log of logs) {
    if (!sameAddr(log.address, token)) continue;
    if (log.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (!topicIsAddress(log.topics?.[2], recipient)) continue; // topics[2] = `to`
    let value: bigint;
    try {
      value = BigInt(log.data);
    } catch {
      continue; // a malformed log is not a payout
    }
    total += value;
    seen = true;
  }
  return seen ? total : null;
}
