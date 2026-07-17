import { PackageDetailClient } from '@/components/PackageDetailClient';

export default async function PackageDetail({ params }: { params: Promise<{ name: string[] }> }) {
  const name = decodeURIComponent((await params).name.join('/'));
  return <PackageDetailClient name={name} />;
}
