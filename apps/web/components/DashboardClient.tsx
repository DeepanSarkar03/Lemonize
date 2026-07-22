'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '@clerk/nextjs';
import {
  ArrowClockwise,
  ArrowSquareOut,
  CheckCircle,
  ClockCounterClockwise,
  GithubLogo,
  Key,
  Package,
  Plus,
  Trash,
  WarningCircle,
} from '@phosphor-icons/react';
import { CopyBlock } from '@/components/CopyBlock';
import { registryRequest } from '@/lib/registry-browser';
import { Badge } from '@/components/tailgrids/core/badge';
import { Button } from '@/components/tailgrids/core/button';
import { Input } from '@/components/tailgrids/core/input';
import { Progress } from '@/components/tailgrids/core/progress';
import { Skeleton } from '@/components/tailgrids/core/skeleton';

type TokenScope = 'read' | 'publish' | 'manage:packages' | 'manage:tokens';

interface AccountResponse {
  account: {
    id: string;
    namespace: string;
    email: string;
    githubUsername: string | null;
    githubLinked: boolean;
    role: string;
    status: string;
    createdAt: string;
    lastLoginAt: string | null;
  };
  terms: {
    currentVersion: string;
    acceptedVersion: string | null;
    acceptedAt: string | null;
    current: boolean;
  };
  publishing: {
    eligible: boolean;
    enabled: boolean;
    registryMode: string;
    requiresGithub: boolean;
  };
}

interface AccountPackage {
  id: string;
  name: string;
  status: string;
  description: string | null;
  latestVersion: string | null;
  versionCount: number;
  storageBytes: number;
  updatedAt: string;
  versions: Array<{
    id: string;
    version: string;
    status: string;
    scanError: string | null;
    updatedAt: string;
  }>;
}

interface UsageResponse {
  usage: {
    packages: number;
    versions: number;
    maxVersionsInPackage: number;
    publishedBytes: number;
    reservedBytes: number;
    storedAndReservedBytes: number;
    activePublishes: number;
  };
  limits: {
    packages: number;
    versionsPerPackage: number;
    tarballBytes: number;
    storageBytes: number;
    activePublishes: number;
  };
}

interface AuditResponse {
  events: Array<{
    id: string;
    action: string;
    resourceType: string;
    detail: string | null;
    createdAt: string;
  }>;
}

interface TokenItem {
  id: string;
  label: string;
  prefix: string;
  scopes: TokenScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

interface DashboardSnapshot {
  account: AccountResponse;
  packages: AccountPackage[];
  usage: UsageResponse;
  audit: AuditResponse['events'];
  tokens: TokenItem[];
}

interface CreatedToken {
  id: string;
  token: string;
  label: string;
  scopes: TokenScope[];
  expiresAt: string;
}

const TOKEN_SCOPES: Array<{ value: TokenScope; label: string }> = [
  { value: 'read', label: 'Read registry' },
  { value: 'publish', label: 'Publish versions' },
  { value: 'manage:packages', label: 'Manage packages' },
  { value: 'manage:tokens', label: 'Manage tokens' },
];

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}

function date(value: string | null): string {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function actionLabel(value: string): string {
  return value.replaceAll('.', ' ').replaceAll('_', ' ');
}

function statusTone(status: string): string {
  if (status === 'published' || status === 'completed' || status === 'active') {
    return 'bg-pastel-greenBg text-pastel-greenText';
  }
  if (status === 'rejected' || status === 'failed' || status === 'blocked') {
    return 'bg-pastel-redBg text-pastel-redText';
  }
  return 'bg-lemon-bg text-lemon-text';
}

function UsageMeter({
  label,
  value,
  limit,
  display,
}: {
  label: string;
  value: number;
  limit: number;
  display?: string;
}) {
  const percent = limit > 0 ? Math.min(100, Math.round((value / limit) * 100)) : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-4 text-sm">
        <span className="text-ink-600">{label}</span>
        <span className="tnum font-mono text-xs text-ink-900">
          {display ?? `${value} / ${limit}`}
        </span>
      </div>
      <Progress progress={percent} aria-label={label} className="max-w-none" />
    </div>
  );
}

