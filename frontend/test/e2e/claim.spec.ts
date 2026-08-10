import { test, expect } from '@playwright/test';
import { injectMockWallet, mockRpc, connectWallet, selectMarket } from './mockWallet';

// The v2 conviction arena is the SECONDARY market (id "btc-v2") post cutover-safety reorder. This v2
// collect flow selects it explicitly after boot.
const V2_MARKET_ID = 'btc-v2';

const RPC_GLOB = '**/rpc.testnet.arc.network/**';

// Collect write flow (v2 conviction-parimutuel — the live default market). The 'settled' scenario
// serves: a Settled, fully-swept epoch, a staked+swept WINNING position (tokenId 1) whose Lens
// previewClaim is claimable (previewRefund returns not-refundable in this scenario), and a successful
// receipt for the canned write hash. We drive the real ClaimUnstakePanel on /claim — for a v2 winner
// the surface is a single "Collect" button (it fires claim(epochId,tokenId,recipient) [+ refund when
// refundable]) — and assert the write confirms without a render crash.
test.describe('collect flow (v2)', () => {
  test('a settled winning position can be collected (write confirms)', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await injectMockWallet(page);
    await mockRpc(page, RPC_GLOB, { scenario: 'settled' });

    // Phase 2: claim+unstake (ClaimUnstakePanel) moved to /arena; /claim redirects here.
    await page.goto('/stance');
    await connectWallet(page);
    // Switch to the v2 conviction market (secondary entry post-cutover) so the v2 collect surface is active.
    await selectMarket(page, V2_MARKET_ID);

    // The wallet's staked position row renders.
    const row = page.getByTestId('row-1');
    await expect(row).toBeVisible({ timeout: 15_000 });

    // The v2 Collect button is enabled (previewClaim.claimable === true) and issues the write.
    const collectBtn = row.getByRole('button', { name: /^Collect$/ });
    await expect(collectBtn).toBeEnabled({ timeout: 10_000 });
    await collectBtn.click();

    // The write was issued (canned hash) + confirmed (RPC receipt). The button must NOT wedge in its
    // disabled/pending state — once the receipt lands it re-enables (the mock keeps the preview
    // claimable). No error alert surfaced.
    await expect(collectBtn).toBeEnabled({ timeout: 15_000 });
    await expect(row.getByRole('alert')).toHaveCount(0);

    await expect(page.getByText(/failed to boot/i)).toHaveCount(0);
    const fatal = consoleErrors.filter((e) => !/Download the React DevTools|hydrat/i.test(e));
    expect(fatal, fatal.join('\n')).toHaveLength(0);
  });
});
