// hooks/useDecimals.ts - exposes cached boot decimals; throws if the gate has not passed.
import { getBootDecimals } from '@/lib/decimals';
import type { BootDecimals } from '@/lib/types';

export function useDecimals(): BootDecimals {
  // Reads the cached snapshot set by the providers boot gate. Throwing here surfaces a
  // programming error (a money/format component mounted before the gate ran).
  return getBootDecimals();
}
