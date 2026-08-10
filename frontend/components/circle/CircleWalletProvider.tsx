'use client';

// components/circle/CircleWalletProvider.tsx — the embedded (user-controlled Circle) wallet state.
//
// Three onboarding methods, all non-custodial (the user's MPC keyshare + PIN/OAuth stay on-device):
//   • createOrRestoreWallet() — PIN method. userId lives in an HttpOnly cookie; the session is re-minted
//       on demand (so the user can transact after a reload). Browser-bound (no portable recovery).
//   • loginWithEmail(email)   — Email OTP. PORTABLE: same email -> same Circle user -> same wallet.
//   • loginWithGoogle()       — Google. PORTABLE: same Google account -> same wallet.
// Email/Google get userToken+encryptionKey from the SDK login callback (no userId tracked); that session
// is kept in memory for the tab, so transacting after a reload requires re-login (the wallet still shows).
// executeContract() creates a contractExecution challenge then signs it with the user (PIN/biometric).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CIRCLE_APP_ID,
  CIRCLE_GOOGLE_CLIENT_ID,
  GOOGLE_LOGIN_ENABLED,
  apiCreateUser,
  apiToken,
  apiEmailToken,
  apiSocialToken,
  apiInitialize,
  apiExecute,
  apiWallets,
  apiSignOut,
  apiTransactions,
  loadW3SSdk,
  type CircleTxDto,
} from '@/lib/circle/client';

const LS_WALLET = 'feearena.circle.walletId';
const LS_ADDR = 'feearena.circle.address';
const LS_CREATED = 'feearena.circle.created'; // PIN-only: marks a created user for interrupted-flow recovery
const LS_KIND = 'feearena.circle.kind'; // 'pin' | 'email' | 'google' — drives the executeContract session path
const LS_GOOGLE_PENDING = 'feearena.circle.googlePending'; // device token persisted across a Google OAuth redirect
// Email/Google session ({userToken,encryptionKey}) — persisted so transacting survives reloads/navigation
// (PIN re-mints via the HttpOnly cookie instead; only email/Google need this). Short-lived (~1h Circle TTL);
// it's a testnet wallet. Cleared on sign-out. Lets the embedded wallet work across the whole app, not just
// the tab where the user logged in.
const LS_SESSION = 'feearena.circle.session';

export type AuthKind = 'pin' | 'email' | 'google';

