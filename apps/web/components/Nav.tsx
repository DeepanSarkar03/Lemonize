'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SignedIn, SignedOut, UserButton } from '@clerk/nextjs';
import { Compass, BookOpen, Package, SquaresFour, SignIn } from '@phosphor-icons/react/dist/ssr';
import { BrandMark } from '@/components/BrandMark';

const links: Array<{
  href: string;
  label: string;
  icon: typeof Package;
  activePath?: string | null;
}> = [
  { href: '/docs#npm-cdn', activePath: null, label: 'CDN', icon: Package },
  { href: '/explore', label: 'Explore', icon: Compass },
  { href: '/docs', label: 'Docs', icon: BookOpen },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-ink-900/10 bg-paper/85 backdrop-blur-xl">
      <nav className="container-page flex min-h-16 items-center justify-between py-2">
        <Link
          href="/"
          className="group flex items-center gap-2.5 font-semibold tracking-[-0.04em] text-ink-900"
          aria-label="Lemonize home"
        >
          <BrandMark className="h-8 w-8 transition-transform duration-300 ease-spring group-hover:-rotate-3" />
          <span className="hidden text-[17px] min-[420px]:inline">lemonize</span>
          <span className="technical-label hidden text-ink-600 lg:inline">edge / 01</span>
        </Link>
        <div className="flex items-center gap-0.5 text-sm text-ink-600 sm:gap-1">
          {links.map(({ href, label, icon: Icon, activePath }) => {
            const active = activePath === null ? false : pathname === (activePath ?? href);
            return (
              <Link
                key={href}
                href={href}
                aria-label={label}
                className={`relative flex min-h-11 items-center gap-1.5 rounded-lg px-2.5 transition-colors duration-150 ease-out sm:px-3 ${
                  active ? 'text-ink-900' : 'hover:text-ink-900'
                }`}
                aria-current={active ? 'page' : undefined}
              >
                <Icon size={15} weight="bold" aria-hidden />
                <span className="hidden sm:inline">{label}</span>
                {active ? (
                  <span className="absolute inset-x-3 -bottom-[3px] h-0.5 bg-citron" aria-hidden />
                ) : null}
              </Link>
            );
          })}

          <SignedIn>
            <Link
              href="/dashboard"
              aria-label="Dashboard"
              className={`relative flex min-h-11 items-center gap-1.5 rounded-lg px-2.5 transition-colors duration-150 ease-out sm:px-3 ${
                pathname === '/dashboard' ? 'text-ink-900' : 'hover:text-ink-900'
              }`}
              aria-current={pathname === '/dashboard' ? 'page' : undefined}
            >
              <SquaresFour size={15} weight="bold" aria-hidden />
              <span className="hidden sm:inline">Dashboard</span>
              {pathname === '/dashboard' ? (
                <span className="absolute inset-x-3 -bottom-[3px] h-0.5 bg-citron" aria-hidden />
              ) : null}
            </Link>
            <div className="ml-2 flex h-9 w-9 items-center justify-center">
              <UserButton
                appearance={{
                  elements: {
                    avatarBox: 'h-8 w-8',
                    userButtonTrigger: 'focus:shadow-none',
                  },
                }}
              />
            </div>
          </SignedIn>

          <SignedOut>
            <Link href="/login" className="hit-slop btn-ghost ml-2 py-1.5" aria-label="Sign in">
              <SignIn size={15} weight="bold" aria-hidden />
              <span className="hidden sm:inline">Sign in</span>
            </Link>
          </SignedOut>
        </div>
      </nav>
    </header>
  );
}
