// app/terms/page.tsx — Terms of Use. Server component: the full testnet terms, verbatim from the
// team's reviewed copy. Curly quotes/apostrophes on purpose (react/no-unescaped-entities). Bullet
// lists render through the shared List helper.
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Use - Limen Finance',
  description:
    'The terms that govern using Limen Finance on Arc Testnet: testnet assets only, non-custodial by design, provided as-is.',
};

const UPDATED = 'July 19, 2026';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="font-display text-lg font-semibold tracking-tight text-ink">{title}</h2>
      <div className="mt-2 space-y-3 text-sm leading-relaxed text-ink-soft">{children}</div>
    </section>
  );
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-1 pl-5 marker:text-ink-faint">
      {items.map((it) => (
        <li key={it}>{it}</li>
      ))}
    </ul>
  );
}

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <span className="kicker">Legal</span>
      <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-ink">Terms of Use</h1>
      <p className="mt-1 font-mono text-xs text-ink-muted">Last updated: {UPDATED}</p>

      <p className="mt-6 text-sm leading-relaxed text-ink-soft">
        These Terms of Use govern your access to and use of Limen Finance at limen.finance, including its
        interfaces, smart-contract interactions, APIs, Copilot, automation features, leaderboard, and related
        testnet services (the “App”).
      </p>
      <p className="mt-3 text-sm leading-relaxed text-ink-soft">
        By accessing or using the App, you agree to these Terms. If you do not agree, do not use the App.
      </p>

      <Section title="1. Testnet use only">
        <p>
          Limen’s protocol contracts and liquidity markets currently operate on Arc Testnet. Optional
          onboarding and bridging features may also interact with other test networks through Circle CCTP or
          Gateway.
        </p>
        <p>
          All USDC, EURC, cirBTC, LP positions, fee shares, balances, and other assets used or displayed
          through the App are testnet assets obtained from faucets or testnet bridging flows.
        </p>
        <p>Testnet assets:</p>
        <List
          items={[
            'Have no monetary value',
            'Cannot be redeemed for real assets',
            'May be reset, replaced, redeployed, or removed',
            'May become inaccessible because of testnet, contract, wallet, or infrastructure changes',
          ]}
        />
        <p>
          Nothing in the App is an offer, investment, deposit, security, financial instrument, or other
          financial product. No testnet feature is guaranteed to become available on mainnet.
        </p>
      </Section>

      <Section title="2. What Limen does">
        <p>
          At its base, Limen provides a V3-style automated market maker interface where users may swap test
          assets and create or manage liquidity positions.
        </p>
        <p>Users may use Limen as a standard AMM without participating in Stance.</p>
        <p>
          Stance is an optional, epoch-based fee-allocation layer for eligible liquidity positions. Other App
          features may include:
        </p>
        <List
          items={[
            'Swap and liquidity interfaces',
            'UP, DOWN, and RANGE Stance participation',
            'Pyth-based price anchoring and settlement',
            'Fee-share claims',
            'Browser-based automation',
            'Self-hosted automation software',
            'Circle embedded wallets and Agent Wallet integrations',
            'CCTP and Gateway testnet onboarding',
            'Copilot',
            'A leaderboard derived from public blockchain activity',
          ]}
        />
        <p>Features may be changed, paused, replaced, or removed during testing.</p>
      </Section>

      <Section title="3. How Stance works">
        <p>A user first creates or holds a V3-style LP position represented by an NFT.</p>
        <p>
          During an open entry period, the user may place that LP NFT into Stance for an epoch and select an
          UP, DOWN, or RANGE view.
        </p>
        <p>
          Each participating position receives its own entry-time price anchor using Pyth oracle data. At
          settlement, the submitted Pyth settlement price is compared with that position’s anchor and the
          market’s configured band.
        </p>
        <p>A position may qualify according to the applicable Stance rules:</p>
        <List
          items={[
            'UP qualifies when the relevant price movement is sufficiently above the position’s anchor',
            'DOWN qualifies when it is sufficiently below the anchor',
            'RANGE qualifies when it remains within the configured band',
          ]}
        />
        <p>
          Qualifying positions retain their own eligible epoch fees and receive a proportional share of the
          eligible fees forfeited by non-qualifying positions.
        </p>
        <p>
          Non-qualifying positions forfeit only the fees allocated to that epoch. The underlying LP principal
          is not redistributed through Stance.
        </p>
        <p>
          If an epoch has no qualifying position, eligible fees may roll forward to a later fee pool rather
          than being retained by the Limen team.
        </p>
      </Section>

      <Section title="4. LP risks remain">
        <p>Stance reallocates fees, not LP principal.</p>
        <p>
          The underlying LP position remains subject to the normal risks of V3-style liquidity provision,
          including:
        </p>
        <List
          items={[
            'Price movement',
            'Impermanent loss',
            'Concentrated-liquidity range risk',
            'Reduced or zero fee generation while out of range',
            'Smart-contract risk',
            'Token and testnet risk',
          ]}
        />
        <p>A position remaining in place does not mean its value is protected or guaranteed.</p>
      </Section>

      <Section title="5. Protocol administration">
        <p>The current testnet contracts contain administrative functions.</p>
        <p>The contract owner may:</p>
        <List
          items={[
            'Pause or unpause relevant contract activity',
            'Change market bands',
            'Change epoch timing',
            'Change settlement sanity parameters',
            'Change stake-cap parameters',
            'Appoint or replace a keeper',
            'Emergency-settle an epoch that remains stuck after the applicable grace period',
          ]}
        />
        <p>
          An emergency settlement does not allow the owner to withdraw user assets. In the current design,
          affected fees roll forward and staked NFTs are returned to their owners.
        </p>
        <p>
          The contract owner or designated keeper may open or create epochs and submit settlement prices to
          the contracts.
        </p>
        <p>
          Certain processing functions, including position processing, epoch finalization, batch unstaking,
          and claims, may be called permissionlessly.
        </p>
        <p>The current contracts:</p>
        <List
          items={[
            'Are not upgradeable proxies',
            'Do not contain a general user-fund rescue or emergency-withdrawal function',
            'Do not allow the configured oracle to be replaced after deployment',
          ]}
        />
        <p>
          These properties describe the current testnet deployment and may differ in a future deployment.
        </p>
      </Section>

      <Section title="6. Oracle and settlement">
        <p>
          Settlement uses Pyth oracle information. The frontend does not manually choose whether an individual
          position qualifies.
        </p>
        <p>
          However, an owner or designated keeper submits settlement information to the contract. A failure,
          delay, incorrect submission, stale price, unavailable feed, RPC problem, or contract error may delay
          settlement or produce an unexpected result.
        </p>
        <p>Displayed prices and probabilities may differ from the price ultimately accepted by the contract.</p>
      </Section>

      <Section title="7. External and embedded wallets">
        <p>Limen does not custody your external wallet or receive its raw private key.</p>
        <p>External-wallet transactions are authorized through your selected wallet provider.</p>
        <p>
          Circle embedded-wallet functionality uses Circle’s user-controlled wallet infrastructure. Limen does
          not receive the raw private-key material used by Circle’s MPC wallet system.
        </p>
        <p>You are responsible for:</p>
        <List
          items={[
            'Securing your wallet and authentication methods',
            'Reviewing addresses, token amounts, approvals, and transaction data',
            'Protecting your device and browser profile',
            'Confirming transactions before authorization',
            'Maintaining access to your wallet provider',
            'Keeping sufficient test assets available for gas and execution',
          ]}
        />
        <p>Blockchain transactions may be irreversible after confirmation.</p>
      </Section>

      <Section title="8. Browser Autopilot and session keys">
        <p>Browser Autopilot may create a separate, market-specific session wallet.</p>
        <p>
          The session private key is stored in plain text in your browser’s localStorage. It is not encrypted.
        </p>
        <p>
          This design allows the browser session to sign unattended transactions, but it creates important
          risks:
        </p>
        <List
          items={[
            'Anyone who gains access to your browser profile or local storage may obtain the session key',
            'Clearing browser data may permanently remove the session key',
            'Losing the key may make remaining session assets inaccessible',
            'Closing, suspending, or sleeping the browser or device may interrupt automation',
            'Browser extensions, malware, shared devices, or compromised profiles may expose the session',
          ]}
        />
        <p>
          The financial scope of a browser session is structurally limited by the test assets transferred to
          that session address. It is not a guarantee against loss of the entire funded session balance.
        </p>
        <p>
          Where available, you should use the backup and sweep functions before clearing browser data or
          abandoning a session.
        </p>
      </Section>

      <Section title="9. Automation mandates">
        <p>Browser and self-hosted agents may use a user-defined mandate containing settings such as:</p>
        <List
          items={[
            'Allowed views',
            'Confidence threshold',
            'Budget',
            'Expiry',
            'Market selection',
            'Entry timing',
          ]}
        />
        <p>Not every mandate rule is enforced by the smart contracts.</p>
        <p>
          Allowed views, confidence thresholds, and self-hosted expiry settings are enforced primarily by the
          agent software. A modified, malfunctioning, or compromised agent may fail to follow those rules.
        </p>
        <p>
          The browser-session budget is structurally limited by the funds transferred to the session address.
        </p>
        <p>The contracts separately enforce certain rules, including:</p>
        <List
          items={[
            'A single side per position or applicable entry within an epoch',
            'Entry-phase and timing requirements',
            'Price-freshness requirements',
            'NFT custody while staked',
            'Same-block protections',
            'Any enabled user or epoch stake caps',
          ]}
        />
        <p>Circle spending-policy enforcement is not currently relied upon for Arc Testnet automation.</p>
      </Section>

      <Section title="10. Self-hosted agent">
        <p>The self-hosted agent runs on infrastructure controlled by the user.</p>
        <p>
          The current self-hosted flow may transfer test assets from a Circle Agent Wallet to an executor
          externally owned account derived from the configured executor private key.
        </p>
        <p>The executor address owns:</p>
        <List
          items={[
            'The LP position',
            'Tokens transferred to the executor',
            'Claimed fee shares',
            'Other assets accumulated through agent activity',
          ]}
        />
        <p>
          There is currently no automatic sweep from the executor back to the Circle Agent Wallet. Returning
          assets to the Agent Wallet requires a separate manual transaction.
        </p>
        <p>You are responsible for:</p>
        <List
          items={[
            'Securing the executor private key',
            'Securing configuration and local ledger files',
            'Maintaining the host computer or server',
            'Maintaining Circle authentication where needed',
            'Monitoring balances and transactions',
            'Manually returning assets when appropriate',
          ]}
        />
        <p>
          The self-hosted agent does not currently send telemetry, configuration, wallet information,
          heartbeats, logs, or errors to the Limen backend. It may communicate with Pyth services, Arc RPC
          providers, Circle CLI, and other infrastructure required for operation.
        </p>
      </Section>

      <Section title="11. Agent limitations">
        <p>An automation agent may:</p>
        <List
          items={[
            'Decline to act',
            'Act on an incorrect estimate',
            'Miss an entry window',
            'Submit a late or failed transaction',
            'Fail to claim before a later action',
            'Stop because of browser, device, network, RPC, oracle, wallet, or provider failure',
            'Use delayed, incomplete, or incorrect data',
            'Enter a Stance that does not qualify',
            'Consume gas without completing the intended action',
            'Behave unexpectedly because of a bug or configuration error',
          ]}
        />
        <p>
          Automation does not guarantee execution, qualification, fee income, or any particular result.
        </p>
      </Section>

      <Section title="12. Copilot">
        <p>Copilot uses an Anthropic language-model API through Limen’s backend.</p>
        <p>
          Copilot may read or use relevant public protocol, wallet, market, epoch, and position information to
          answer a request or prepare a transaction proposal.
        </p>
        <p>Copilot output may be incomplete, delayed, misleading, or incorrect.</p>
        <p>
          Copilot cannot replace your own review. Any transaction still requires the applicable wallet,
          session, or executor authorization mechanism.
        </p>
        <p>
          Do not submit private keys, seed phrases, passwords, authentication codes, personal identification
          documents, or other sensitive information to Copilot.
        </p>
        <p>Nothing provided through Copilot is financial, investment, trading, legal, accounting, or tax advice.</p>
      </Section>

      <Section title="13. Estimates and displayed information">
        <p>
          Probabilities, confidence scores, signals, fee estimates, qualification estimates, balances,
          leaderboard metrics, and other displayed information are informational estimates.
        </p>
        <p>They may be inaccurate because of:</p>
        <List
          items={[
            'Oracle or RPC delays',
            'Indexing delays',
            'Rounding',
            'Software errors',
            'Incomplete public data',
            'Changed market conditions',
            'Model or calculation assumptions',
          ]}
        />
        <p>You are responsible for evaluating displayed information before acting on it.</p>
      </Section>

      <Section title="14. Leaderboard">
        <p>
          The leaderboard is an informational testnet feature derived from public Arc blockchain events.
        </p>
        <p>It may display aggregated activity such as:</p>
        <List
          items={[
            'Swap volume',
            'Liquidity activity',
            'Stance entries',
            'Fee contributions',
            'Qualification results',
            'Claims',
            'Realized PnL',
            'Wallet rankings',
          ]}
        />
        <p>
          Leaderboard calculations, eligibility rules, labels, valuation methods, and ranking methods may
          change.
        </p>
        <p>
          The leaderboard may be rebuilt from blockchain data if its temporary cache expires or is removed.
          Rankings may be corrected where an indexing or calculation issue is identified.
        </p>
        <p>
          Leaderboard rankings and testnet activity do not create any right to tokens, rewards, money, access,
          eligibility, or future benefits.
        </p>
      </Section>

      <Section title="15. Third-party services">
        <p>The App depends on third-party services that Limen does not control, including:</p>
        <List
          items={[
            'Arc Testnet',
            'Arc RPC providers',
            'Circle Wallets, CCTP, Gateway, Agent Wallet, CLI, and x402 infrastructure',
            'Pyth Hermes and Benchmark services',
            'Cloudflare',
            'DigitalOcean',
            'Anthropic',
            'Mailtrap',
            'Google Forms',
            'GitHub',
            'ArcScan',
          ]}
        />
        <p>
          Third-party services may fail, change, suspend access, process information, impose limits, or
          discontinue functionality under their own terms and policies.
        </p>
        <p>
          Use of a third-party name or service does not imply sponsorship, endorsement, partnership, or
          responsibility unless explicitly stated.
        </p>
      </Section>

      <Section title="16. Acceptable use">
        <p>You may not use the App to:</p>
        <List
          items={[
            'Attack, exploit, probe, or disrupt the App, its contracts, APIs, bots, infrastructure, or providers',
            'Circumvent rate limits, access controls, payment requirements, or security mechanisms',
            'Introduce malware or malicious code',
            'Manipulate displayed activity through deceptive or abusive conduct',
            'Interfere with other users',
            'Impersonate another person or project',
            'Use the App for unlawful activity',
          ]}
        />
        <p>
          Automated interaction with public contracts is part of the product design. Abuse of Limen-operated
          interfaces, APIs, or infrastructure is not.
        </p>
      </Section>

      <Section title="17. Intellectual property and source code">
        <p>
          The Limen name, logo, original interface design, written materials, and original Limen software and
          contract components are owned by or licensed to the Limen team.
        </p>
        <p>
          Uniswap-derived components and other third-party code remain subject to their respective licenses
          and ownership terms.
        </p>
        <p>
          The current Limen repositories, including the self-hosted agent repository, are not generally public
          or open source.
        </p>
        <p>
          Access to a deployed contract, downloadable file, test build, or interface does not grant ownership
          of the underlying source code.
        </p>
      </Section>

      <Section title="18. Experimental software and security">
        <p>The App is experimental beta software.</p>
        <p>
          The contracts and software have undergone internal testing, automated test suites, dependency
          scanning, and static analysis. They have not received an independent external smart-contract audit.
        </p>
        <p>
          The App is provided “as is” and “as available”, without warranties of any kind, including warranties
          of:
        </p>
        <List
          items={[
            'Accuracy',
            'Security',
            'Availability',
            'Merchantability',
            'Fitness for a particular purpose',
            'Non-infringement',
            'Uninterrupted operation',
            'Freedom from defects',
          ]}
        />
        <p>No software, wallet, network, smart contract, browser, or third-party service is completely secure.</p>
      </Section>

      <Section title="19. Suspension and changes">
        <p>We may pause, modify, reset, replace, or discontinue any part of the App at any time.</p>
        <p>This may include:</p>
        <List
          items={[
            'Markets',
            'Epoch timing',
            'Bands and caps',
            'Contracts',
            'Interfaces',
            'Agents',
            'APIs',
            'Copilot models',
            'Leaderboard calculations',
            'Bridge routes',
            'Test assets',
            'Third-party integrations',
          ]}
        />
        <p>Testnet activity may be lost following a reset, redeployment, or infrastructure change.</p>
      </Section>

      <Section title="20. Limitation of liability">
        <p>
          To the maximum extent permitted by applicable law, the Limen team will not be liable for any
          indirect, incidental, special, consequential, exemplary, reliance-based, or similar loss arising
          from or relating to:
        </p>
        <List
          items={[
            'Use of or inability to use the App',
            'Loss of test assets',
            'Loss or exposure of a browser session key',
            'Loss or exposure of an executor key',
            'Failed, delayed, duplicated, reverted, or incorrectly submitted transactions',
            'Unexpected settlement',
            'Incorrect oracle or model information',
            'Smart-contract or software defects',
            'Testnet resets',
            'Wallet, RPC, hosting, model, email, or other provider failures',
            'Leaderboard inaccuracies',
            'Suspension or discontinuation of a feature',
            'Reliance on Copilot, agent, probability, or interface output',
          ]}
        />
        <p>Nothing in these Terms excludes or limits liability that cannot lawfully be excluded or limited.</p>
      </Section>

      <Section title="21. Changes to these Terms">
        <p>We may update these Terms as the App evolves.</p>
        <p>
          The “Last updated” date identifies the current version. Continued use after an update means that you
          accept the revised Terms.
        </p>
        <p>If you do not accept an update, stop using the App.</p>
      </Section>

      <Section title="22. Contact">
        <p>For questions, bug reports, or feedback, use the Feedback button in the App’s navigation bar.</p>
      </Section>
    </div>
  );
}
