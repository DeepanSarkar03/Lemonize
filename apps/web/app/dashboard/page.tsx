import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { DashboardClient } from '@/components/DashboardClient';

export const dynamic = 'force-dynamic';
export const runtime = 'edge';

export default async function Dashboard() {
  const { userId } = await auth();
  if (!userId) redirect('/login');

  return <DashboardClient />;
}
