import { test, expect } from '@playwright/test';
import { injectMockWallet, mockRpc, connectWallet, selectMarket } from './mockWallet';

// The v2 conviction arena is now the SECONDARY market (id "btc-v2") after the cutover-safety reorder
// (the LIVE v1 arena is MARKETS[0]/default). This v2 flow selects the v2 market explicitly after boot.
const V2_MARKET_ID = 'btc-v2';

const RPC_GLOB = '**/rpc.testnet.arc.network/**';

// Stake flow against the LIVE default market — the cirBTC/USDC **v2** conviction arena. The 'entryOpen'
// scenario serves an epoch in the Entry window (staking open), the connected wallet owning ONE stakeable
// cirBTC/USDC position (tokenId 1) with NO existing stake this epoch (Lens.getStakesByEpoch -> []), so
// the side stays pickable and the position surfaces in the picker. We drive the REAL StakeWithSideForm:
// pick the position + side, post a conviction, acknowledge the risk, and assert the v2 stake button
// (Approve & Stake) enables. The full write lifecycle is exercised by claim.spec.ts + withdraw.spec.ts.
test.describe('stake-with-conviction flow (v2)', () => {
  test('EntryOpen: pick a position + side + conviction + risk-ack enables the v2 stake button', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await injectMockWallet(page);
    await mockRpc(page, RPC_GLOB, { scenario: 'entryOpen' });

    // Phase 2: the staking surface (StakeWithSideForm) now lives on /arena, not the dashboard root.
    await page.goto('/stance');
    await connectWallet(page);
    // Switch to the v2 conviction market (secondary entry post-cutover) so the v2 stake surface is active.
    await selectMarket(page, V2_MARKET_ID);

    // The stake form mounts. Staking is OPEN (the epoch is in the Entry window) — the "only open during
    // the Entry window" lock banner must NOT be shown.
    await expect(page.getByTestId('stake-submit')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/only open during the Entry window/i)).toHaveCount(0);

    // The v2 read wiring (Lens.getStakesByEpoch owner-filtered -> [] this epoch) leaves the owned
    // position free, so the picker surfaces tokenId 1 (NOT the empty "provide liquidity" state). Pick it.
    const position = page.getByTestId('position-1');
    await expect(position).toBeVisible({ timeout: 15_000 });
    await position.click();
    await expect(position).toHaveAttribute('aria-pressed', 'true');

    // 1 · Pick the UP side (Side.UP === 1) — the toggle is interactive (no side locked this epoch).
    const upSide = page.getByTestId('side-1');
    await expect(upSide).toBeVisible();
    await upSide.click();
    await expect(upSide).toHaveAttribute('aria-pressed', 'true');

    // 2 · v2 markets require a conviction. Below-bounds is rejected inline; an in-bounds amount validates.
    const conviction = page.getByTestId('conviction-input');
    await expect(conviction).toBeVisible(); // the conviction input only renders for a v2 market
    await conviction.fill('50'); // below the 100 USDC minConv
    await expect(page.getByTestId('conviction-error')).toBeVisible();
    await conviction.fill('250'); // in-bounds [100, 1000]
    await expect(page.getByTestId('conviction-error')).toHaveCount(0);

    // 3 · Acknowledge the risk (the RiskAcknowledgement checkbox).
    const ack = page.getByTestId('risk-ack');
    await ack.check();
    await expect(ack).toBeChecked();

    // With a position + side + valid conviction + ack, the v2 "Approve & Stake" button is enabled.
    const submit = page.getByTestId('stake-submit');
    await expect(submit).toHaveText(/Approve & Stake/i);
    await expect(submit).toBeEnabled();

    await expect(page.getByText(/failed to boot/i)).toHaveCount(0);
    const fatal = consoleErrors.filter((e) => !/Download the React DevTools|hydrat/i.test(e));
    expect(fatal, fatal.join('\n')).toHaveLength(0);
  });
});
