import './globals.css';
import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { Newsreader } from 'next/font/google';
import { ClerkProvider } from '@clerk/nextjs';
import { Nav } from '@/components/Nav';

const editorial = Newsreader({
  subsets: ['latin'],
  weight: ['500', '600'],
  style: ['italic', 'normal'],
  variable: '--font-editorial',
});

export const metadata: Metadata = {
  title: 'Lemonize - developer package distribution',
  description:
    'Publish, install and run JavaScript/TypeScript packages with a Cloudflare-powered CDN.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider
      signInUrl="/login"
      afterSignOutUrl="/"
      appearance={{
        variables: {
          colorPrimary: '#111111',
          colorBackground: '#FFFFFF',
          colorText: '#111111',
          colorTextSecondary: '#5B5852',
          colorInputBackground: '#FFFFFF',
          colorInputText: '#111111',
          borderRadius: '0.5rem',
          fontFamily: 'var(--font-geist-sans)',
        },
        elements: {
          cardBox: 'shadow-none',
          card: 'border border-[#EAEAEA] shadow-none',
          formButtonPrimary: 'bg-[#111111] hover:bg-[#333333] normal-case shadow-none',
          footerActionLink: 'text-[#956400] hover:text-[#6f4b00]',
        },
      }}
    >
      <html
        lang="en"
        className={`${GeistSans.variable} ${GeistMono.variable} ${editorial.variable}`}
      >
        <body>
          <a href="#main" className="skip-link">
            Skip to main content
          </a>
          <Nav />
          <main id="main" className="container-page py-16">
            {children}
          </main>
          <footer className="border-t border-line py-10">
            <div className="container-page flex flex-col items-center justify-between gap-3 text-sm text-ink-600 sm:flex-row">
              <p>Lemonize. A demo package registry. Not affiliated with npm.</p>
              <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
                <a href="/docs" className="hit-slop hover:text-ink-900">
                  Docs
                </a>
                <a href="/explore" className="hit-slop hover:text-ink-900">
                  Explore
                </a>
                <a href="/terms" className="hit-slop hover:text-ink-900">
                  Terms
                </a>
                <a href="/privacy" className="hit-slop hover:text-ink-900">
                  Privacy
                </a>
              </div>
            </div>
          </footer>
        </body>
      </html>
    </ClerkProvider>
  );
}
