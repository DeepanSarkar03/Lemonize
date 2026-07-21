'use client';

import { CopyBlock } from '@/components/CopyBlock';
import { TabContent, TabList, TabRoot, TabTrigger } from '@/components/tailgrids/core/tabs';

const clients = [
  {
    id: 'npm',
    label: 'npm',
    command: 'npm install zod --registry=https://npm.lemonize.cyou',
  },
  {
    id: 'pnpm',
    label: 'pnpm',
    command: 'pnpm add zod --registry=https://npm.lemonize.cyou',
  },
  {
    id: 'yarn',
    label: 'Yarn',
    command: 'yarn add zod --registry https://npm.lemonize.cyou',
  },
  {
    id: 'bun',
    label: 'Bun',
    command: 'bun add zod --registry=https://npm.lemonize.cyou',
  },
] as const;

export function RegistryInstallTabs() {
  return (
    <TabRoot defaultValue="npm" className="overflow-hidden">
      <TabList className="min-w-max">
        {clients.map((client) => (
          <TabTrigger key={client.id} value={client.id} className="min-w-20 justify-center">
            {client.label}
          </TabTrigger>
        ))}
      </TabList>
      {clients.map((client) => (
        <TabContent key={client.id} value={client.id} className="bg-carbon px-4 py-5 sm:px-5">
          <div className="[&>div]:border-white/10 [&>div]:bg-white/5 [&_button]:text-pulp/60 [&_button:hover]:text-citron [&_code]:text-pulp">
            <CopyBlock text={client.command} />
          </div>
        </TabContent>
      ))}
    </TabRoot>
  );
}
