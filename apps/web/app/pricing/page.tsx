import { PricingTable } from '@clerk/nextjs';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'Public Lemonize packages are free. Private packages require a paid plan.',
};

export default function PricingPage() {
  return (
    <main className="container-page py-16 sm:py-24">
      <section className="mx-auto max-w-3xl text-center">
        <p className="technical-label text-citron">Simple registry pricing</p>
        <h1 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.055em] text-ink-900 sm:text-6xl">
          Publish in public for free.
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-pretty text-base leading-7 text-ink-600 sm:text-lg">
          Every active account can publish public packages in its Lemonize namespace. Choose a paid
          user plan only when you need owner-only private packages.
        </p>
      </section>

      <section className="mx-auto mt-12 max-w-5xl rounded-3xl border border-line bg-surface p-4 shadow-[0_24px_80px_rgba(16,18,15,0.08)] sm:p-8">
        <PricingTable
          for="user"
          newSubscriptionRedirectUrl="/dashboard"
          appearance={{
            elements: {
              rootBox: 'w-full',
              card: 'border-line shadow-none',
            },
          }}
        />
      </section>

      <p className="mx-auto mt-8 max-w-2xl text-center text-sm leading-6 text-ink-600">
        Private metadata and tarballs are restricted to the package owner and are never stored in a
        shared CDN cache. Canceling or losing the paid entitlement removes private-package access.
      </p>
    </main>
  );
}
