'use client';

import { cn } from '@/utils/cn';
import { cva, VariantProps } from 'class-variance-authority';
import { Button as AriaButton, type ButtonProps as AriaButtonProps } from 'react-aria-components';

export const buttonStyles = cva(
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg font-medium outline-none transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 [&>svg]:shrink-0 [&>svg]:text-current',
  {
    variants: {
      variant: {
        primary: '',
        danger: '',
        success: '',
        ghost: '',
      },
      appearance: {
        fill: '',
        outline: '',
      },
      iconOnly: {
        true: '',
        false: '',
      },
      size: {
        xs: 'text-xs [&>svg]:h-4 [&>svg]:w-4',
        sm: 'text-sm [&>svg]:h-4 [&>svg]:w-4',
        md: 'text-sm [&>svg]:h-5 [&>svg]:w-5',
        lg: 'text-base [&>svg]:h-5 [&>svg]:w-5',
      },
    },
    compoundVariants: [
      {
        variant: ['primary', 'danger', 'success'],
        appearance: 'fill',
        className: 'border border-transparent text-pulp',
      },
      {
        variant: ['primary', 'danger', 'success'],
        appearance: 'outline',
        // Disabled styles
        className: 'border bg-transparent',
      },
      {
        variant: 'primary',
        appearance: 'fill',
        className:
          'bg-carbon text-pulp hover:bg-graphite focus-visible:ring-4 focus-visible:ring-citron/60',
      },
      {
        variant: 'primary',
        appearance: 'outline',
        className:
          'border-line bg-surface text-ink-900 hover:border-ink-600/40 hover:bg-paper focus-visible:ring-4 focus-visible:ring-citron/60',
      },
      {
        variant: 'danger',
        appearance: 'fill',
        className:
          'bg-pastel-redText text-white hover:bg-[#7D382F] focus-visible:ring-4 focus-visible:ring-pastel-redBg',
      },
      {
        variant: 'danger',
        appearance: 'outline',
        className:
          'border-pastel-redText/30 bg-pastel-redBg text-pastel-redText hover:border-pastel-redText/50 focus-visible:ring-4 focus-visible:ring-pastel-redBg',
      },
      {
        variant: 'success',
        appearance: 'fill',
        className:
          'bg-pastel-greenText text-white hover:bg-[#31552D] focus-visible:ring-4 focus-visible:ring-pastel-greenBg',
      },
      {
        variant: 'success',
        appearance: 'outline',
        className:
          'border-pastel-greenText/30 bg-pastel-greenBg text-pastel-greenText hover:border-pastel-greenText/50 focus-visible:ring-4 focus-visible:ring-pastel-greenBg',
      },
      {
        variant: 'ghost',
        className:
          'text-ink-600 hover:bg-surface hover:text-ink-900 focus-visible:ring-4 focus-visible:ring-citron/60',
      },
      {
        iconOnly: true,
        size: 'xs',
        className: 'h-8 min-h-8 w-8',
      },
      {
        iconOnly: true,
        size: 'sm',
        className: 'h-10 min-h-10 w-10',
      },
      {
        iconOnly: false,
        size: ['xs', 'sm'],
        className: 'px-3.5',
      },
      {
        iconOnly: true,
        size: 'md',
        className: 'h-11 w-11',
      },
      {
        iconOnly: false,
        size: 'md',
        className: 'px-4',
      },
      {
        iconOnly: true,
        size: 'lg',
        className: 'h-12 w-12',
      },
      {
        iconOnly: false,
        size: 'lg',
        className: 'px-5',
      },
      {
        iconOnly: false,
        className: 'py-2.5',
      },
    ],
    defaultVariants: {
      variant: 'primary',
      appearance: 'fill',
      iconOnly: false,
      size: 'md',
    },
  },
);

export interface ButtonProps
  extends Omit<AriaButtonProps, 'isDisabled' | 'isPending'>, VariantProps<typeof buttonStyles> {
  disabled?: boolean;
  pending?: boolean;
}

export function Button({
  variant,
  appearance,
  iconOnly,
  size,
  children,
  className,
  disabled,
  pending,
  ...props
}: ButtonProps) {
  return (
    <AriaButton
      className={cn(
        buttonStyles({
          variant,
          appearance,
          iconOnly,
          size,
        }),
        className,
      )}
      isDisabled={disabled}
      isPending={pending}
      {...props}
    >
      {children}
    </AriaButton>
  );
}
