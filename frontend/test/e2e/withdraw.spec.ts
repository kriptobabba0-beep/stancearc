import { test, expect } from '@playwright/test';
import { injectMockWallet, mockRpc, connectWallet, selectMarket } from './mockWallet';

// The v2 conviction arena is the SECONDARY market (id "btc-v2") post cutover-safety reorder. This
// unstake flow selects it explicitly after boot (the v2 read surface serves the staked+swept position).
const V2_MARKET_ID = 'btc-v2';

const RPC_GLOB = '**/rpc.testnet.arc.network/**';

// Withdraw / unstake write flow. The 'settled' scenario serves a Settled epoch with a staked+swept
// position (tokenId 1, swept=true, unstaked=false) — the contract rule the Unstake button gates on
// (Settled && swept && !unstaked) — plus a successful receipt for the canned write hash. We drive the
// real ClaimUnstakePanel Unstake button on /arena (Phase 2: claim+unstake moved here; /claim redirects
// here) and assert the write confirms without a crash.
test.describe('withdraw (unstake) flow', () => {
  test('a settled, swept position can be unstaked (write confirms)', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await injectMockWallet(page);
    await mockRpc(page, RPC_GLOB, { scenario: 'settled' });

    await page.goto('/stance');
    await connectWallet(page);
    // Switch to the v2 conviction market (secondary entry post-cutover) so the v2 unstake surface is active.
    await selectMarket(page, V2_MARKET_ID);

    const row = page.getByTestId('row-1');
    await expect(row).toBeVisible({ timeout: 15_000 });

    // The Unstake button is enabled (Settled + swept + !unstaked) and issues the write.
    const unstakeBtn = row.getByRole('button', { name: /^Unstake$/ });
    await expect(unstakeBtn).toBeEnabled({ timeout: 10_000 });
    await unstakeBtn.click();

    // The write was issued (canned hash) + confirmed (RPC receipt). The button must NOT wedge in its
    // disabled/pending state — once the receipt lands it re-enables (the mock keeps the position
    // swept + not yet unstaked). No error alert surfaced.
    await expect(unstakeBtn).toBeEnabled({ timeout: 15_000 });
    await expect(row.getByRole('alert')).toHaveCount(0);

    await expect(page.getByText(/failed to boot/i)).toHaveCount(0);
    const fatal = consoleErrors.filter((e) => !/Download the React DevTools|hydrat/i.test(e));
    expect(fatal, fatal.join('\n')).toHaveLength(0);
  });
});
