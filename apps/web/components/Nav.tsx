'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SignedIn, SignedOut, UserButton } from '@clerk/nextjs';
import { Compass, BookOpen, SquaresFour, SignIn } from '@phosphor-icons/react/dist/ssr';

const links = [
  { href: '/explore', label: 'Explore', icon: Compass },
  { href: '/docs', label: 'Docs', icon: BookOpen },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-paper/90 backdrop-blur-md">
      <nav className="container-page flex items-center justify-between py-4">
        <Link
          href="/"
          className="flex items-center gap-2 font-semibold tracking-tight text-ink-900"
        >
          <span className="inline-block h-6 w-6 rounded-md bg-lemon-swatch" />
          <span>Lemonize</span>
          <span className="tag hidden sm:inline-flex">lem</span>
        </Link>
        <div className="flex items-center gap-1 text-sm text-ink-600">
          {links.map(({ href, label, icon: Icon }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                className={`relative flex items-center gap-1.5 rounded-md px-3 py-2 transition-colors duration-150 ease-out ${
                  active ? 'text-ink-900' : 'hover:text-ink-900'
                }`}
                aria-current={active ? 'page' : undefined}
              >
                <Icon size={15} weight="bold" />
                <span className="hidden sm:inline">{label}</span>
                {active ? (
                  <span className="absolute inset-x-3 -bottom-[1px] h-px bg-ink-900" aria-hidden />
                ) : null}
              </Link>
            );
          })}

          <SignedIn>
            <Link
              href="/dashboard"
              className={`relative flex items-center gap-1.5 rounded-md px-3 py-2 transition-colors duration-150 ease-out ${
                pathname === '/dashboard' ? 'text-ink-900' : 'hover:text-ink-900'
              }`}
              aria-current={pathname === '/dashboard' ? 'page' : undefined}
            >
              <SquaresFour size={15} weight="bold" />
              <span className="hidden sm:inline">Dashboard</span>
              {pathname === '/dashboard' ? (
                <span className="absolute inset-x-3 -bottom-[1px] h-px bg-ink-900" aria-hidden />
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
            <Link href="/login" className="hit-slop btn-ghost ml-2 py-1.5">
              <SignIn size={15} weight="bold" />
              <span className="hidden sm:inline">Sign in</span>
            </Link>
          </SignedOut>
        </div>
      </nav>
    </header>
  );
}
