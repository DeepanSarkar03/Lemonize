import './globals.css';
import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { Newsreader } from 'next/font/google';
import { ClerkProvider } from '@clerk/nextjs';
import Link from 'next/link';
import { Nav } from '@/components/Nav';
import { BrandMark } from '@/components/BrandMark';
import { SpeedInsights } from '@vercel/speed-insights/next';

const editorial = Newsreader({
  subsets: ['latin'],
  weight: ['500', '600'],
  style: ['italic', 'normal'],
  variable: '--font-editorial',
});

export const metadata: Metadata = {
  metadataBase: new URL('https://lemonize.cyou'),
  title: {
    default: 'Lemonize — packages from origin to edge',
    template: '%s | Lemonize',
  },
  description:
    'Install npm packages through a Cloudflare-powered edge gateway, or publish immutable packages to the native Lemonize registry.',
  applicationName: 'Lemonize',
  keywords: ['npm CDN', 'package registry', 'JavaScript packages', 'Cloudflare CDN'],
  openGraph: {
    type: 'website',
    siteName: 'Lemonize',
    title: 'Lemonize — from origin to edge',
    description: 'A fast edge path for npm packages and immutable first-party releases.',
    url: '/',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Lemonize — from origin to edge',
    description: 'A fast edge path for npm packages and immutable first-party releases.',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider
      signInUrl="/login"
      afterSignOutUrl="/"
      appearance={{
        variables: {
          colorPrimary: '#10120F',
          colorBackground: '#FBF9F2',
          colorText: '#10120F',
          colorTextSecondary: '#62675B',
          colorInputBackground: '#F3F0E6',
          colorInputText: '#10120F',
          borderRadius: '0.75rem',
          fontFamily: 'var(--font-geist-sans)',
        },
        elements: {
          cardBox: 'shadow-none',
          card: 'border border-[#D9DCCE] shadow-none',
          formButtonPrimary: 'bg-[#10120F] hover:bg-[#171A15] normal-case shadow-none',
          footerActionLink: 'text-[#465800] hover:text-[#10120F]',
        },
      }}
    >
      <html
        lang="en"
        className={`${GeistSans.variable} ${GeistMono.variable} ${editorial.variable}`}
      >
        <body className="flex min-h-dvh flex-col">
          <a href="#main" className="skip-link">
            Skip to main content
          </a>
          <Nav />
          <main id="main" className="container-page flex-1 py-12 sm:py-16">
            {children}
          </main>
          <footer className="mt-10 border-t border-ink-900/10 bg-carbon py-10 text-pulp">
            <div className="container-page grid gap-8 sm:grid-cols-[1fr_auto] sm:items-end">
              <div className="max-w-md">
                <Link
                  href="/"
                  className="inline-flex items-center gap-3"
                  aria-label="Lemonize home"
                >
                  <BrandMark className="h-9 w-9" tone="onDark" />
                  <span className="text-lg font-semibold tracking-[-0.04em]">lemonize</span>
                </Link>
                <p className="mt-4 text-sm leading-6 text-pulp/55">
                  Package infrastructure from origin to edge. Independent from and not affiliated
                  with npm, Inc.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-sm text-pulp/60">
                <Link href="/docs" className="hit-slop hover:text-citron">
                  Docs
                </Link>
                <Link href="/explore" className="hit-slop hover:text-citron">
                  Explore
                </Link>
                <Link href="/terms" className="hit-slop hover:text-citron">
                  Terms
                </Link>
                <Link href="/privacy" className="hit-slop hover:text-citron">
                  Privacy
                </Link>
              </div>
            </div>
          </footer>
          <SpeedInsights />
        </body>
      </html>
    </ClerkProvider>
  );
}
