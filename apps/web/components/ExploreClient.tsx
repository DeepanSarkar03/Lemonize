'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowUpRight, MagnifyingGlass, Package } from '@phosphor-icons/react';
import type { SearchResultItem } from '@lemonize/shared';
import { fetchSearch } from '@/lib/registry-browser';

export function ExploreClient({ query }: { query: string }) {
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [loading, setLoading] = useState(Boolean(query));

  useEffect(() => {
    if (!query) {
      setResults([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    fetchSearch(query, controller.signal).then(
      (value) => {
        setResults(value);
        setLoading(false);
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setResults([]);
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [query]);

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <h1 className="font-serif text-3xl font-medium tracking-tight text-ink-900">
          Explore packages
        </h1>
        <form action="/explore" method="get" className="flex gap-2">
          <div className="relative flex-1">
            <MagnifyingGlass
              size={16}
              weight="bold"
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-600"
            />
            <input
              name="q"
              defaultValue={query}
              placeholder="Search packages…"
              className="input pl-10"
            />
          </div>
          <button className="btn" type="submit">
            Search
          </button>
        </form>
      </div>

      {loading ? (
        <div className="card py-16 text-center text-sm text-ink-600">Searching…</div>
      ) : results.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 py-16 text-center">
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
        </div>
      ) : (
        <div className="stagger space-y-3">
          {results.map((result) => (
            <Link
              key={result.name}
              href={`/packages/${result.name}`}
              className="card card-hover group flex items-center justify-between gap-4 p-5"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-ink-900">{result.name}</span>
                  <span className="tag">{result.latest}</span>
                </div>
                {result.description ? (
                  <p className="mt-1.5 truncate text-sm text-ink-600">{result.description}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-4 text-xs text-ink-600">
                <span className="tnum">↓ {result.downloads}</span>
                <ArrowUpRight
                  size={16}
                  weight="bold"
                  className="text-ink-600 transition-transform duration-300 ease-spring group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-lemon-text"
                />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
