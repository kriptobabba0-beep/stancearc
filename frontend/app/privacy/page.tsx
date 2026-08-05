// app/privacy/page.tsx - Privacy Policy. Server component: the full policy, verbatim from the team's
// reviewed copy. Curly quotes/apostrophes on purpose (react/no-unescaped-entities). Bullet lists render
// through the shared List helper. Inline code token (fa_circle_uid) uses <code>.
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy - Limen Finance',
  description:
    'How Limen Finance processes information: no account database, what stays in your browser, and which third-party services are involved.',
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

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <span className="kicker">Legal</span>
      <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-ink">Privacy Policy</h1>
      <p className="mt-1 font-mono text-xs text-ink-muted">Last updated: {UPDATED}</p>

      <p className="mt-6 text-sm leading-relaxed text-ink-soft">
        This Privacy Policy explains how Limen Finance processes information when you use limen.finance, its
        interfaces, Copilot, browser automation, embedded wallets, leaderboard, feedback form, and related
        testnet services (the “App”).
      </p>
      <p className="mt-3 text-sm leading-relaxed text-ink-soft">
        Limen is designed to maintain as little server-side information about users as reasonably possible. The
        App does not currently use a conventional Limen account database.
      </p>

      <Section title="1. Core privacy principles">
        <p>Limen does not:</p>
        <List
          items={[
            'Sell personal data',
            'Create advertising profiles',
            'Use retargeting pixels',
            'Use personal data for third-party advertising',
            'Use feedback contact information for marketing',
            'Send marketing email',
            'Intentionally use advertising trackers',
          ]}
        />
        <p>The ordinary App flow does not request a legal name or identity document.</p>
        <p>
          Certain features still require information to be processed by Limen or third-party providers, as
          described below.
        </p>
      </Section>

      <Section title="2. Public blockchain information">
        <p>Arc Testnet is a public blockchain.</p>
        <p>When you authorize or initiate a blockchain transaction, public information may include:</p>
        <List
          items={[
            'Wallet addresses',
            'Token transfers',
            'Token balances',
            'Swap activity',
            'LP positions',
            'Liquidity additions and removals',
            'NFT ownership and transfers',
            'Stance entries',
            'Selected views',
            'Entry anchors',
            'Settlement results',
            'Claims',
            'Transaction hashes',
            'Block numbers and timestamps',
          ]}
        />
        <p>Limen may read, aggregate, calculate, and display this public information.</p>
        <p>
          Confirmed blockchain records generally cannot be edited, deleted, or made private by Limen. Removing
          information from the Limen interface would not remove the underlying blockchain record.
        </p>
      </Section>

      <Section title="3. Information stored in your browser">
        <p>The App uses browser storage to preserve settings and operate features.</p>
        <p>Current localStorage data may include:</p>
        <List
          items={[
            'Market-specific browser-session private keys',
            'Current and historical session-wallet addresses',
            'Agent mandate settings',
            'Autopilot state',
            'Copilot thread and conversation history',
            'Selected Copilot model',
            'Selected market',
            'Visited-state preferences',
            'Wallet-connection information maintained by wagmi',
            'Device or wallet information maintained by the Circle W3S SDK',
          ]}
        />
        <p>The browser-session private key is stored in plain text and is not encrypted.</p>
        <p>
          Anyone who obtains access to your browser profile or local storage may be able to obtain that
          session key and control test assets held by the session address.
        </p>
        <p>Clearing browser storage may remove:</p>
        <List
          items={[
            'The session key',
            'Copilot history',
            'Agent settings',
            'Historical session-address mappings',
            'Other local preferences',
          ]}
        />
        <p>You should back up or sweep an active session before clearing browser data.</p>
        <p>The App does not currently use sessionStorage or IndexedDB for Limen-managed information.</p>
      </Section>

      <Section title="4. Circle user identifier cookie">
        <p>The App uses an HttpOnly cookie named:</p>
        <p>
          <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-[13px] text-ink">
            fa_circle_uid
          </code>
        </p>
        <p>This cookie contains a Circle user identifier and currently has a one-year lifetime.</p>
        <p>
          The cookie is used to obtain tokens for the corresponding Circle wallet user. The backend does not
          accept a Circle user ID supplied freely in a request, which helps prevent one user from requesting
          wallet access for another user ID.
        </p>
        <p>The cookie is stored in the user’s browser and is not persisted in a Limen database.</p>
        <p>Because it is HttpOnly, it is not normally readable by frontend JavaScript.</p>
      </Section>

      <Section title="5. External wallets">
        <p>When you connect an external wallet, Limen may process or display:</p>
        <List
          items={[
            'Your public wallet address',
            'Network and connection status',
            'Transaction requests',
            'Approvals',
            'Transaction results',
            'Public transaction hashes',
          ]}
        />
        <p>Limen does not receive the external wallet’s raw private key or seed phrase.</p>
        <p>The wallet provider may independently process information under its own privacy policy.</p>
      </Section>

      <Section title="6. Circle embedded wallets and authentication">
        <p>Embedded wallets are provided using Circle user-controlled wallet infrastructure.</p>
        <p>Available authentication methods currently include email and Google sign-in.</p>
        <p>
          Circle’s browser SDK may communicate directly with Circle services. Limen’s backend may also
          transiently process information required to perform wallet authentication and transactions,
          including:
        </p>
        <List
          items={[
            'Email address during an email OTP request',
            'Device identifier',
            'Device token',
            'Device encryption key',
            'Temporary user token',
            'Temporary encryption key',
            'Wallet ID',
            'Public wallet address',
            'Challenge ID',
            'Contract-call and transaction parameters',
            'Authentication and transaction status',
          ]}
        />
        <p>
          These fields are processed to provide the requested wallet function. They are not persisted in a
          Limen database.
        </p>
        <p>
          Limen does not receive or store the raw private-key shares used by Circle’s user-controlled wallet
          system.
        </p>
        <p>
          Circle processes wallet, authentication, device, and transaction information under its own terms and
          privacy policies.
        </p>
      </Section>

      <Section title="7. Email verification">
        <p>Email OTP authentication is triggered through Circle.</p>
        <p>Email delivery is performed through Mailtrap using Limen’s configured transactional-email sender.</p>
        <p>During this process, an email address and related delivery metadata may be processed by:</p>
        <List items={['Limen’s backend', 'Circle', 'Mailtrap']} />
        <p>
          Limen processes the email address only as needed to request and deliver the authentication code. It
          is not stored in a Limen database and is not used for marketing.
        </p>
      </Section>

      <Section title="8. Copilot and Anthropic">
        <p>Copilot messages are sent through Limen’s Cloudflare Worker backend to the Anthropic API.</p>
        <p>
          The browser does not receive the Anthropic API key and does not communicate directly with Anthropic
          for Copilot responses.
        </p>
        <p>Information transmitted for a Copilot request may include:</p>
        <List
          items={[
            'The message you submit',
            'Relevant conversation context',
            'Selected model',
            'Public wallet address',
            'Relevant market, epoch, position, balance, and contract information needed to answer the request',
            'Tool results generated from public protocol data',
            'Technical information needed to process the request',
          ]}
        />
        <p>
          Limen does not persist Copilot prompts, responses, wallet addresses, or conversation history on its
          servers.
        </p>
        <p>Visible Copilot thread history is stored in the user’s browser localStorage.</p>
        <p>
          Anthropic independently processes API inputs and outputs under its own terms, privacy policy, and
          retention practices.
        </p>
        <p>Do not submit:</p>
        <List
          items={[
            'Private keys',
            'Seed phrases',
            'Wallet passwords',
            'Authentication codes',
            'Identity documents',
            'Confidential credentials',
            'Sensitive personal information',
            'Full environment files',
          ]}
        />
      </Section>

      <Section title="9. Copilot usage quota">
        <p>Copilot uses a daily usage quota.</p>
        <p>
          The quota is primarily keyed using the IP address supplied to the Worker through Cloudflare’s
          verified request headers.
        </p>
        <p>If an IP address is unavailable in local development, a wallet address may be used as a fallback.</p>
        <p>
          Quota information is held in an in-memory map within a Cloudflare edge isolate. It is not stored in a
          database.
        </p>
        <p>The quota resets:</p>
        <List
          items={[
            'When the applicable UTC-day key changes',
            'When the edge isolate is recycled',
            'When the in-memory state is otherwise lost',
          ]}
        />
        <p>Paid x402 requests may bypass the free-message quota.</p>
      </Section>

      <Section title="10. Cloudflare and request metadata">
        <p>The frontend, APIs, and leaderboard indexer are hosted on Cloudflare Workers.</p>
        <p>Cloudflare may process standard network and request metadata, which may include:</p>
        <List
          items={[
            'IP address',
            'Request time',
            'Requested route',
            'Traffic-routing information',
            'Browser or user-agent information',
            'Security and performance metadata',
          ]}
        />
        <p>
          Limen’s own application code does not intentionally log ordinary request bodies, Copilot message
          contents, IP addresses, or user-agent strings.
        </p>
        <p>API routes may emit limited error messages through console.error.</p>
        <p>
          Cloudflare Logpush is not currently configured. Limen does not currently maintain a persistent
          archive of ordinary Cloudflare Worker logs. Live operational logs may temporarily be visible while
          troubleshooting.
        </p>
        <p>Cloudflare may separately process and retain information under its own policies and infrastructure practices.</p>
      </Section>

      <Section title="11. DigitalOcean bot infrastructure">
        <p>Limen-operated keeper and test bots run on a DigitalOcean server.</p>
        <p>Local bot logs may contain:</p>
        <List
          items={[
            'Limen-operated bot addresses',
            'Transaction hashes',
            'Epoch information',
            'Bot execution and error information',
          ]}
        />
        <p>
          These logs relate primarily to Limen-operated test bots rather than ordinary user accounts. They
          remain in Docker logs until rotation or removal.
        </p>
        <p>Local keeper and epoch ledger JSON files contain bot-operational information.</p>
        <p>These VPS files are not used as a conventional user database.</p>
      </Section>

      <Section title="12. Leaderboard indexing">
        <p>The leaderboard is derived from public blockchain events.</p>
        <p>Limen stores aggregated leaderboard data rather than a permanent archive of every raw event.</p>
        <p>Aggregated data may include:</p>
        <List
          items={[
            'Public wallet address',
            'Swap totals',
            'Liquidity totals',
            'Stance contributions',
            'Qualification results',
            'Claims',
            'Realized PnL',
            'Daily activity buckets',
          ]}
        />
        <p>
          The aggregate is stored temporarily in Cloudflare Cache API, generally with a seven-day
          time-to-live.
        </p>
        <p>
          The cache is not the authoritative source. If it expires or is removed, the leaderboard may be
          rebuilt from public blockchain events.
        </p>
        <p>The YOU label is determined by comparing a row with the currently connected wallet address.</p>
        <p>
          The YOUR AGENT label is determined locally in the browser using the user’s locally stored historical
          session-address list.
        </p>
        <p>
          The server does not receive or store the relationship between a connected wallet and the addresses
          labeled YOUR AGENT.
        </p>
      </Section>

      <Section title="13. Self-hosted agent">
        <p>The self-hosted agent does not currently send telemetry to Limen.</p>
        <p>It does not send the following to the Limen backend:</p>
        <List
          items={[
            'Wallet address',
            'Configuration',
            'Mandate',
            'Heartbeat',
            'Local logs',
            'Local errors',
            'Executor key',
          ]}
        />
        <p>The agent may communicate with:</p>
        <List items={['Pyth Benchmark services', 'Arc RPC providers', 'Circle CLI and Agent Wallet services']} />
        <p>
          Agent logs are written to local standard output and local ledger files on the user’s own machine or
          server.
        </p>
        <p>The user controls the security, storage, backup, and deletion of those local files.</p>
      </Section>

      <Section title="14. Feedback form">
        <p>The Feedback button opens a Google Form.</p>
        <p>The form may request or permit you to provide:</p>
        <List
          items={[
            'Feedback category',
            'Description',
            'Reproduction steps',
            'Page URL',
            'Wallet address',
            'Transaction hash',
            'Screenshot or recording link',
            'Browser or device details',
            'Optional contact information',
          ]}
        />
        <p>
          The form does not intentionally require Limen to collect your email address. Contact information and
          wallet address are optional unless clearly stated otherwise in the form.
        </p>
        <p>The form uses links rather than direct file uploads.</p>
        <p>
          Google may separately process Google-account, browser, network, and form-interaction information
          under its own terms and privacy policy.
        </p>
        <p>
          Responses are stored in an account accessible to the Limen team. Only the Limen team is intended to
          have access to submitted responses.
        </p>
        <p>Responses may be retained for as long as the team considers them useful for:</p>
        <List
          items={[
            'Investigating bugs',
            'Improving the App',
            'Maintaining issue history',
            'Responding to feedback',
            'Preventing abuse',
          ]}
        />
        <p>
          Do not submit private keys, seed phrases, passwords, authentication codes, identity documents, or
          full environment files.
        </p>
      </Section>

      <Section title="15. Third-party services">
        <p>Depending on the feature used, information may be processed by:</p>
        <List
          items={[
            'Circle, for wallets, authentication, CCTP, Gateway, Agent Wallets, CLI, Smart Contract Platform monitoring, and x402',
            'Pyth, for oracle and benchmark data',
            'Arc and RPC providers, including official or mirrored RPC endpoints',
            'Cloudflare, for hosting, Workers, networking, caching, and platform security',
            'DigitalOcean, for Limen-operated bot infrastructure',
            'Anthropic, for Copilot language-model processing',
            'Mailtrap, for transactional OTP email delivery',
            'Google Forms, for feedback submissions',
            'GitHub, for private source repositories and deployment triggers',
            'ArcScan, when you choose to follow an external explorer link',
          ]}
        />
        <p>
          Current RPC infrastructure may include services operated by dRPC, QuickNode, Blockdaemon, or other
          configured Arc RPC providers.
        </p>
        <p>
          Limen does not currently use an active advertising, product-analytics, session-replay, or
          independent error-monitoring service.
        </p>
      </Section>

      <Section title="16. Purposes of processing">
        <p>Information is processed only as reasonably necessary to:</p>
        <List
          items={[
            'Deliver the App and its requested features',
            'Connect wallets',
            'Authenticate Circle wallet users',
            'Submit and display blockchain transactions',
            'Provide Copilot responses',
            'Enforce usage quotas',
            'Calculate and display the leaderboard',
            'Deliver OTP emails',
            'Protect the App from abuse',
            'Debug errors',
            'Operate testnet infrastructure',
            'Review feedback',
            'Comply with applicable legal obligations',
          ]}
        />
        <p>
          Where applicable, processing may rely on providing the service requested by the user, Limen’s
          legitimate interests in operating and securing the App, or compliance with legal obligations.
        </p>
      </Section>

      <Section title="17. Retention">
        <p>Retention depends on the type of information:</p>
        <List
          items={[
            'Public blockchain records remain available for as long as the applicable blockchain data remains accessible',
            'Browser localStorage remains until it is cleared, overwritten, or removed by the browser or App',
            'The fa_circle_uid cookie currently has a one-year lifetime',
            'Copilot quota data remains until the UTC day changes or the applicable edge isolate is recycled',
            'Limen does not persist Copilot prompts, responses, or thread history on its servers',
            'Leaderboard aggregates generally remain in Cloudflare Cache API for up to seven days',
            'Cloudflare live logs are not retained by Limen through Logpush',
            'VPS bot logs remain until log rotation or deletion',
            'Local self-hosted-agent information remains until the user removes it',
            'Feedback responses remain for as long as the Limen team considers them useful',
            'Third-party providers apply their own retention rules',
          ]}
        />
      </Section>

      <Section title="18. International processing">
        <p>
          The App uses providers and infrastructure that may process information in countries other than the
          country where you live.
        </p>
        <p>This may include Cloudflare, Circle, Anthropic, DigitalOcean, Mailtrap, Google, GitHub, Pyth, and RPC providers.</p>
        <p>Those providers process information under their own contractual, legal, and privacy frameworks.</p>
      </Section>

      <Section title="19. Security">
        <p>Current security measures include:</p>
        <List
          items={[
            'Cloudflare platform DDoS protections',
            'Copilot rate limiting',
            'x402 payment enforcement for applicable paid requests',
            'Contract owner and keeper access controls',
            'HttpOnly protection for the Circle user-ID cookie',
            'Cloudflare encrypted environment secrets',
            'GitHub access controls',
            'Dependabot dependency scanning',
            'Slither static contract analysis in CI',
            'Automated frontend, keeper, and contract test suites',
          ]}
        />
        <p>Important limitations include:</p>
        <List
          items={[
            'Browser session private keys are stored unencrypted in localStorage',
            'No independent external smart-contract audit has been completed',
            'No system or provider can guarantee complete security',
            'User-controlled devices and self-hosted environments remain the user’s responsibility',
          ]}
        />
      </Section>

      <Section title="20. Your choices and rights">
        <p>You may:</p>
        <List
          items={[
            'Disconnect your wallet',
            'Avoid optional embedded-wallet features',
            'Avoid Copilot',
            'Avoid browser automation',
            'Avoid the self-hosted agent',
            'Clear browser storage',
            'Clear locally stored Copilot history',
            'Stop and sweep a browser session where available',
            'Avoid submitting optional feedback or contact information',
          ]}
        />
        <p>
          Depending on where you live, you may have legal rights relating to access, correction, deletion,
          restriction, objection, portability, or information about processing.
        </p>
        <p>These rights may not apply to public blockchain records that Limen cannot alter.</p>
        <p>
          To submit a privacy question or request, use the Feedback button in the App and clearly identify the
          submission as a privacy request. Include contact information if you want a response.
        </p>
      </Section>

      <Section title="21. Children">
        <p>The App does not perform age verification and is not designed to collect information from children.</p>
        <p>
          Do not use the App unless you are legally capable of agreeing to the Terms of Use applicable where
          you live.
        </p>
      </Section>

      <Section title="22. Changes and contact">
        <p>We may update this Privacy Policy as the App, infrastructure, and integrations change.</p>
        <p>The “Last updated” date identifies the current version.</p>
        <p>
          For privacy questions, data requests, bug reports, or feedback, use the Feedback button in the App’s
          navigation bar.
        </p>
      </Section>
    </div>
  );
}
