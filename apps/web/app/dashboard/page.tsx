import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { DashboardClient } from '@/components/DashboardClient';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Dashboard',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const { userId } = await auth();
  if (!userId) redirect('/login');

  return <DashboardClient />;
}
