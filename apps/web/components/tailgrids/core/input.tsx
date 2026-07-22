'use client';

import { cn } from '@/utils/cn';
import { cva, type VariantProps } from 'class-variance-authority';
import { Input as AriaInput, type InputProps as AriaInputProps } from 'react-aria-components';

const inputStyles = cva(
  'peer min-h-11 max-w-full rounded-lg border bg-surface px-4 py-2.5 text-sm text-ink-900 outline-none transition-[border-color,box-shadow] placeholder:text-ink-600/70 focus:ring-4 disabled:cursor-not-allowed disabled:opacity-50 data-[invalid]:border-pastel-redText data-[invalid]:ring-pastel-redBg',
  {
    variants: {
      state: {
        default: 'border-line focus:border-ink-900/35 focus:ring-citron/35',
        error: 'border-pastel-redText focus:ring-pastel-redBg',
        success: 'border-pastel-greenText focus:ring-pastel-greenBg',
      },
    },
  },
);

export interface InputProps extends AriaInputProps, VariantProps<typeof inputStyles> {}

export function Input({ state = 'default', className, ...inputProps }: InputProps) {
  return <AriaInput className={cn(inputStyles({ state }), className)} {...inputProps} />;
}
