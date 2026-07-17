import type { Metadata } from 'next';
import { LockKey } from '@phosphor-icons/react/dist/ssr';
import { DeviceApproval } from '@/components/DeviceApproval';

export const metadata: Metadata = {
  title: 'Sign in | Lemonize',
  description: 'Sign in to your private Lemonize dashboard.',
};

export const dynamic = 'force-dynamic';
export const runtime = 'edge';

export default function LoginPage() {
  return (
    <section className="grid min-h-[calc(100dvh-14rem)] items-center gap-12 lg:grid-cols-[0.85fr_1fr]">
      <div className="max-w-md space-y-5">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-lemon-bg text-lemon-text">
          <LockKey size={20} weight="bold" />
        </div>
        <div className="space-y-3">
          <h1 className="font-serif text-3xl font-medium tracking-tight text-ink-900">
            Access your registry workspace
          </h1>
          <p className="leading-relaxed text-ink-600">
            Sign in with GitHub to claim an immutable publisher namespace. Your GitHub connection
            establishes publisher eligibility; the registry may still be read-only during maintenance.
          </p>
        </div>
        <p className="text-sm leading-relaxed text-ink-600">
          By continuing, you agree to the{' '}
          <a
            className="font-medium text-ink-900 underline decoration-line underline-offset-4 hover:decoration-ink-900"
            href="/terms"
          >
            Terms
          </a>{' '}
          and acknowledge the{' '}
          <a
            className="font-medium text-ink-900 underline decoration-line underline-offset-4 hover:decoration-ink-900"
            href="/privacy"
          >
            Privacy Policy
          </a>
          .
        </p>
      </div>

      <div className="flex justify-center lg:justify-end">
        <DeviceApproval />
      </div>
    </section>
  );
}