const lsGet = (k: string) => (typeof window !== 'undefined' ? window.localStorage.getItem(k) : null);
const lsSet = (k: string, v: string) => {
  if (typeof window !== 'undefined') window.localStorage.setItem(k, v);
};
const lsDel = (k: string) => {
  if (typeof window !== 'undefined') window.localStorage.removeItem(k);
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Limen Finance dark + crimson theme for Circle's Web SDK challenge UI (login OTP, set-PIN, the
// "Contract Interaction" confirm + PIN entry). Themes Circle's secure iframe so it reads as a native
// Limen Finance modal instead of a foreign white screen. Values mirror the app's dark tokens (globals.css).
const CIRCLE_THEME = {
  // Translucent backdrop so the dimmed Limen Finance page shows THROUGH behind the modal — making Circle's
  // (full-screen, by design) secure iframe read as an in-app overlay rather than a separate screen.
  backdrop: '#0A0A0C',
  backdropOpacity: 0.5,
  bg: '#141417',
  divider: '#28282E',
  success: '#40D178',
  error: '#FF7166',
  textMain: '#F5F5F5',
  textMain2: '#F5F5F5',
  textAuxiliary: '#C8C8C8',
  textAuxiliary2: '#9B9B9B',
  textSummary: '#9B9B9B',
  textSummaryHighlight: '#F5F5F5',
  textPlaceholder: '#6E6E6E',
  textDetailToggle: '#E5484D',
  textInteractive: '#E5484D',
  interactiveBg: '#1A1A1E',
  tooltipText: '#F5F5F5',
  tooltipBg: '#202025',
  pinDotBase: '#202025',
  pinDotBaseBorder: '#38383F',
  pinDotActivated: '#E5484D',
  enteredPinText: '#F5F5F5',
  inputText: '#F5F5F5',
  inputBorderFocused: '#E5484D',
  inputBorderFocusedError: '#FF7166',
  inputBg: '#202025',
  inputBgDisabled: '#1A1A1E',
  dropdownBg: '#141417',
  dropdownBorderIsOpen: '#E5484D',
  dropdownBorderError: '#FF7166',
  mainBtnText: '#FFFFFF',
  mainBtnTextDisabled: '#9B9B9B',
  mainBtnTextOnHover: '#FFFFFF',
  mainBtnBg: '#DC2626',
  mainBtnBgOnHover: '#E5484D',
  mainBtnBgDisabled: '#2E1416',
  secondBtnText: '#C8C8C8',
  secondBtnTextDisabled: '#6E6E6E',
  secondBtnTextOnHover: '#F5F5F5',
  secondBtnBorder: '#38383F',
  secondBtnBorderOnHover: '#E5484D',
  secondBtnBgOnHover: '#1A1A1E',
  secondBtnBorderDisabled: '#28282E',
  plainBtnText: '#C8C8C8',
  plainBtnTextDisabled: '#6E6E6E',
  plainBtnTextOnHover: '#F5F5F5',
  plainBtnBgOnHover: '#1A1A1E',
  titleGradients: ['#F06368', '#E5484D'],
};

/** The user's Arc wallet from Circle (any returned wallet, preferring ARC-TESTNET), or null. */
async function fetchArcWallet(userToken: string): Promise<{ id: string; address: string } | null> {
  const { wallets } = await apiWallets(userToken);
  return wallets.find((w) => w.blockchain === 'ARC-TESTNET') ?? wallets[0] ?? null;
}

/** Poll for the wallet — Circle provisions it asynchronously after the INITIALIZE challenge. */
async function pollArcWallet(userToken: string, tries = 6, delayMs = 1500): Promise<{ id: string; address: string } | null> {
  for (let i = 0; i < tries; i++) {
    const w = await fetchArcWallet(userToken).catch(() => null);
    if (w) return w;
    if (i < tries - 1) await sleep(delayMs);
  }
  return null;
}

function runChallenge(sdk: MinimalSdk, challengeId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sdk.execute(challengeId, (err) => {
      if (err) reject(new Error(err.message || 'The wallet challenge was cancelled or failed.'));
      else resolve();
    });
  });
}

type LoginResult = { userToken: string; encryptionKey: string };

/** Minimal view of the Web SDK we depend on (decouples us from the package's exact types). */
interface MinimalSdk {
  getDeviceId(): Promise<string>;
  setAuthentication(a: { userToken: string; encryptionKey: string }): void;
  execute(challengeId: string, cb: (error: { message?: string } | undefined, result?: unknown) => void): void;
  updateConfigs(
    configs: unknown,
    onLoginComplete?: (error: { message?: string } | undefined, result?: LoginResult) => void,
  ): void;
  verifyOtp(): void;
  performLogin(provider: string): Promise<void>;
  setThemeColor(theme: Record<string, unknown>): void;
}

export type CircleStatus = 'idle' | 'connecting' | 'ready' | 'executing' | 'error';

export interface ExecuteContractArgs {
  contractAddress: string;
  abiFunctionSignature?: string;
  abiParameters?: unknown[];
  callData?: string;
  amount?: string;
  feeLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
}

interface CircleWalletValue {
  status: CircleStatus;
  address: `0x${string}` | null;
  walletId: string | null;
  error: string | null;
  isReady: boolean;
  kind: AuthKind | null;
  googleEnabled: boolean;
  createOrRestoreWallet: () => Promise<void>;
  loginWithEmail: (email: string) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  executeContract: (args: ExecuteContractArgs) => Promise<{ challengeId: string }>;
  fetchTransactions: () => Promise<CircleTxDto[]>;
  signOut: () => void;
}

