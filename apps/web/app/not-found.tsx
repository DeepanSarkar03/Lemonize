import Link from 'next/link';
import { CompassTool } from '@phosphor-icons/react/dist/ssr';

export default function NotFound() {
  return (
    <div className="flex flex-col items-center gap-4 py-24 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-lemon-bg text-lemon-text">
        <CompassTool size={22} weight="bold" />
      </div>
      <h1 className="font-serif text-2xl font-medium tracking-tight text-ink-900">Nothing here</h1>
      <p className="max-w-sm text-sm text-ink-600">
        This page, or the package version it points to, doesn&apos;t exist on this registry.
      </p>
      <Link href="/explore" className="btn mt-2">Explore packages</Link>
    </div>
  );
}
