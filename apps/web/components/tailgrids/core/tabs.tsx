'use client';

import { cn } from '@/utils/cn';
import { cva } from 'class-variance-authority';
import { createContext, type HTMLAttributes, useContext, useId, useState } from 'react';
import { Badge } from './badge';

type StyleVariant = 'default' | 'minimal';
type TabDirection = 'vertical' | 'horizontal';

type TabsContextType = {
  activeTab: string;
  setActiveTab: (id: string) => void;
  variant: StyleVariant;
  direction: TabDirection;
  id: string;
};

const TabsContext = createContext<TabsContextType | undefined>(undefined);

function useTabsContext() {
  const context = useContext(TabsContext);

  if (!context) {
    throw new Error('useTabsContext must be used within a Tabs Component');
  }

  return context;
}

const tabRootStyles = cva('max-w-full rounded-2xl border border-line bg-surface', {
  variants: {
    variant: {
      default: '',
      minimal: '',
    },
    direction: {
      vertical: '',
      horizontal: 'flex gap-8 p-6 max-sm:flex-wrap',
    },
  },
  compoundVariants: [
    {
      variant: 'minimal',
      direction: 'vertical',
      className: 'px-6 pt-3',
    },
  ],
});

type TabsProps = {
  defaultValue: string;
  children: React.ReactNode;
  className?: string;
  variant?: StyleVariant;
  direction?: 'vertical' | 'horizontal';
};

export function TabRoot({
  defaultValue,
  children,
  className,
  variant = 'default',
  direction = 'vertical',
}: TabsProps) {
  const [activeTab, setActiveTab] = useState(defaultValue);
  const id = useId();

  return (
    <TabsContext.Provider value={{ activeTab, setActiveTab, variant, id, direction }}>
      <div className={cn(tabRootStyles({ variant, direction }), className)}>{children}</div>
    </TabsContext.Provider>
  );
}

const tabListWrapperStyles = cva('max-sm:w-full', {
  variants: {
    variant: {
      default: '',
      minimal: '',
    },
    direction: {
      vertical: '',
      horizontal: '',
    },
  },
  compoundVariants: [
    {
      direction: 'vertical',
      className: 'border-b border-line [&>div]:w-full',
    },
    {
      direction: 'vertical',
      variant: 'default',
      className: 'p-3 [&>div]:rounded-lg [&>div]:bg-paper [&>div]:p-1',
    },
  ],
});

const tabListStyles = cva('flex overflow-x-auto overflow-y-hidden', {
  variants: {
    variant: {
      default: '',
      minimal: '',
    },
    direction: {
      vertical: '',
      horizontal: 'flex-col gap-2 max-sm:items-center sm:min-w-50',
    },
  },
  compoundVariants: [
    {
      direction: 'vertical',
      variant: 'default',
      className: 'gap-1',
    },
    {
      direction: 'vertical',
      variant: 'minimal',
      className: 'gap-2',
    },
  ],
});

type TabListProps = {
  children: React.ReactNode;
  className?: string;
};

export function TabList({ children, className }: TabListProps) {
  const { variant, direction } = useTabsContext();

  return (
    <div className={tabListWrapperStyles({ variant, direction })}>
      <div role="tablist" className={cn(tabListStyles({ variant, direction }), className)}>
        {children}
      </div>
    </div>
  );
}

const tabTriggerStyles = cva(
  'flex items-center gap-2 whitespace-nowrap px-3 text-sm font-medium text-ink-600 outline-none transition-colors [&>svg]:h-5 [&>svg]:w-5',
  {
    variants: {
      variant: {
        default: '',
        minimal: '',
      },
      direction: {
        vertical: '',
        horizontal:
          'rounded-lg p-3 hover:bg-paper hover:text-ink-900 max-sm:w-full max-sm:justify-center',
      },
    },
    compoundVariants: [
      {
        direction: 'vertical',
        variant: 'default',
        className:
          'rounded-md py-2 data-[active=true]:bg-surface data-[active=true]:text-ink-900 data-[active=true]:shadow-sm',
      },
      {
        direction: 'vertical',
        variant: 'minimal',
        className:
          'border-b-2 border-transparent py-3.5 data-[active=true]:border-citron data-[active=true]:text-ink-900',
      },
      {
        direction: 'horizontal',
        variant: 'default',
        className: 'data-[active=true]:bg-lemon-bg data-[active=true]:text-lemon-text',
      },
      {
        direction: 'horizontal',
        variant: 'minimal',
        className:
          'border border-transparent data-[active=true]:border-citron data-[active=true]:text-ink-900',
      },
    ],
  },
);

type TabTriggerProps = HTMLAttributes<HTMLButtonElement> & {
  value: string;
  icon?: React.ReactNode;
  badge?: string | number;
};

export function TabTrigger({ value, children, className, icon, badge, ...props }: TabTriggerProps) {
  const { activeTab, setActiveTab, variant, id, direction } = useTabsContext();
  const isActive = activeTab === value;

  return (
    <button
      data-active={isActive}
      onClick={() => setActiveTab(value)}
      className={cn(tabTriggerStyles({ variant, direction }), className)}
      role="tab"
      aria-selected={isActive}
      id={`${id}-trigger-${value}`}
      aria-controls={`${id}-content-${value}`}
      {...props}
    >
      {icon}
      {children}
      {badge && (
        <Badge size={'sm'} color="primary">
          {badge}
        </Badge>
      )}
    </button>
  );
}

const tabContentStyles = cva('text-sm font-normal text-ink-600', {
  variants: {
    variant: {
      default: '',
      minimal: '',
    },
    direction: {
      horizontal: '',
      vertical: '',
    },
  },
  compoundVariants: [
    {
      direction: 'vertical',
      className: 'py-6',
    },
    {
      direction: 'vertical',
      variant: 'default',
      className: 'px-6',
    },
  ],
});

type TabContentProps = {
  value: string;
  children: React.ReactNode;
  className?: string;
};

export function TabContent({ value, children, className }: TabContentProps) {
  const { activeTab, id, variant, direction } = useTabsContext();

  return (
    <div
      role="tabpanel"
      id={`${id}-content-${value}`}
      aria-labelledby={`${id}-trigger-${value}`}
      className={cn(tabContentStyles({ variant, direction }), className)}
      hidden={activeTab !== value}
    >
      {children}
    </div>
  );
}
