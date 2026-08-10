import { test, expect } from '@playwright/test';
import { injectMockWallet, mockRpc } from './mockWallet';

const RPC_GLOB = '**/rpc.testnet.arc.network/**';

test.describe('app smoke (Phase 2 routing)', () => {
  test('boots, passes the decimals/bytecode gate, and renders the Trade (/) hero', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await injectMockWallet(page);
    await mockRpc(page, RPC_GLOB);

    await page.goto('/');

    // The page rendered something (not the fatal boot banner / blank crash).
    await expect(page.locator('body')).toBeVisible();

    // No fatal "BadDecimals" / boot hard-fail banner is shown, and the page did NOT fall back to the
    // boot FatalBanner ("Limen Finance failed to boot") — i.e. the decimals/bytecode gate PASSED.
    await expect(page.getByText(/bad ?decimals/i)).toHaveCount(0);
    await expect(page.getByText(/failed to boot/i)).toHaveCount(0);

    // Phase 2: "/" is now the Trade route — the SwapForm is the centered hero. Its "swap-form" testid
    // mounts once the boot gate passes, so it's the reliable "the app rendered" signal for "/".
    await expect(page.getByTestId('swap-form')).toBeVisible({ timeout: 15_000 });

    // The persistent NavBar exposes the primary links (Stance·Swap·Pools·Bridge) on every route.
    await expect(page.getByRole('link', { name: 'Stance' }).first()).toBeVisible();

    // No uncaught console errors that would indicate a render crash.
    // (Allow benign warnings; fail only on hard errors.)
    const fatal = consoleErrors.filter(
      (e) => !/Download the React DevTools|hydrat/i.test(e),
    );
    expect(fatal, fatal.join('\n')).toHaveLength(0);
  });

  test('Stance route renders the staking surfaces (epoch)', async ({ page }) => {
    await injectMockWallet(page);
    await mockRpc(page, RPC_GLOB);

    await page.goto('/stance');
    await expect(page.locator('body')).toBeVisible();
    await expect(page.getByText(/failed to boot/i)).toHaveCount(0);

    // EpochPanel always renders its "Epoch" title once the boot gate passes.
    await expect(page.getByText(/epoch/i).first()).toBeVisible({ timeout: 15_000 });
  });

  test('legacy /claim redirects to /arena (claim panel anchored there)', async ({ page }) => {
    await injectMockWallet(page);
    await mockRpc(page, RPC_GLOB);
    await page.goto('/claim');
    await expect(page).toHaveURL(/\/arena$/);
    await expect(page.getByText(/bad ?decimals/i)).toHaveCount(0);
  });
});
