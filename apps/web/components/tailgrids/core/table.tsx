import { cn } from '@/utils/cn';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

const tableRootStyles = cva(
  'min-w-full overflow-hidden border-separate border-spacing-0 border-line bg-surface text-left',
  {
    variants: {
      fullBleed: {
        true: 'border-y',
        false: 'rounded-lg border',
      },
    },
    defaultVariants: {
      fullBleed: false,
    },
  },
);

type TableRootProps = ComponentProps<'table'> & VariantProps<typeof tableRootStyles>;

export function TableRoot({ className, fullBleed, ...props }: TableRootProps) {
  return (
    <div className="overflow-x-auto">
      <table className={cn(tableRootStyles({ fullBleed }), className)} {...props} />
    </div>
  );
}

const tableHeaderStyles = cva(
  'bg-paper text-ink-900 [&_th]:border-b [&_th]:border-line [&_th]:text-xs',
);

export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return <thead className={cn(tableHeaderStyles(), className)} {...props} />;
}

const tableBodyStyle = cva();

export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody className={cn(tableBodyStyle(), className)} {...props} />;
}

const tableHeadStyles = cva('px-5 py-3.5 font-medium');

export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return <th className={cn(tableHeadStyles(), className)} {...props} />;
}

const tableRowStyles = cva(
  '[&:not(:last-child)>td]:border-b [&:not(:last-child)>td]:border-line [&:not(:last-child)>th]:border-b [&:not(:last-child)>th]:border-line',
);

export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return <tr className={cn(tableRowStyles(), className)} {...props} />;
}

const tableCellStyles = cva('px-5 py-3.5 text-sm font-medium text-ink-600');

export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn(tableCellStyles(), className)} {...props} />;
}
