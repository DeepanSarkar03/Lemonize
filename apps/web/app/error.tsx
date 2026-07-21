'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { ArrowClockwise, WarningCircle } from '@phosphor-icons/react';

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <section className="mx-auto flex max-w-xl flex-col items-center py-20 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-pastel-redBg text-pastel-redText">
        <WarningCircle size={22} weight="bold" aria-hidden />
      </div>
      <p className="technical-label mt-6 text-pastel-redText">Route interrupted</p>
      <h1 className="display-title mt-3 text-4xl">The request lost its path.</h1>
      <p className="mt-4 max-w-md text-sm leading-6 text-ink-600">
        The page hit an unexpected error. Retry the request, or return home and start a new route.
      </p>
      <div className="mt-7 flex flex-wrap justify-center gap-3">
        <button type="button" className="btn" onClick={reset}>
          <ArrowClockwise size={16} weight="bold" aria-hidden /> Retry
        </button>
        <Link href="/" className="btn-ghost">
          Return home
        </Link>
      </div>
    </section>
  );
}
