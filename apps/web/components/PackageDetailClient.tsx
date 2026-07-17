'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowLeft, FingerprintSimple, Package, Tag, Users } from '@phosphor-icons/react';
import type { PackageMetadata } from '@lemonize/shared';
import { CopyBlock } from '@/components/CopyBlock';
import { fetchPackage } from '@/lib/registry-browser';
import { ReportPackage } from '@/components/ReportPackage';

export function PackageDetailClient({ name }: { name: string }) {
  const [pkg, setPackage] = useState<PackageMetadata | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    fetchPackage(name, controller.signal).then(
      (value) => {
        setPackage(value);
        setState('ready');
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setPackage(null);
        setState('missing');
      },
    );
    return () => controller.abort();
  }, [name]);

  if (state === 'loading') {
    return <div className="card py-16 text-center text-sm text-ink-600">Loading package…</div>;
  }
  if (state === 'missing' || !pkg) {
    return (
      <div className="card flex flex-col items-center gap-3 py-16 text-center">
        <Package size={22} weight="bold" className="text-lemon-text" />
        <p className="font-medium text-ink-900">Package unavailable</p>
        <p className="max-w-sm text-sm text-ink-600">
          It may not exist, or the registry may be temporarily unavailable.
        </p>
      </div>
    );
  }

  const latest = pkg.latest ?? pkg.distTags.latest;
  const latestVersion = latest ? pkg.versions[latest] : undefined;
  const versions = Object.keys(pkg.versions).sort().reverse();

  return (
    <div className="space-y-6">
      <Link
        href="/explore"
        className="hit-slop inline-flex items-center gap-1.5 text-sm text-ink-600 transition-colors hover:text-ink-900"
      >
        <ArrowLeft size={14} weight="bold" />
        Back to explore
      </Link>

      <div className="grid gap-8 lg:grid-cols-[1fr_18rem]">
        <div className="space-y-8">
          <div>
            <div className="flex items-baseline gap-3">
              <h1 className="font-serif text-3xl font-medium tracking-tight text-ink-900">
                {pkg.name}
              </h1>
              <span className="tag tnum">{latest}</span>
            </div>
            {pkg.description ? (
              <p className="mt-3 max-w-xl text-ink-600">{pkg.description}</p>
            ) : null}
          </div>

          <CopyBlock text={`lem add ${pkg.name}`} />

          <section>
            <h2 className="mb-3 text-sm font-medium uppercase tracking-[0.08em] text-ink-600">
              Readme
            </h2>
            <div className="card whitespace-pre-wrap font-mono text-sm leading-relaxed text-ink-900">
              {pkg.description || 'No README provided.'}
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-medium uppercase tracking-[0.08em] text-ink-600">
              Versions
            </h2>
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
              {versions.map((version) => (
                <li key={version} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span className="tnum font-mono text-ink-900">{version}</span>
                  <span className="tnum font-mono text-xs text-ink-600">
                    {(pkg.versions[version]!.tarballSize / 1024).toFixed(1)} KB
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <aside className="space-y-4 text-sm">
          <div className="card space-y-2.5">
            <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.08em] text-ink-600">
              <Tag size={13} weight="bold" /> Dist-tags
            </h3>
            {Object.entries(pkg.distTags).map(([tag, version]) => (
              <div key={tag} className="flex items-center justify-between font-mono text-xs">
                <span className="tag">{tag}</span>
                <span className="tnum text-ink-900">{version}</span>
              </div>
            ))}
          </div>

          {latestVersion ? (
            <div className="card space-y-2">
              <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.08em] text-ink-600">
                <FingerprintSimple size={13} weight="bold" /> Latest build
              </h3>
              <p className="break-all font-mono text-xs text-ink-600">{latestVersion.integrity}</p>
              <div className="flex justify-between pt-1 text-xs text-ink-600">
                <span>Published</span>
                <span className="tnum">
                  {new Date(latestVersion.publishedAt).toLocaleDateString()}
                </span>
              </div>
              <div className="flex justify-between text-xs text-ink-600">
                <span>Files</span>
                <span className="tnum">{latestVersion.fileCount}</span>
              </div>
            </div>
          ) : null}

          <div className="card space-y-2">
            <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.08em] text-ink-600">
              <Users size={13} weight="bold" /> Maintainers
            </h3>
            {pkg.maintainers.map((maintainer) => (
              <div key={maintainer} className="text-ink-900">
                {maintainer}
              </div>
            ))}
          </div>

          <ReportPackage name={pkg.name} versions={versions} />
        </aside>
      </div>
    </div>
  );
}
