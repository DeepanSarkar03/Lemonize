import { ExploreClient } from '@/components/ExploreClient';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Explore packages',
  description: 'Search packages published to the native Lemonize registry.',
};

export default async function Explore({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const query = (await searchParams).q?.trim().slice(0, 64) ?? '';
  return <ExploreClient query={query} />;
}