const CircleWalletContext = createContext<CircleWalletValue | null>(null);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function CircleWalletProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<CircleStatus>('idle');
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [walletId, setWalletId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<AuthKind | null>(null);

  const sessionRef = useRef<LoginResult | null>(null);
  const sdkRef = useRef<MinimalSdk | null>(null);
  // Only W3SSdk is re-exported by the package's main entry at runtime (SocialLoginProvider is type-only).
  const modRef = useRef<{ W3SSdk: new (cfg: unknown) => unknown } | null>(null);
  const busyRef = useRef(false);

  const getMod = useCallback(async () => {
    if (!modRef.current) modRef.current = (await loadW3SSdk()) as unknown as typeof modRef.current;
    return modRef.current!;
  }, []);

  const getSdk = useCallback(async (): Promise<MinimalSdk> => {
    if (sdkRef.current) return sdkRef.current;
    const mod = await getMod();
    sdkRef.current = new mod.W3SSdk({ appSettings: { appId: CIRCLE_APP_ID } }) as unknown as MinimalSdk;
    // Theme Circle's challenge UI (login OTP / set-PIN / contract-interaction confirm + PIN) to match
    // Limen Finance's dark crimson look, so the secure iframe reads as a native modal, not a white screen.
    try {
      sdkRef.current.setThemeColor(CIRCLE_THEME);
    } catch {
      /* older SDKs may lack setThemeColor — non-fatal */
    }
    return sdkRef.current;
  }, [getMod]);

  const adopt = useCallback((w: { id: string; address: string }) => {
    lsSet(LS_WALLET, w.id);
    lsSet(LS_ADDR, w.address);
    setWalletId(w.id);
    setAddress(w.address as `0x${string}`);
    setStatus('ready');
  }, []);

  /** Shared tail after a login (email/Google): recover the existing wallet, else initialize a new one. */
  const provision = useCallback(
    async (sdk: MinimalSdk, userToken: string, encryptionKey: string) => {
      sessionRef.current = { userToken, encryptionKey };
      // Persist so the email/Google wallet can transact after a reload / on other pages (not just this tab).
      lsSet(LS_SESSION, JSON.stringify({ userToken, encryptionKey }));
      sdk.setAuthentication({ userToken, encryptionKey });
      const existing = await fetchArcWallet(userToken); // returning user (same email/Google) -> same wallet
      if (existing) {
        adopt(existing);
        return;
      }
      const { challengeId } = await apiInitialize(userToken);
      await runChallenge(sdk, challengeId);
      const w = await pollArcWallet(userToken);
      if (!w) throw new Error('Your wallet is still finalizing — please try again in a moment.');
      adopt(w);
    },
    [adopt],
  );

  // ── PIN: cookie-bound recovery + create ───────────────────────────────────────────
  const authedSdk = useCallback(async (): Promise<{ sdk: MinimalSdk; userToken: string }> => {
    const session = await apiToken();
    sessionRef.current = session;
    const sdk = await getSdk();
    await sdk.getDeviceId();
    sdk.setAuthentication({ userToken: session.userToken, encryptionKey: session.encryptionKey });
    return { sdk, userToken: session.userToken };
  }, [getSdk]);

  const recoverWallet = useCallback(async (): Promise<boolean> => {
    try {
      const { userToken } = await apiToken();
      const w = await fetchArcWallet(userToken);
      if (w) {
        setKind('pin');
        adopt(w);
        return true;
      }
    } catch {
      /* no session / no wallet */
    }
    return false;
  }, [adopt]);

  /** 401/403 from our Circle proxy = the user token itself is dead (they expire ~hourly). */
  const isAuthDead = (e: unknown): boolean => {
    const st = (e as { status?: unknown } | null)?.status;
    return st === 401 || st === 403;
  };

  // A dead Circle session must LOOK signed-out. The wallet identity stays remembered, but a
  // "connected" wallet whose every transaction fails is strictly worse than a sign-in prompt.
  const expireSession = useCallback(() => {
    sessionRef.current = null;
    lsDel(LS_SESSION);
    setStatus('idle');
    setError('Your sign-in expired — sign in again to continue.');
  }, []);

  useEffect(() => {
    const wid = lsGet(LS_WALLET);
    const addr = lsGet(LS_ADDR);
    const k = lsGet(LS_KIND) as AuthKind | null;
    if (wid && addr) {
      setKind(k);
      setWalletId(wid);
      setAddress(addr as `0x${string}`);
      // Restore the email/Google session so transacting works after a reload (PIN re-mints via the cookie).
      if (k === 'email' || k === 'google') {
        if (!sessionRef.current) {
          const raw = lsGet(LS_SESSION);
          if (raw) {
            try {
              const s = JSON.parse(raw) as LoginResult;
              if (s?.userToken && s?.encryptionKey) sessionRef.current = s;
            } catch {
              /* ignore a malformed stored session */
            }
          }
        }
        const tok = sessionRef.current?.userToken;
        if (!tok) {
          // Nothing to transact with — ask for a fresh sign-in instead of a zombie wallet.
          setStatus('idle');
          return;
        }
        setStatus('ready');
        // Probe the restored token in the background; downgrade only on an auth verdict,
        // never on a network hiccup.
        void apiTransactions(tok).catch((e: unknown) => {
          if (isAuthDead(e)) expireSession();
        });
        return;
      }
      setStatus('ready');
      return;
    }
    if (lsGet(LS_CREATED)) void recoverWallet();
  }, [recoverWallet, expireSession]);

  const createOrRestoreWallet = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setStatus('connecting');
    try {
      const wid = lsGet(LS_WALLET);
      const addr = lsGet(LS_ADDR);
      if (wid && addr) {
        setKind((lsGet(LS_KIND) as AuthKind) ?? 'pin');
        adopt({ id: wid, address: addr });
        return;
      }
      if (lsGet(LS_CREATED) && (await recoverWallet())) return;
      await apiCreateUser();
      lsSet(LS_CREATED, '1');
      lsSet(LS_KIND, 'pin');
      setKind('pin');
      const { sdk, userToken } = await authedSdk();
      const { challengeId } = await apiInitialize(userToken);
      await runChallenge(sdk, challengeId);
      const w = await pollArcWallet(userToken);
      if (!w) throw new Error('Your wallet is still finalizing — tap “Create wallet” again in a moment.');
      adopt(w);
    } catch (e) {
      setError(msg(e));
      setStatus('error');
    } finally {
      busyRef.current = false;
    }
  }, [authedSdk, recoverWallet, adopt]);

  // ── Email OTP (portable) ───────────────────────────────────────────────────────────
  const loginWithEmail = useCallback(
    async (email: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setError(null);
      setStatus('connecting');
      try {
        const sdk = await getSdk();
        const deviceId = await sdk.getDeviceId();
        const { deviceToken, deviceEncryptionKey, otpToken } = await apiEmailToken(deviceId, email);
        const result = await new Promise<LoginResult>((resolve, reject) => {
          sdk.updateConfigs(
            { appSettings: { appId: CIRCLE_APP_ID }, loginConfigs: { deviceToken, deviceEncryptionKey, otpToken } },
            (err, res) => (err || !res ? reject(new Error(err?.message || 'Email login failed or was cancelled.')) : resolve(res)),
          );
          sdk.verifyOtp(); // opens Circle's OTP entry UI; user types the emailed code
        });
        lsSet(LS_KIND, 'email');
        setKind('email');
        await provision(sdk, result.userToken, result.encryptionKey);
      } catch (e) {
        setError(msg(e));
        setStatus('error');
      } finally {
        busyRef.current = false;
      }
    },
    [getSdk, provision],
  );

  // ── Google (portable) ──────────────────────────────────────────────────────────────
  const loginWithGoogle = useCallback(async () => {
    if (busyRef.current) return;
    if (!GOOGLE_LOGIN_ENABLED) {
      setError('Google login is not configured.');
      setStatus('error');
      return;
    }
    busyRef.current = true;
    setError(null);
    setStatus('connecting');
    try {
      const sdk = await getSdk();
      const deviceId = await sdk.getDeviceId();
      const { deviceToken, deviceEncryptionKey } = await apiSocialToken(deviceId);
      // Persist before performLogin: if the SDK does a full-page redirect (popup blocked / redirect-mode
      // OAuth client) the page navigates away and this promise is lost — resumeGoogle() recovers on return.
      lsSet(LS_GOOGLE_PENDING, JSON.stringify({ deviceToken, deviceEncryptionKey }));
      const result = await new Promise<LoginResult>((resolve, reject) => {
        sdk.updateConfigs(
          {
            appSettings: { appId: CIRCLE_APP_ID },
            loginConfigs: {
              deviceToken,
              deviceEncryptionKey,
              google: { clientId: CIRCLE_GOOGLE_CLIENT_ID, redirectUri: window.location.origin, selectAccountPrompt: true },
            },
          },
          (err, res) => (err || !res ? reject(new Error(err?.message || 'Google login failed or was cancelled.')) : resolve(res)),
        );
        // The SDK's main entry re-exports only W3SSdk at runtime — the SocialLoginProvider enum is
        // type-only there, so `mod.SocialLoginProvider` is undefined in the browser. Its value for Google
        // is the literal 'Google' (verified in the SDK source); performLogin compares against that string.
        void sdk.performLogin('Google'); // SDK opens Google; result via the callback
      });
      lsSet(LS_KIND, 'google');
      setKind('google');
      await provision(sdk, result.userToken, result.encryptionKey);
    } catch (e) {
      setError(msg(e));
      setStatus('error');
    } finally {
      // Reached only on the in-page (popup) path — clear the pending marker so the next mount won't
      // try to resume. On a full-page redirect this never runs, so the marker survives for resumeGoogle().
      lsDel(LS_GOOGLE_PENDING);
      busyRef.current = false;
    }
  }, [getSdk, provision]);

  // On return from a Google OAuth redirect, finish the login the navigated-away tab couldn't.
  const resumeGoogle = useCallback(async () => {
    const raw = lsGet(LS_GOOGLE_PENDING);
    if (!raw) return;
    lsDel(LS_GOOGLE_PENDING); // one-shot — never loop on a stale device token
    let deviceToken = '';
    let deviceEncryptionKey = '';
    try {
      ({ deviceToken, deviceEncryptionKey } = JSON.parse(raw));
    } catch {
      return;
    }
    if (!deviceToken || busyRef.current) return;
    setStatus('connecting');
    const sdk = await getSdk();
    let handled = false;
    sdk.updateConfigs(
      {
        appSettings: { appId: CIRCLE_APP_ID },
        loginConfigs: {
          deviceToken,
          deviceEncryptionKey,
          google: { clientId: CIRCLE_GOOGLE_CLIENT_ID, redirectUri: window.location.origin },
        },
      },
      (err, res) => {
        if (handled) return;
        handled = true;
        if (err || !res) {
          setStatus('idle'); // came back without completing — show the sign-in screen, not a spinner
          return;
        }
        lsSet(LS_KIND, 'google');
        setKind('google');
        void provision(sdk, res.userToken, res.encryptionKey).catch((e) => {
          setError(msg(e));
          setStatus('error');
        });
      },
    );
    // Bound it: if this SDK build doesn't auto-complete on return, fall back to the sign-in screen.
    await sleep(8000);
    if (!handled) setStatus((s) => (s === 'connecting' ? 'idle' : s));
  }, [getSdk, provision]);

  useEffect(() => {
    void resumeGoogle();
  }, [resumeGoogle]);

  // ── Execute a contract call (dual-session: PIN re-mints via cookie; email/Google use the tab session) ──
  const executeContract = useCallback(
    async (args: ExecuteContractArgs): Promise<{ challengeId: string }> => {
      if (!walletId) throw new Error('Embedded wallet is not ready.');
      if (busyRef.current) throw new Error('A wallet operation is already in progress.');
      busyRef.current = true;
      setError(null);
      setStatus('executing');
      try {
        let sdk: MinimalSdk;
        let userToken: string;
        // Route by the auth method (React state, not localStorage — avoids a sign-out race where the
        // LS key is cleared a tick before this reads it and an email/Google call wrongly takes the PIN path).
        if (kind === 'pin' || kind === null) {
          ({ sdk, userToken } = await authedSdk()); // cookie re-mint — works after a reload
        } else {
          if (!sessionRef.current) {
            expireSession();
            throw new Error('Your sign-in expired — sign in again to continue.');
          }
          userToken = sessionRef.current.userToken;
          sdk = await getSdk();
          await sdk.getDeviceId();
          sdk.setAuthentication(sessionRef.current);
        }
        const { challengeId } = await apiExecute({ userToken, walletId, ...args });
        await runChallenge(sdk, challengeId);
        setStatus('ready');
        return { challengeId };
      } catch (e) {
        // An expired email/Google token means EVERY call will fail until the user signs in
        // again — flip to signed-out with a plain reason instead of a cryptic tx error.
        if ((kind === 'email' || kind === 'google') && isAuthDead(e)) {
          expireSession();
          throw new Error('Your sign-in expired — sign in again to continue.');
        }
        setError(msg(e));
        setStatus('ready');
        throw e;
      } finally {
        busyRef.current = false;
      }
    },
    [authedSdk, getSdk, walletId, kind, expireSession],
  );

  // Read the user's recent transactions using the active session (PIN re-mints via the cookie;
  // email/Google use the in-tab session token). Mirrors executeContract's session routing.
  const fetchTransactions = useCallback(async (): Promise<CircleTxDto[]> => {
    let userToken: string;
    if (kind === 'pin' || kind === null) {
      userToken = (await apiToken()).userToken;
    } else {
      if (!sessionRef.current) throw new Error('Your sign-in expired — sign in again to continue.');
      userToken = sessionRef.current.userToken;
    }
    const { transactions } = await apiTransactions(userToken).catch((e: unknown) => {
      if ((kind === 'email' || kind === 'google') && isAuthDead(e)) expireSession();
      throw e;
    });
    return transactions;
  }, [kind, expireSession]);

  const signOut = useCallback(() => {
    [LS_WALLET, LS_ADDR, LS_CREATED, LS_KIND, LS_GOOGLE_PENDING, LS_SESSION].forEach(lsDel);
    sessionRef.current = null;
    void apiSignOut().catch(() => {}); // clear the server (PIN) cookie too; harmless for email/Google
    setKind(null);
    setWalletId(null);
    setAddress(null);
    setStatus('idle');
    setError(null);
  }, []);

  const value = useMemo<CircleWalletValue>(
    () => ({
      status,
      address,
      walletId,
      error,
      isReady: status === 'ready' && !!address,
      kind,
      googleEnabled: GOOGLE_LOGIN_ENABLED,
      createOrRestoreWallet,
      loginWithEmail,
      loginWithGoogle,
      executeContract,
      fetchTransactions,
      signOut,
    }),
    [status, address, walletId, error, kind, createOrRestoreWallet, loginWithEmail, loginWithGoogle, executeContract, fetchTransactions, signOut],
  );

  return <CircleWalletContext.Provider value={value}>{children}</CircleWalletContext.Provider>;
}

export function useCircleWallet(): CircleWalletValue {
  const ctx = useContext(CircleWalletContext);
  if (!ctx) throw new Error('useCircleWallet must be used within a CircleWalletProvider.');
  return ctx;
}
