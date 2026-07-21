import { PackageDetailClient } from '@/components/PackageDetailClient';
import type { Metadata } from 'next';

type PackagePageProps = { params: Promise<{ name: string[] }> };

export async function generateMetadata({ params }: PackagePageProps): Promise<Metadata> {
  const name = decodeURIComponent((await params).name.join('/'));
  return {
    title: name,
    description: `View versions, integrity information, and install instructions for ${name} on Lemonize.`,
  };
}

export default async function PackageDetail({ params }: PackagePageProps) {
  const name = decodeURIComponent((await params).name.join('/'));
  return <PackageDetailClient name={name} />;
}
