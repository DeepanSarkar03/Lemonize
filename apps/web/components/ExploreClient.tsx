'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowUpRight, DownloadSimple, MagnifyingGlass, Package } from '@phosphor-icons/react';
import type { SearchResultItem } from '@lemonize/shared';
import { fetchSearch } from '@/lib/registry-browser';
import { Button } from '@/components/tailgrids/core/button';
import { Input } from '@/components/tailgrids/core/input';
import { Badge } from '@/components/tailgrids/core/badge';
import { Card } from '@/components/tailgrids/core/card';
import { Skeleton } from '@/components/tailgrids/core/skeleton';
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIndicator,
  AlertTitle,
} from '@/components/tailgrids/core/alert';

const suggestions = ['zod', 'react', 'typescript'];

export function ExploreClient({ query }: { query: string }) {
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [loading, setLoading] = useState(Boolean(query));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!query) {
      setResults([]);
      setLoading(false);
      setFailed(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    fetchSearch(query, controller.signal).then(
      (value) => {
        setResults(value);
        setLoading(false);
        setFailed(false);
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setResults([]);
        setLoading(false);
        setFailed(true);
      },
    );
    return () => controller.abort();
  }, [query]);

  return (
    <div className="space-y-10">
      <header className="grid gap-8 border-b border-ink-900/15 pb-10 lg:grid-cols-[0.75fr_1.25fr] lg:items-end">
        <div>
          <p className="technical-label text-lemon-text">Native registry / search</p>
          <h1 className="display-title mt-4 text-4xl sm:text-6xl">Find your next dependency.</h1>
          <p className="mt-4 max-w-md text-sm leading-6 text-ink-600">
            Search the immutable native registry by package name or description.
          </p>
        </div>
        <form
          action="/explore"
          method="get"
          className="rounded-2xl border border-line bg-surface p-3 shadow-subtle"
          role="search"
        >
          <div className="flex gap-2">
            <div className="relative flex-1">
              <label className="sr-only" htmlFor="package-search">
                Search packages by name or description
              </label>
              <MagnifyingGlass
                size={16}
                weight="bold"
                className="pointer-events-none absolute left-3.5 top-1/2 z-10 -translate-y-1/2 text-ink-600"
              />
              <Input
                id="package-search"
                name="q"
                defaultValue={query}
                placeholder="Search package names…"
                className="w-full pl-10"
              />
            </div>
            <Button type="submit" className="shrink-0">
              Search
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 px-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-600">
              Try
            </span>
            {suggestions.map((suggestion) => (
              <Link
                key={suggestion}
                href={`/explore?q=${suggestion}`}
                className="rounded-full bg-paper px-2.5 py-1 font-mono text-[11px] text-ink-600 transition-colors hover:bg-lemon-bg hover:text-lemon-text"
              >
                {suggestion}
              </Link>
            ))}
          </div>
        </form>
      </header>

      {loading ? (
        <div className="space-y-3" role="status" aria-live="polite" aria-label="Searching">
          {[0, 1, 2].map((item) => (
            <Card key={item} className="gap-4 p-5">
              <div className="flex items-center justify-between gap-6">
                <div className="w-full max-w-md space-y-3">
                  <Skeleton className="h-4 w-2/5" />
                  <Skeleton className="h-3 w-4/5" />
                </div>
                <Skeleton className="h-8 w-20" />
              </div>
            </Card>
          ))}
        </div>
      ) : failed ? (
        <Alert status="error" className="max-w-none">
          <AlertIndicator />
          <AlertContent>
            <AlertTitle>Search is temporarily unavailable</AlertTitle>
            <AlertDescription>Try the same search again in a moment.</AlertDescription>
          </AlertContent>
        </Alert>
      ) : results.length === 0 ? (
        <Card className="items-center gap-3 px-6 py-16 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-lemon-bg text-lemon-text">
            <Package size={20} weight="bold" />
          </div>
          {query ? (
            <>
              <p className="font-medium text-ink-900">No packages match &ldquo;{query}&rdquo;</p>
              <p className="max-w-sm text-sm text-ink-600">Try a different search term.</p>
            </>
          ) : (
            <>
              <p className="font-medium text-ink-900">Search the registry</p>
              <p className="max-w-sm text-sm text-ink-600">Find packages by name or description.</p>
            </>
          )}
        </Card>
      ) : (
        <div>
          <p className="sr-only" role="status" aria-live="polite">
            {results.length} {results.length === 1 ? 'package' : 'packages'} found.
          </p>
          <ul className="stagger space-y-3">
            {results.map((result) => (
              <li key={result.name}>
                <Link href={`/packages/${result.name}`} className="group block">
                  <Card className="card-hover flex-row items-center justify-between gap-4 p-5">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-ink-900">
                          {result.name}
                        </span>
                        <Badge color="primary">{result.latest}</Badge>
                      </div>
                      {result.description ? (
                        <p className="mt-2 truncate text-sm text-ink-600">{result.description}</p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-4 text-xs text-ink-600">
                      <span className="tnum hidden items-center gap-1.5 font-mono sm:flex">
                        <DownloadSimple size={14} weight="bold" /> {result.downloads}
                      </span>
                      <span className="flex h-9 w-9 items-center justify-center rounded-full border border-line transition-colors group-hover:border-citron group-hover:bg-lemon-bg">
                        <ArrowUpRight
                          size={15}
                          weight="bold"
                          className="transition-transform duration-300 ease-spring group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-lemon-text"
                        />
                      </span>
                    </div>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
