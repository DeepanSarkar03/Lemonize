import type { Metadata } from 'next';
import { LockKey } from '@phosphor-icons/react/dist/ssr';
import { DeviceApproval } from '@/components/DeviceApproval';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to your private Lemonize dashboard.',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return (
    <section className="grid min-h-[calc(100dvh-14rem)] items-center gap-8 lg:grid-cols-[0.9fr_1fr]">
      <div className="route-grid max-w-xl rounded-[2rem] bg-carbon p-8 text-pulp sm:p-10 lg:p-12">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-citron text-carbon">
          <LockKey size={20} weight="bold" />
        </div>
        <div className="mt-10 space-y-4">
          <p className="technical-label text-citron">Clerk-secured workspace</p>
          <h1 className="max-w-sm text-4xl font-medium leading-[0.98] tracking-[-0.055em] text-pulp sm:text-5xl">
            Access your registry workspace.
          </h1>
          <p className="leading-relaxed text-pulp/60">
            Sign in with GitHub to claim an immutable publisher namespace. Your GitHub connection
            establishes publisher eligibility; the registry may still be read-only during
            maintenance.
          </p>
        </div>
        <div className="mt-10 grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-white/10 text-xs">
          <div className="bg-white/[0.04] p-4">
            <p className="technical-label text-pulp/45">Session</p>
            <p className="mt-2 text-pulp/75">Passkey + GitHub</p>
          </div>
          <div className="bg-white/[0.04] p-4">
            <p className="technical-label text-pulp/45">Tokens</p>
            <p className="mt-2 text-pulp/75">Hashed at rest</p>
          </div>
        </div>
        <p className="mt-8 text-sm leading-relaxed text-pulp/55">
          By continuing, you acknowledge the{' '}
          <a
            className="font-medium text-pulp underline decoration-white/25 underline-offset-4 hover:decoration-citron"
            href="/terms"
          >
            Terms
          </a>{' '}
          and{' '}
          <a
            className="font-medium text-pulp underline decoration-white/25 underline-offset-4 hover:decoration-citron"
            href="/privacy"
          >
            Privacy Policy
          </a>
          . Publishing requires a separate, explicit Terms acceptance in your dashboard.
        </p>
      </div>

      <div className="flex justify-center lg:justify-end">
        <DeviceApproval />
      </div>
    </section>
  );
}
