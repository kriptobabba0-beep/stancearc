// app/leaderboard/layout.tsx — segment metadata (the page itself is a client component).
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Leaderboard - Limen Finance',
  description:
    'Standings on Arc: who moves the market and who takes the fee pool home. Volume and PnL, rebuilt from on-chain events - every rank verifiable on ArcScan.',
};

export default function LeaderboardLayout({ children }: { children: ReactNode }) {
  return children;
}