export function DashboardClient() {
  const { getToken, isLoaded } = useAuth();
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const [busyToken, setBusyToken] = useState<string | null>(null);
  const [tokenLabel, setTokenLabel] = useState('Local development');
  const [tokenDays, setTokenDays] = useState(30);
  const [scopes, setScopes] = useState<TokenScope[]>(['read', 'publish', 'manage:packages']);
  const [createdToken, setCreatedToken] = useState<CreatedToken | null>(null);
  const [revokeAllArmed, setRevokeAllArmed] = useState(false);
  const [acceptTermsChecked, setAcceptTermsChecked] = useState(false);

  const sessionToken = useCallback(async () => {
    const token = await getToken();
    if (!token) throw new Error('Your session expired. Sign in again to continue.');
    return token;
  }, [getToken]);

  const loadDashboard = useCallback(async () => {
    setLoadState('loading');
    setMessage('');
    try {
      const token = await sessionToken();
      const [account, packages, usage, audit, tokens] = await Promise.all([
        registryRequest<AccountResponse>('/v1/account', { token }),
        registryRequest<{ packages: AccountPackage[] }>('/v1/account/packages', { token }),
        registryRequest<UsageResponse>('/v1/account/usage', { token }),
        registryRequest<AuditResponse>('/v1/account/audit?limit=30', { token }),
        registryRequest<{ tokens: TokenItem[] }>('/v1/tokens', { token }),
      ]);
      setSnapshot({
        account,
        packages: packages.packages,
        usage,
        audit: audit.events,
        tokens: tokens.tokens,
      });
      setLoadState('ready');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The dashboard could not be loaded.');
      setLoadState('error');
    }
  }, [sessionToken]);

  useEffect(() => {
    if (isLoaded) void loadDashboard();
  }, [isLoaded, loadDashboard]);

  const refreshTokens = async (token: string) => {
    const body = await registryRequest<{ tokens: TokenItem[] }>('/v1/tokens', { token });
    setSnapshot((current) => (current ? { ...current, tokens: body.tokens } : current));
  };

  const createToken = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!tokenLabel.trim() || scopes.length === 0) {
      setMessage('Add a label and choose at least one scope.');
      return;
    }
    setBusyToken('create');
    setMessage('');
    setCreatedToken(null);
    try {
      const token = await sessionToken();
      const created = await registryRequest<CreatedToken>('/v1/tokens', {
        method: 'POST',
        token,
        body: { label: tokenLabel.trim(), expiresInDays: tokenDays, scopes },
      });
      setCreatedToken(created);
      await refreshTokens(token);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The token could not be created.');
    } finally {
      setBusyToken(null);
    }
  };

  const revokeToken = async (id: string) => {
    setBusyToken(id);
    setMessage('');
    try {
      const token = await sessionToken();
      await registryRequest<{ ok: true }>(`/v1/tokens/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        token,
      });
      await refreshTokens(token);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The token could not be revoked.');
    } finally {
      setBusyToken(null);
    }
  };

  const revokeAll = async () => {
    if (!revokeAllArmed) {
      setRevokeAllArmed(true);
      return;
    }
    setBusyToken('all');
    setMessage('');
    try {
      const token = await sessionToken();
      await registryRequest<{ ok: true; revoked: number }>('/v1/tokens', {
        method: 'DELETE',
        token,
      });
      setCreatedToken(null);
      await refreshTokens(token);
      setRevokeAllArmed(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The tokens could not be revoked.');
    } finally {
      setBusyToken(null);
    }
  };

  const acceptTerms = async () => {
    if (!snapshot || !acceptTermsChecked) return;
    setBusyToken('terms');
    setMessage('');
    try {
      const token = await sessionToken();
      await registryRequest<{ version: string; acceptedAt: string }>('/v1/account/terms', {
        method: 'POST',
        token,
        body: { version: snapshot.account.terms.currentVersion },
      });
      await loadDashboard();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'The terms acceptance could not be saved.',
      );
    } finally {
      setBusyToken(null);
    }
  };

  if (loadState === 'loading') {
    return (
      <div className="space-y-5" aria-busy="true" aria-label="Loading dashboard">
        <Skeleton className="h-36 rounded-2xl" />
        <div className="grid gap-5 lg:grid-cols-[1.35fr_0.65fr]">
          <Skeleton className="h-80 rounded-2xl" />
          <Skeleton className="h-80 rounded-2xl" />
        </div>
      </div>
    );
  }

  if (loadState === 'error' || !snapshot) {
    return (
      <section className="mx-auto max-w-xl rounded-2xl bg-surface p-8 text-center">
        <WarningCircle className="mx-auto text-pastel-redText" size={28} weight="bold" />
        <h1 className="display-title mt-4 text-2xl">Dashboard unavailable</h1>
        <p className="mt-2 text-sm leading-6 text-ink-600">{message}</p>
        <Button className="mt-6" type="button" onClick={() => void loadDashboard()}>
          <ArrowClockwise size={16} weight="bold" /> Try again
        </Button>
      </section>
    );
  }

  const { account, publishing, terms } = snapshot.account;
  const { usage, limits } = snapshot.usage;

  return (
    <div className="space-y-8">
      <header className="overflow-hidden rounded-2xl bg-ink-900 px-6 py-7 text-white sm:px-8">
        <div className="grid items-end gap-8 lg:grid-cols-[1fr_auto]">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-white/55">
              Publisher workspace
            </p>
            <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-2">
              <h1 className="text-3xl font-medium tracking-[-0.05em] sm:text-4xl">
                @{account.namespace}
              </h1>
              <Badge color="gray" className="border-white/10 bg-white/10 text-white/70">
                {account.role}
              </Badge>
            </div>
            <p className="mt-3 max-w-xl text-sm leading-6 text-white/65">
              {account.githubUsername ? `GitHub @${account.githubUsername}` : account.email}
              {' · '}terms {terms.acceptedVersion ?? 'not accepted'}
            </p>
          </div>
          <div className="min-w-64 [&_div]:border-white/15 [&_div]:bg-white/5 [&_code]:text-white [&_button]:text-white/65">
            <CopyBlock text="lem publish" />
          </div>
        </div>
      </header>

      {!terms.current ? (
        <section className="grid gap-4 rounded-xl border border-lemon-swatch/40 bg-lemon-bg px-5 py-5 sm:grid-cols-[1fr_auto] sm:items-center">
          <div>
            <p className="font-semibold text-lemon-text">Review the current Terms of Use</p>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-lemon-text/80">
              Publishing stays locked until you explicitly accept version {terms.currentVersion}.{' '}
              <Link
                className="font-medium underline underline-offset-4"
                href="/terms"
                target="_blank"
              >
                Read the terms
              </Link>
              .
            </p>
            <label className="mt-3 flex items-start gap-2 text-sm text-lemon-text">
              <input
                className="mt-1 accent-lemon-text"
                type="checkbox"
                checked={acceptTermsChecked}
                onChange={(event) => setAcceptTermsChecked(event.target.checked)}
              />
              I have read and accept the current Terms of Use.
            </label>
          </div>
          <Button
            className="justify-center"
            type="button"
            disabled={!acceptTermsChecked || busyToken !== null}
            onClick={() => void acceptTerms()}
          >
            {busyToken === 'terms' ? 'Saving…' : 'Accept terms'}
          </Button>
        </section>
      ) : null}

      {terms.current && !publishing.enabled ? (
        <section className="flex items-start gap-3 rounded-xl bg-lemon-bg px-5 py-4 text-sm text-lemon-text">
          <WarningCircle className="mt-0.5 shrink-0" size={17} weight="bold" />
          <div>
            <p className="font-semibold">
              {!account.githubLinked
                ? 'Connect GitHub to become a publisher.'
                : publishing.registryMode === 'read_only'
                  ? 'The registry is currently read-only.'
                  : 'Publishing is not enabled for this account.'}
            </p>
            <p className="mt-1 opacity-80">
              Public installs and your existing package history remain available.
            </p>
          </div>
        </section>
      ) : null}

      {message ? (
        <p
          className="rounded-lg bg-pastel-redBg px-4 py-3 text-sm text-pastel-redText"
          role="status"
        >
          {message}
        </p>
      ) : null}

      <section className="grid gap-px overflow-hidden rounded-2xl bg-line sm:grid-cols-3">
        {[
          ['Packages', `${usage.packages} / ${limits.packages}`],
          ['Stored', `${bytes(usage.storedAndReservedBytes)} / ${bytes(limits.storageBytes)}`],
          ['Publishes in progress', `${usage.activePublishes} / ${limits.activePublishes}`],
        ].map(([label, value]) => (
          <div key={label} className="bg-surface px-6 py-5">
            <p className="text-xs text-ink-600">{label}</p>
            <p className="tnum mt-2 font-mono text-xl tracking-tight text-ink-900">{value}</p>
          </div>
        ))}
      </section>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]">
        <section className="rounded-2xl bg-surface">
          <div className="flex items-center justify-between border-b border-line px-6 py-5">
            <div>
              <h2 className="flex items-center gap-2 font-semibold text-ink-900">
                <Package size={18} weight="bold" /> Packages
              </h2>
              <p className="mt-1 text-xs text-ink-600">Owned by this namespace</p>
            </div>
            <span className="tnum font-mono text-xs text-ink-600">{snapshot.packages.length}</span>
          </div>

          {snapshot.packages.length === 0 ? (
            <div className="px-6 py-10">
              <p className="font-medium text-ink-900">Your namespace is ready.</p>
              <p className="mt-1 max-w-md text-sm leading-6 text-ink-600">
                Name the package with your immutable scope, then publish from the project directory.
              </p>
              <div className="mt-5 max-w-md">
                <CopyBlock text={`lem publish --name @${account.namespace}/my-package`} />
              </div>
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {snapshot.packages.map((pkg) => {
                const latestActivity = pkg.versions[0];
                return (
                  <li key={pkg.id} className="group px-6 py-5 transition-colors hover:bg-paper/70">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <Link
                          href={`/packages/${pkg.name}`}
                          className="inline-flex items-center gap-1.5 font-mono text-sm font-medium text-ink-900 hover:underline hover:underline-offset-4"
                        >
                          {pkg.name} <ArrowSquareOut size={13} weight="bold" />
                        </Link>
                        <p className="mt-1 line-clamp-2 text-sm text-ink-600">
                          {pkg.description ?? 'No package description.'}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-3 text-xs">
                        <span className="tnum font-mono text-ink-600">
                          {bytes(pkg.storageBytes)}
                        </span>
                        <span
                          className={`rounded-md px-2 py-1 font-mono text-[10px] ${statusTone(latestActivity?.status ?? pkg.status)}`}
                        >
                          {latestActivity?.status ?? pkg.status}
                        </span>
                      </div>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 font-mono text-[11px] text-ink-600">
                      <span>{pkg.versionCount} published</span>
                      <span>latest {pkg.latestVersion ?? '—'}</span>
                      <span>updated {date(pkg.updatedAt)}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="rounded-2xl bg-surface p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 font-semibold text-ink-900">
                <Key size={18} weight="bold" /> Access tokens
              </h2>
              <p className="mt-1 text-xs text-ink-600">Shown once, stored hashed</p>
            </div>
            {snapshot.tokens.length > 0 ? (
              <button
                className={`rounded-md px-2 py-1 text-xs transition-colors ${
                  revokeAllArmed
                    ? 'bg-pastel-redBg text-pastel-redText'
                    : 'text-ink-600 hover:bg-paper hover:text-ink-900'
                }`}
                type="button"
                disabled={busyToken !== null}
                onClick={() => void revokeAll()}
              >
                {busyToken === 'all' ? 'Revoking…' : revokeAllArmed ? 'Confirm all' : 'Revoke all'}
              </button>
            ) : null}
          </div>

          {createdToken ? (
            <div className="mt-5 rounded-xl bg-pastel-greenBg p-4">
              <p className="flex items-center gap-1.5 text-sm font-medium text-pastel-greenText">
                <CheckCircle size={16} weight="bold" /> Copy this token now
              </p>
              <p className="mt-1 text-xs leading-5 text-pastel-greenText/80">
                Lemonize cannot reveal it again.
              </p>
              <div className="mt-3 break-all [&_div]:bg-white/60">
                <CopyBlock text={createdToken.token} label={createdToken.token} />
              </div>
            </div>
          ) : null}

          <form className="mt-5 space-y-4" onSubmit={createToken}>
            <div>
              <label className="label" htmlFor="token-label">
                Label
              </label>
              <Input
                id="token-label"
                className="w-full"
                value={tokenLabel}
                maxLength={128}
                onChange={(event) => setTokenLabel(event.target.value)}
                required
              />
            </div>
            <div>
              <label className="label" htmlFor="token-days">
                Expires
              </label>
              <select
                id="token-days"
                className="input"
                value={tokenDays}
                onChange={(event) => setTokenDays(Number(event.target.value))}
              >
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
              </select>
            </div>
            <fieldset>
              <legend className="label">Scopes</legend>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                {TOKEN_SCOPES.map(({ value, label }) => (
                  <label key={value} className="flex items-start gap-2 text-xs text-ink-600">
                    <input
                      className="mt-0.5 accent-ink-900"
                      type="checkbox"
                      checked={scopes.includes(value)}
                      onChange={(event) =>
                        setScopes((current) =>
                          event.target.checked
                            ? [...current, value]
                            : current.filter((scope) => scope !== value),
                        )
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            <Button className="w-full justify-center" type="submit" disabled={busyToken !== null}>
              <Plus size={15} weight="bold" />
              {busyToken === 'create' ? 'Creating…' : 'Create token'}
            </Button>
          </form>

          {snapshot.tokens.length > 0 ? (
            <ul className="mt-6 divide-y divide-line border-t border-line">
              {snapshot.tokens.map((token) => (
                <li key={token.id} className="flex items-start justify-between gap-3 py-3 text-xs">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink-900">{token.label}</p>
                    <p className="tnum mt-1 font-mono text-[10px] text-ink-600">
                      {token.prefix}… · expires {date(token.expiresAt)}
                    </p>
                  </div>
                  <button
                    className="hit-slop shrink-0 rounded-md p-1 text-ink-600 transition-colors hover:bg-pastel-redBg hover:text-pastel-redText"
                    type="button"
                    aria-label={`Revoke ${token.label}`}
                    disabled={busyToken !== null}
                    onClick={() => void revokeToken(token.id)}
                  >
                    <Trash size={14} weight="bold" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <section className="rounded-2xl bg-surface p-6">
          <h2 className="font-semibold text-ink-900">Usage and limits</h2>
          <p className="mt-1 text-xs text-ink-600">Starter allocation for @{account.namespace}</p>
          <div className="mt-6 space-y-5">
            <UsageMeter label="Packages" value={usage.packages} limit={limits.packages} />
            <UsageMeter
              label="Versions in busiest package"
              value={usage.maxVersionsInPackage}
              limit={limits.versionsPerPackage}
            />
            <UsageMeter
              label="Storage"
              value={usage.storedAndReservedBytes}
              limit={limits.storageBytes}
              display={`${bytes(usage.storedAndReservedBytes)} / ${bytes(limits.storageBytes)}`}
            />
            <UsageMeter
              label="Concurrent publishes"
              value={usage.activePublishes}
              limit={limits.activePublishes}
            />
          </div>
          <p className="mt-5 border-t border-line pt-4 font-mono text-[11px] text-ink-600">
            Maximum compressed tarball: {bytes(limits.tarballBytes)}
          </p>
        </section>

        <section className="rounded-2xl bg-surface">
          <div className="border-b border-line px-6 py-5">
            <h2 className="flex items-center gap-2 font-semibold text-ink-900">
              <ClockCounterClockwise size={18} weight="bold" /> Account activity
            </h2>
            <p className="mt-1 text-xs text-ink-600">Security-sensitive registry events</p>
          </div>
          {snapshot.audit.length === 0 ? (
            <p className="px-6 py-10 text-sm text-ink-600">No account activity recorded yet.</p>
          ) : (
            <ol className="divide-y divide-line px-6">
              {snapshot.audit.slice(0, 12).map((event) => (
                <li key={event.id} className="grid gap-1 py-4 sm:grid-cols-[1fr_auto] sm:gap-4">
                  <div>
                    <p className="text-sm font-medium capitalize text-ink-900">
                      {actionLabel(event.action)}
                    </p>
                    <p className="mt-1 truncate text-xs text-ink-600">
                      {event.detail ?? event.resourceType}
                    </p>
                  </div>
                  <time
                    className="tnum font-mono text-[10px] text-ink-600"
                    dateTime={event.createdAt}
                  >
                    {date(event.createdAt)}
                  </time>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <section className="flex flex-col gap-4 rounded-xl border border-line px-5 py-4 text-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <GithubLogo size={20} weight="bold" className="text-ink-600" />
          <div>
            <p className="font-medium text-ink-900">
              {account.githubLinked ? 'GitHub identity linked' : 'GitHub identity required'}
            </p>
            <p className="mt-0.5 text-xs text-ink-600">
              Your namespace stays @{account.namespace} if your username changes.
            </p>
          </div>
        </div>
        <p className="tnum font-mono text-[10px] text-ink-600">
          Member since {date(account.createdAt)}
        </p>
      </section>
    </div>
  );
}
