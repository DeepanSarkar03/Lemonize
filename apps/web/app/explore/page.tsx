import { ExploreClient } from '@/components/ExploreClient';

export default async function Explore({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const query = (await searchParams).q?.trim().slice(0, 64) ?? '';
  return <ExploreClient query={query} />;
}
