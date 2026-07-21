'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  FingerprintSimple,
  Package,
  ShieldCheck,
  Tag,
  Users,
} from '@phosphor-icons/react';
import type { PackageMetadata } from '@lemonize/shared';
import { CopyBlock } from '@/components/CopyBlock';
import { fetchPackage } from '@/lib/registry-browser';
import { ReportPackage } from '@/components/ReportPackage';
import { Badge } from '@/components/tailgrids/core/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/tailgrids/core/card';
import { Skeleton } from '@/components/tailgrids/core/skeleton';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRoot,
  TableRow,
} from '@/components/tailgrids/core/table';

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
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading package">
        <Skeleton className="h-4 w-28" />
        <Card className="gap-6 p-7 sm:p-9">
          <Skeleton className="h-9 w-1/2" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-12 w-full" />
        </Card>
      </div>
    );
  }
  if (state === 'missing' || !pkg) {
    return (
      <Card className="items-center gap-3 px-6 py-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-lemon-bg text-lemon-text">
          <Package size={22} weight="bold" />
        </div>
        <p className="font-medium text-ink-900">Package unavailable</p>
        <p className="max-w-sm text-sm text-ink-600">
          It may not exist, or the registry may be temporarily unavailable.
        </p>
        <Link href="/explore" className="btn-ghost mt-2">
          Back to search
        </Link>
      </Card>
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

      <section className="route-grid overflow-hidden rounded-[2rem] bg-carbon text-pulp">
        <div className="grid gap-8 px-6 py-8 sm:px-9 sm:py-10 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <Badge color="success" prefixIcon={<ShieldCheck weight="fill" />}>
                Integrity verified
              </Badge>
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-pulp/55">
                Native package
              </span>
            </div>
            <h1 className="mt-5 break-all font-mono text-3xl font-semibold tracking-[-0.05em] text-pulp sm:text-5xl">
              {pkg.name}
            </h1>
            {pkg.description ? (
              <p className="mt-4 max-w-2xl leading-7 text-pulp/60">{pkg.description}</p>
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            <span className="technical-label text-pulp/55">Latest</span>
            <span className="rounded-lg bg-citron px-3 py-2 font-mono text-sm font-semibold text-carbon">
              {latest}
            </span>
          </div>
        </div>
        <div className="border-t border-white/10 px-6 py-4 sm:px-9">
          <div className="max-w-2xl [&>div]:border-white/10 [&>div]:bg-white/5 [&_button]:text-pulp/60 [&_button:hover]:text-citron [&_code]:text-pulp">
            <CopyBlock text={`lem add ${pkg.name}`} />
          </div>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Readme</CardTitle>
            </CardHeader>
            <CardContent className="whitespace-pre-wrap pb-6 font-mono text-sm leading-7 text-ink-600">
              {pkg.description || 'No README provided.'}
            </CardContent>
          </Card>

          <section>
            <div className="mb-3 flex items-end justify-between gap-4">
              <div>
                <p className="technical-label text-lemon-text">Release history</p>
                <h2 className="mt-2 text-xl font-semibold tracking-tight text-ink-900">Versions</h2>
              </div>
              <span className="font-mono text-xs text-ink-600">{versions.length} total</span>
            </div>
            <TableRoot>
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead>Published</TableHead>
                  <TableHead className="text-right">Tarball</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {versions.map((version) => (
                  <TableRow key={version}>
                    <TableCell>
                      <span className="font-mono text-ink-900">{version}</span>
                      {version === latest ? <Badge className="ml-2">Latest</Badge> : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {new Date(pkg.versions[version]!.publishedAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {(pkg.versions[version]!.tarballSize / 1024).toFixed(1)} KB
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </TableRoot>
          </section>
        </div>

        <aside className="space-y-4 text-sm">
          <Card className="p-5">
            <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.08em] text-ink-600">
              <Tag size={13} weight="bold" /> Dist-tags
            </h3>
            <div className="mt-2 space-y-3">
              {Object.entries(pkg.distTags).map(([tag, version]) => (
                <div key={tag} className="flex items-center justify-between font-mono text-xs">
                  <Badge>{tag}</Badge>
                  <span className="tnum text-ink-900">{version}</span>
                </div>
              ))}
            </div>
          </Card>

          {latestVersion ? (
            <Card className="p-5">
              <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.08em] text-ink-600">
                <FingerprintSimple size={13} weight="bold" /> Latest build
              </h3>
              <p className="mt-2 break-all font-mono text-[11px] leading-5 text-ink-600">
                {latestVersion.integrity}
              </p>
              <div className="mt-2 flex justify-between border-t border-line pt-3 text-xs text-ink-600">
                <span>Files</span>
                <span className="tnum">{latestVersion.fileCount}</span>
              </div>
            </Card>
          ) : null}

          <Card className="p-5">
            <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.08em] text-ink-600">
              <Users size={13} weight="bold" /> Maintainers
            </h3>
            <div className="mt-2 space-y-1.5">
              {pkg.maintainers.map((maintainer) => (
                <div key={maintainer} className="font-mono text-xs text-ink-900">
                  {maintainer}
                </div>
              ))}
            </div>
          </Card>

          <ReportPackage name={pkg.name} versions={versions} />
        </aside>
      </div>
    </div>
  );
}
