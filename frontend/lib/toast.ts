// lib/toast.ts - centralized re-export of the toast API (sonner) so every write hook imports from a
// single place. Keeping this thin shim lets tests mock `@/lib/toast` (instead of `sonner` directly)
// and gives us one spot to tweak default options / wording helpers later.
//
// Usage in a write hook (keyed so a single action's toast updates in place):
//   import { toast } from '@/lib/toast';
//   const id = 'mint';                       // stable per-action id
//   toast.loading('Providing liquidity…', { id, description: arcScanLink(hash) });
//   toast.success('Liquidity added - position minted', { id });
//   toast.error(friendlyError(e), { id });
import { toast } from 'sonner';
import { ENV } from '@/lib/env';

export { toast };

/** Human-readable ArcScan tx link used in a toast's `description` (best-effort; safe if URL missing). */
export function arcScanTxUrl(hash?: `0x${string}`): string | undefined {
  if (!hash) return undefined;
  try {
    return `${ENV.EXPLORER_URL}/tx/${hash}`;
  } catch {
    return undefined;
  }
}
