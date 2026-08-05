// app/claim/page.tsx - permanent redirect to /arena.
//
// Phase 2: claim + unstake (<ClaimUnstakePanel/>) now lives inside the Arena page. This stub keeps the
// old /claim URL (the win-moment banner / shared links pointed here) working by redirecting on the
// server to /arena, where the claim panel is anchored at #claim.
import { redirect } from 'next/navigation';

export default function ClaimRedirect() {
  redirect('/stance');
}
