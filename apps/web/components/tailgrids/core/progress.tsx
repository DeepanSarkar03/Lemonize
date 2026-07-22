'use client';

import { cn } from '@/utils/cn';
import type { ComponentProps } from 'react';

type ProgressProps = {
  progress: number;
  withLabel?: boolean;
  className?: string;
  trackColor?: string;
  barColor?: string;
} & Pick<ComponentProps<'div'>, 'aria-label' | 'aria-labelledby'>;

export function Progress({
  progress,
  withLabel,
  className,
  trackColor,
  barColor,
  ...ariaProps
}: ProgressProps) {
  const value = Math.max(0, Math.min(100, progress));

  return (
    <div className={cn('flex max-w-80 items-center gap-3', className)}>
      <div
        {...ariaProps}
        className="relative h-2 w-full rounded-full"
        style={{
          // Fix overflow clipping in Safari
          // https://gist.github.com/domske/b66047671c780a238b51c51ffde8d3a0
          transform: 'translateZ(0)',
          backgroundColor: trackColor ?? '#D9DCCE',
        }}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={value}
        aria-valuetext={`${value}%`}
        role="progressbar"
      >
        <div className="size-full overflow-hidden rounded-full">
          <div
            className="size-full rounded-full text-center"
            style={{
              transform: `translateX(-${100 - value}%)`,
              backgroundColor: barColor || '#D7F25A',
            }}
          />
        </div>
      </div>

      {withLabel && <div className="text-sm font-medium leading-none text-ink-600">{value}%</div>}
    </div>
  );
}
