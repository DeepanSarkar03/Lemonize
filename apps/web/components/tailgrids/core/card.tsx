import { cn } from '@/utils/cn';
import { ComponentProps } from 'react';

export function Card({ children, className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex w-full flex-col gap-3 rounded-2xl border border-line bg-surface',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({ children, className }: ComponentProps<'div'>) {
  return <div className={cn('w-full px-5 pt-5 relative', className)}>{children}</div>;
}

export function CardTitle({ children, className }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'text-xl font-semibold leading-7 tracking-[-0.025em] text-ink-900 md:text-2xl',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardDescription({ children, className }: ComponentProps<'div'>) {
  return (
    <div className={cn('mt-0.5 text-base leading-6 tracking-[-0.01em] text-ink-600', className)}>
      {children}
    </div>
  );
}

export function CardAction({ children, className }: ComponentProps<'div'>) {
  return <div className={cn('absolute right-5 top-5 text-ink-600', className)}>{children}</div>;
}

export function CardContent({ children, className }: ComponentProps<'div'>) {
  return <div className={cn('px-5 text-ink-600', className)}>{children}</div>;
}

export function CardFooter({ children, className }: ComponentProps<'div'>) {
  return <div className={cn('px-5 pb-5', className)}>{children}</div>;
}
