'use client';

// components/arena/useArenaFlow.ts - the Arena entry journey's shared state machine. ONE instance is
// created by the Arena page and passed to the right-rail + the three modals so selection, side, and
// which modal is open stay in sync. Derives the current step from live wallet/LP/stake state:
//
//   add-liquidity  → connected (or not) but no stakeable LP position yet      (mockups 1-2)
//   choose-side    → has a stakeable position, not yet staked this epoch      (mockups 3-5)
//   staked         → already staked a side this epoch                         (mockup 6)
//
// All reads are the existing hooks (useOwnedPositions / useUserStakes / useCurrentEpoch) - no new
// contract wiring. The contract's OneSidePerEpoch rule still governs on-chain; this flow models the
// single-position happy path the mockups show.
import { useEffect, useMemo, useState } from 'react';
import { useAccount } from 'wagmi';
import { useCurrentEpoch } from '@/hooks/useCurrentEpoch';
import { useOwnedPositions } from '@/hooks/useOwnedPositions';
import { useUserStakes } from '@/hooks/useUserStakes';
import { isValidStakeSide } from '@/lib/side';
import { PhaseView, Side, type EpochView, type OwnedPosition, type StakeView } from '@/lib/types';

export type ArenaModal = 'add-liquidity' | 'choose-side' | 'stake-review' | null;
export type ArenaStep = 'add-liquidity' | 'choose-side' | 'staked';

export interface ArenaFlow {
  isConnected: boolean;
  address?: `0x${string}`;
  epoch?: EpochView;
  entryOpen: boolean;
  stakeable: OwnedPosition[];
  hasLiquidity: boolean;
  loadingPositions: boolean;
  currentStake?: StakeView;
  isStaked: boolean;
  step: ArenaStep;
  selectedTokenId?: bigint;
  selectedPosition?: OwnedPosition;
  setSelectedTokenId: (id: bigint) => void;
  selectedSide: Side;
  setSelectedSide: (s: Side) => void;
  modal: ArenaModal;
  openModal: (m: Exclude<ArenaModal, null>) => void;
  closeModal: () => void;
}

export function useArenaFlow(): ArenaFlow {
  const { address, isConnected } = useAccount();
  const { data: epoch } = useCurrentEpoch();
  const { data: positions, isLoading: loadingPositions } = useOwnedPositions();
  const { data: stakes } = useUserStakes(address);

  const [modal, setModal] = useState<ArenaModal>(null);
  const [selectedTokenId, setSelectedTokenIdState] = useState<bigint | undefined>(undefined);
  const [selectedSide, setSelectedSide] = useState<Side>(Side.NONE);

  const stakeable = useMemo(() => positions ?? [], [positions]);
  const hasLiquidity = stakeable.length > 0;

  // The user's stake in the CURRENT epoch (still held - not unstaked) fixes the "staked" state.
  const currentStake = useMemo<StakeView | undefined>(() => {
    if (!epoch) return undefined;
    return (stakes ?? []).find(
      (s) => s.epochId === epoch.epochId && !s.unstaked && isValidStakeSide(s.side),
    );
  }, [stakes, epoch]);
  const isStaked = !!currentStake;
  const entryOpen = epoch?.phase === PhaseView.EntryOpen;

  // Keep a valid default selection: first stakeable position, re-pointed if the current one disappears
  // (e.g. it was just staked, or a fresh mint replaced the list).
  useEffect(() => {
    if (stakeable.length === 0) return;
    if (selectedTokenId === undefined || !stakeable.some((p) => p.tokenId === selectedTokenId)) {
      setSelectedTokenIdState(stakeable[0].tokenId);
    }
  }, [stakeable, selectedTokenId]);

  const selectedPosition = stakeable.find((p) => p.tokenId === selectedTokenId);
  const step: ArenaStep = isStaked ? 'staked' : hasLiquidity ? 'choose-side' : 'add-liquidity';

  return {
    isConnected,
    address,
    epoch,
    entryOpen,
    stakeable,
    hasLiquidity,
    loadingPositions,
    currentStake,
    isStaked,
    step,
    selectedTokenId,
    selectedPosition,
    setSelectedTokenId: setSelectedTokenIdState,
    selectedSide,
    setSelectedSide,
    modal,
    openModal: (m) => setModal(m),
    closeModal: () => setModal(null),
  };
}
